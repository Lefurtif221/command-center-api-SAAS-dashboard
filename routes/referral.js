const express = require('express');
const sql = require('../db');
const { auth } = require('../middleware/auth');
const { sanitizeSource } = require('../lib/signup-source');

const router = express.Router();

// Sans O/0, I/1 pour eviter les confusions a l'ecriture
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genCode() {
  let out = '';
  for (let i = 0; i < 6; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

// Mon lien de parrainage (le code est cree au premier appel)
router.get('/', auth, async (req, res) => {
  try {
    const rows = await sql`SELECT referral_code FROM users WHERE id = ${req.userId}`;
    let code = rows[0] && rows[0].referral_code;
    if (!code) {
      for (let attempt = 0; attempt < 6 && !code; attempt++) {
        const candidate = genCode();
        try {
          const upd = await sql`
            UPDATE users SET referral_code = ${candidate}
            WHERE id = ${req.userId} AND referral_code IS NULL
            RETURNING referral_code
          `;
          if (upd.length > 0) code = upd[0].referral_code;
        } catch (e) {
          if (!/duplicate|uniq/i.test(e.message || '')) throw e;
          // collision sur l index unique : on re-essaie
        }
      }
    }
    if (!code) return res.status(500).json({ error: 'Genereration du code impossible' });
    res.json({ code });
  } catch (err) {
    console.error('Referral GET error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Mon lien complet pour le partage : le front construit l'URL avec son propre domaine
// Enregistre qui m'a invite (nouveaux comptes seulement, une seule fois)
router.post('/attach', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const ref = String(body.ref || '').trim().toUpperCase();

    // Source d'inscription (UTM/referrer) : memoire unique, on ne ecrase jamais
    const source = sanitizeSource(body.source);
    if (source) {
      await sql`
        UPDATE users SET signup_source = COALESCE(signup_source, ${source}::jsonb)
        WHERE id = ${req.userId}
      `;
    }

    if (!ref || ref.length > 20) return res.json({ attached: false });

    const me = await sql`SELECT id, referral_code, referred_by, created_at FROM users WHERE id = ${req.userId}`;
    const user = me[0];
    if (!user || user.referred_by) return res.json({ attached: false });

    // Seuls les comptes recents (48h) peuvent etre rattaches a un parrain
    const age = Date.now() - new Date(user.created_at).getTime();
    if (age > 48 * 3600 * 1000) return res.json({ attached: false });

    if (user.referral_code && ref === user.referral_code) return res.json({ attached: false });

    const referrers = await sql`SELECT id FROM users WHERE referral_code = ${ref}`;
    if (referrers.length === 0 || referrers[0].id === req.userId) return res.json({ attached: false });

    await sql`UPDATE users SET referred_by = ${referrers[0].id} WHERE id = ${req.userId} AND referred_by IS NULL`;
    await sql`
      INSERT INTO referrals (referrer_id, referred_id)
      VALUES (${referrers[0].id}, ${req.userId})
      ON CONFLICT (referred_id) DO NOTHING
    `;
    res.json({ attached: true });
  } catch (err) {
    console.error('Referral attach error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
