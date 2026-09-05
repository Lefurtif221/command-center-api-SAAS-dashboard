const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sql = require('../db');
const { auth, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Verify Google ID token
async function verifyGoogleToken(idToken) {
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
  if (!response.ok) throw new Error('Token Google invalide');
  const payload = await response.json();
  const expectedClientId = process.env.GOOGLE_CLIENT_ID;
  if (expectedClientId && payload.aud !== expectedClientId) {
    throw new Error('Client ID Google invalide');
  }
  return payload;
}

// Signup
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });
    }

    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });
    }

    const hash = await bcrypt.hash(password, 12);
    const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

    const result = await sql`
      INSERT INTO users (name, email, password_hash, initials)
      VALUES (${name}, ${email}, ${hash}, ${initials})
      RETURNING id, name, email, initials, plan, created_at
    `;

    const user = result[0];
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({ token, user });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    const result = await sql`SELECT id, name, email, password_hash, initials, plan FROM users WHERE email = ${email}`;
    if (result.length === 0) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const user = result[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user: { id: user.id, name: user.name, email: user.email, initials: user.initials, plan: user.plan } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Google OAuth - verify ID token from Google Identity Services
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: 'Credential Google manquant' });
    }

    const googleUser = await verifyGoogleToken(credential);
    const { sub: googleId, email, name, picture } = googleUser;

    // Check if user exists with this Google ID
    let result = await sql`
      SELECT id, name, email, initials, plan, avatar_url FROM users 
      WHERE oauth_provider = 'google' AND oauth_id = ${googleId}
    `;

    if (result.length === 0) {
      // Check if user exists with same email
      const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
      
      if (existing.length > 0) {
        // Link Google to existing account
        result = await sql`
          UPDATE users SET oauth_provider = 'google', oauth_id = ${googleId}, avatar_url = ${picture}, updated_at = NOW()
          WHERE email = ${email}
          RETURNING id, name, email, initials, plan, avatar_url
        `;
      } else {
        // Create new user
        const initials = name ? name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) : email[0].toUpperCase();
        result = await sql`
          INSERT INTO users (name, email, oauth_provider, oauth_id, initials, avatar_url)
          VALUES (${name || email.split('@')[0]}, ${email}, 'google', ${googleId}, ${initials}, ${picture})
          RETURNING id, name, email, initials, plan, avatar_url
        `;
      }
    }

    const user = result[0];
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user });
  } catch (err) {
    console.error('Google OAuth error:', err);
    res.status(500).json({ error: 'Authentification Google échouée' });
  }
});

// Get current user
router.get('/me', auth, async (req, res) => {
  try {
    const result = await sql`SELECT id, name, email, initials, plan, avatar_url, created_at FROM users WHERE id = ${req.userId}`;
    if (result.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }
    res.json({ user: result[0] });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Update profile
router.put('/profile', auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Nom requis' });
    }
    const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

    const result = await sql`
      UPDATE users SET name = ${name}, initials = ${initials}, updated_at = NOW()
      WHERE id = ${req.userId}
      RETURNING id, name, email, initials, plan
    `;
    res.json({ user: result[0] });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Google OAuth - redirect to Google
router.get('/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'Google OAuth non configuré' });
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(FRONTEND_URL + '/auth/callback/google')}&response_type=code&scope=${encodeURIComponent('email profile')}&access_type=offline&prompt=consent`;
  res.redirect(url);
});

// Google OAuth - callback
router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.redirect(FRONTEND_URL + '/auth?error=' + encodeURIComponent(error || 'Code manquant'));
  }

  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('Google OAuth non configuré');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: FRONTEND_URL + '/auth/callback/google',
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const googleUser = await userinfoRes.json();
    const { email, name, picture, id: googleId } = googleUser;

    let result = await sql`
      SELECT id, name, email, initials, plan, avatar_url FROM users
      WHERE oauth_provider = 'google' AND oauth_id = ${googleId}
    `;

    if (result.length === 0) {
      const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
      if (existing.length > 0) {
        result = await sql`
          UPDATE users SET oauth_provider = 'google', oauth_id = ${googleId}, avatar_url = ${picture}, updated_at = NOW()
          WHERE email = ${email}
          RETURNING id, name, email, initials, plan, avatar_url
        `;
      } else {
        const initials = name ? name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) : email[0].toUpperCase();
        result = await sql`
          INSERT INTO users (name, email, oauth_provider, oauth_id, initials, avatar_url)
          VALUES (${name || email.split('@')[0]}, ${email}, 'google', ${googleId}, ${initials}, ${picture})
          RETURNING id, name, email, initials, plan, avatar_url
        `;
      }
    }

    const user = result[0];
    const appToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

    res.redirect(FRONTEND_URL + '/auth?token=' + appToken + '&user=' + encodeURIComponent(JSON.stringify(user)));
  } catch (err) {
    console.error('Google callback error:', err);
    res.redirect(FRONTEND_URL + '/auth?error=' + encodeURIComponent(err.message));
  }
});

module.exports = router;