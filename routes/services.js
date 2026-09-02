const express = require('express');
const sql = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const SERVICE_CONFIGS = {
  gmail: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  },
  notion: {
    authUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    scopes: [],
    clientId: process.env.NOTION_CLIENT_ID,
    clientSecret: process.env.NOTION_CLIENT_SECRET,
  },
  slack: {
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: ['channels:read', 'chat:write', 'files:read', 'users:read'],
    clientId: process.env.SLACK_CLIENT_ID,
    clientSecret: process.env.SLACK_CLIENT_SECRET,
  },
  trello: {
    authUrl: 'https://trello.com/1/authorize',
    tokenUrl: 'https://trello.com/1/oauth/token',
    scopes: ['read', 'write'],
    clientId: process.env.TRELLO_CLIENT_ID,
    clientSecret: process.env.TRELLO_CLIENT_SECRET,
  },
  outlook: {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['Mail.Read', 'Mail.Send', 'Calendars.Read', 'offline_access'],
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
  },
};

// Generate OAuth URL for a service
router.get('/:service/authorize', auth, (req, res) => {
  const { service } = req.params;
  const config = SERVICE_CONFIGS[service];
  if (!config) return res.status(400).json({ error: 'Service inconnu' });
  if (!config.clientId) return res.status(500).json({ error: `OAuth non configuré pour ${service}` });

  const state = JSON.stringify({ userId: req.userId, service });

  if (service === 'gmail') {
    const url = `${config.authUrl}?client_id=${config.clientId}&redirect_uri=${encodeURIComponent(FRONTEND_URL + '/auth/callback/' + service)}&response_type=code&scope=${encodeURIComponent(config.scopes.join(' '))}&state=${encodeURIComponent(state)}&access_type=offline&prompt=consent`;
    return res.json({ url });
  }

  if (service === 'notion') {
    const url = `${config.authUrl}?client_id=${config.clientId}&redirect_uri=${encodeURIComponent(FRONTEND_URL + '/auth/callback/' + service)}&response_type=code&state=${encodeURIComponent(state)}`;
    return res.json({ url });
  }

  if (service === 'slack') {
    const url = `${config.authUrl}?client_id=${config.clientId}&redirect_uri=${encodeURIComponent(FRONTEND_URL + '/auth/callback/' + service)}&scope=${encodeURIComponent(config.scopes.join(' '))}&state=${encodeURIComponent(state)}`;
    return res.json({ url });
  }

  if (service === 'trello') {
    const url = `${config.authUrl}?name=Command+Center&scope=${config.scopes[0]}&expiration=never&response_type=token&key=${config.clientId}&callback_method=fragment`;
    return res.json({ url });
  }

  if (service === 'outlook') {
    const url = `${config.authUrl}?client_id=${config.clientId}&redirect_uri=${encodeURIComponent(FRONTEND_URL + '/auth/callback/' + service)}&response_type=code&scope=${encodeURIComponent(config.scopes.join(' '))}&state=${encodeURIComponent(state)}&response_mode=query`;
    return res.json({ url });
  }

  res.status(400).json({ error: 'Service non supporté' });
});

// Handle OAuth callback - exchange code for token
router.post('/:service/callback', auth, async (req, res) => {
  const { service } = req.params;
  const { code, state } = req.body;
  const config = SERVICE_CONFIGS[service];
  if (!config) return res.status(400).json({ error: 'Service inconnu' });

  try {
    let tokenData;

    if (service === 'gmail') {
      const response = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: FRONTEND_URL + '/auth/callback/' + service,
          grant_type: 'authorization_code',
        }),
      });
      tokenData = await response.json();
      if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);
    }

    if (service === 'notion') {
      const creds = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
      const response = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${creds}` },
        body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: FRONTEND_URL + '/auth/callback/' + service }),
      });
      tokenData = await response.json();
      if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);
    }

    if (service === 'slack') {
      const response = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: FRONTEND_URL + '/auth/callback/' + service,
        }),
      });
      tokenData = await response.json();
      if (!tokenData.ok) throw new Error(tokenData.error);
    }

    if (service === 'outlook') {
      const response = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: FRONTEND_URL + '/auth/callback/' + service,
          grant_type: 'authorization_code',
          scope: config.scopes.join(' '),
        }),
      });
      tokenData = await response.json();
      if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);
    }

    // Store or update the token
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || null;
    const expiresAt = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null;

    await sql`
      INSERT INTO connected_services (user_id, service_name, access_token, refresh_token, token_expires_at)
      VALUES (${req.userId}, ${service}, ${accessToken}, ${refreshToken}, ${expiresAt})
      ON CONFLICT (user_id, service_name)
      DO UPDATE SET access_token = ${accessToken}, refresh_token = COALESCE(${refreshToken}, connected_services.refresh_token), token_expires_at = ${expiresAt}, created_at = NOW()
    `;

    res.json({ success: true, service });
  } catch (err) {
    console.error(`${service} callback error:`, err);
    res.status(500).json({ error: err.message || 'Erreur lors de la connexion' });
  }
});

// Get connected services status
router.get('/', auth, async (req, res) => {
  try {
    const result = await sql`SELECT service_name, created_at FROM connected_services WHERE user_id = ${req.userId}`;
    const connected = result.map(r => r.service_name);
    res.json({ services: connected });
  } catch (err) {
    console.error('Services list error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Disconnect a service
router.delete('/:service', auth, async (req, res) => {
  try {
    await sql`DELETE FROM connected_services WHERE user_id = ${req.userId} AND service_name = ${req.params.service}`;
    res.json({ success: true });
  } catch (err) {
    console.error('Disconnect error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Fetch emails from Gmail
router.get('/gmail/emails', auth, async (req, res) => {
  try {
    const result = await sql`SELECT access_token, token_expires_at FROM connected_services WHERE user_id = ${req.userId} AND service_name = 'gmail'`;
    if (result.length === 0) return res.status(400).json({ error: 'Gmail non connecté' });

    const { access_token: token } = result[0];
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const emails = [];
    for (const msg of (data.messages || []).slice(0, 10)) {
      const msgResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const msgData = await msgResp.json();
      const headers = msgData.payload?.headers || [];
      const subject = headers.find(h => h.name === 'Subject')?.value || '(sans objet)';
      const from = headers.find(h => h.name === 'From')?.value || '';
      const date = headers.find(h => h.name === 'Date')?.value || '';
      const isUnread = msgData.labelIds?.includes('UNREAD');

      emails.push({
        id: msg.id,
        subject,
        sender: from.split('<')[0].trim(),
        senderEmail: from,
        date,
        time: date,
        preview: msgData.snippet || '',
        priority: isUnread ? 'high' : 'low',
        unread: isUnread,
        service: 'gmail',
      });
    }
    res.json({ emails });
  } catch (err) {
    console.error('Gmail fetch error:', err);
    res.status(500).json({ error: err.message || 'Erreur lors de la récupération des emails' });
  }
});

module.exports = router;