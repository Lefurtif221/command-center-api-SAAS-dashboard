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

// Auto-refresh Gmail token if expired
async function refreshGmailToken(userId, refreshToken) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error_description || data.error);

  const newToken = data.access_token;
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  await sql`
    UPDATE connected_services SET access_token = ${newToken}, token_expires_at = ${expiresAt}
    WHERE user_id = ${userId} AND service_name = 'gmail'
  `;
  return newToken;
}

// Fetch emails from Gmail
router.get('/gmail/emails', auth, async (req, res) => {
  try {
    const result = await sql`SELECT access_token, refresh_token, token_expires_at FROM connected_services WHERE user_id = ${req.userId} AND service_name = 'gmail'`;
    if (result.length === 0) return res.status(400).json({ error: 'Gmail non connecté' });

    let { access_token: token, refresh_token: refreshToken, token_expires_at: expiresAt } = result[0];

    // Auto-refresh if expired or about to expire (within 5 min)
    const now = new Date()
    const expiresAtDate = expiresAt ? new Date(expiresAt) : null
    if (expiresAtDate && expiresAtDate.getTime() - now.getTime() < 5 * 60 * 1000 && refreshToken) {
      try {
        token = await refreshGmailToken(req.userId, refreshToken);
      } catch (refreshErr) {
        console.error('Token refresh failed:', refreshErr.message);
        return res.status(401).json({ error: 'Session Gmail expirée. Reconnectez Gmail.', reconnect: true });
      }
    }

    // Fetch user rules
    const rules = await sql`SELECT sender, keyword, priority FROM email_rules WHERE user_id = ${req.userId}`;
    const senderRules = {};
    const keywordRules = [];
    for (const r of rules) {
      if (r.sender) senderRules[r.sender.toLowerCase()] = r.priority;
      if (r.keyword) keywordRules.push({ keyword: r.keyword.toLowerCase(), priority: r.priority });
    }

    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();

    // If 401, try refresh once
    if (data.error && data.error.code === 401 && refreshToken) {
      try {
        token = await refreshGmailToken(req.userId, refreshToken);
        const retry = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const retryData = await retry.json();
        if (retryData.error) throw new Error(retryData.error.message);
        Object.assign(data, retryData);
      } catch {
        return res.status(401).json({ error: 'Session Gmail expirée. Reconnectez Gmail.', reconnect: true });
      }
    } else if (data.error) {
      throw new Error(data.error.message);
    }

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

      // Extract sender email for rule matching
      const emailMatch = from.match(/<(.+?)>/);
      const senderEmail = emailMatch ? emailMatch[1] : from;
      const senderName = from.split('<')[0].trim();

      // Apply rules: check sender, then domain, then keywords
      let priority = isUnread ? 'high' : 'low';
      if (senderRules[senderEmail.toLowerCase()]) {
        priority = senderRules[senderEmail.toLowerCase()];
      } else {
        const domain = senderEmail.split('@')[1];
        if (senderRules['@' + domain]) {
          priority = senderRules['@' + domain];
        }
      }
      // Check keywords in subject + preview
      const textToCheck = (subject + ' ' + (msgData.snippet || '')).toLowerCase();
      for (const kr of keywordRules) {
        if (textToCheck.includes(kr.keyword)) {
          priority = kr.priority;
          break;
        }
      }

      emails.push({
        id: msg.id,
        subject,
        sender: senderName,
        senderEmail,
        date,
        time: date,
        preview: msgData.snippet || '',
        priority,
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

// Fetch full email body by message ID
router.get('/gmail/emails/:messageId', auth, async (req, res) => {
  try {
    const result = await sql`SELECT access_token, refresh_token, token_expires_at FROM connected_services WHERE user_id = ${req.userId} AND service_name = 'gmail'`;
    if (result.length === 0) return res.status(400).json({ error: 'Gmail non connecté' });

    let { access_token: token, refresh_token: refreshToken, token_expires_at: expiresAt } = result[0];
    if (expiresAt && new Date(expiresAt) < new Date() && refreshToken) {
      token = await refreshGmailToken(req.userId, refreshToken);
    }

    const msgResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${req.params.messageId}?format=full`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const msgData = await msgResp.json();
    if (msgData.error) throw new Error(msgData.error.message);

    function decodeBody(part) {
      if (part.body && part.body.data) return Buffer.from(part.body.data, 'base64url').toString('utf-8')
      if (part.parts) {
        for (const p of part.parts) {
          if (p.mimeType === 'text/plain' && p.body && p.body.data) return Buffer.from(p.body.data, 'base64url').toString('utf-8')
          const nested = decodeBody(p)
          if (nested) return nested
        }
        for (const p of part.parts) {
          if (p.mimeType === 'text/html' && p.body && p.body.data) return Buffer.from(p.body.data, 'base64url').toString('utf-8')
        }
      }
      return ''
    }

    const body = decodeBody(msgData.payload)
    res.json({ body })
  } catch (err) {
    console.error('Gmail full email error:', err);
    res.status(500).json({ error: err.message || 'Erreur lors de la récupération' });
  }
});

// Summarize an email
function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function summarizeEmail(text, subject) {
  if (!text) return 'Pas de contenu disponible.';

  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const summary = [];

  // Extract dates
  const dateRegex = /\b(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{1,2}\s+(?:janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\s+\d{4})\b/gi;
  const dates = text.match(dateRegex) || [];

  // Extract action keywords
  const actionRegex = /\b(?:merci de|veuillez|svp|s'il vous plaît|à faire|action requise|répondre|confirmer|valider|payer|signer|deadline|échéance)\b/gi;
  const actions = text.match(actionRegex) || [];

  // Extract numbers that look like amounts
  const amountRegex = /\b\d+[\.,]\d{2}\s*(?:€|\$|EUR|USD|£)?\b/g;
  const amounts = text.match(amountRegex) || [];

  // Take first meaningful lines (skip greetings, signatures)
  const skipPatterns = /^(?:bonjour|salut|hello|hi|dear|cher|madame|monsieur|merci|cordialement|best|regards|à bientôt|signature|unsubscribe|se désinscrire)/i;
  const signaturePatterns = /(?:__|--|sent from|envoyé depuis|gmail|yahoo|outlook)/i;

  let bodyLines = lines.filter(l => l.length > 15 && !skipPatterns.test(l) && !signaturePatterns.test(l));

  // First 2-3 sentences are usually the key content
  const keySentences = bodyLines.slice(0, 3);
  if (keySentences.length > 0) {
    summary.push(keySentences.join(' '));
  }

  // Add dates if found
  if (dates.length > 0) {
    summary.push('Dates mentionnées : ' + [...new Set(dates)].join(', '));
  }

  // Add amounts if found
  if (amounts.length > 0) {
    summary.push('Montants : ' + [...new Set(amounts)].join(', '));
  }

  // Add action items
  if (actions.length > 0) {
    summary.push('Action requise : ' + actions.slice(0, 3).join(', '));
  }

  const result = summary.join('\n\n');
  return result.length > 10 ? result : (keySentences[0] || text.slice(0, 300) + '...');
}

router.get('/gmail/emails/:messageId/summary', auth, async (req, res) => {
  try {
    const result = await sql`SELECT access_token, refresh_token, token_expires_at FROM connected_services WHERE user_id = ${req.userId} AND service_name = 'gmail'`;
    if (result.length === 0) return res.status(400).json({ error: 'Gmail non connecté' });

    let { access_token: token, refresh_token: refreshToken, token_expires_at: expiresAt } = result[0];
    if (expiresAt && new Date(expiresAt) < new Date() && refreshToken) {
      token = await refreshGmailToken(req.userId, refreshToken);
    }

    const msgResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${req.params.messageId}?format=full`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const msgData = await msgResp.json();
    if (msgData.error) throw new Error(msgData.error.message);

    function decodeBody(part) {
      if (part.body && part.body.data) return Buffer.from(part.body.data, 'base64url').toString('utf-8')
      if (part.parts) {
        for (const p of part.parts) {
          if (p.mimeType === 'text/plain' && p.body && p.body.data) return Buffer.from(p.body.data, 'base64url').toString('utf-8')
          const nested = decodeBody(p)
          if (nested) return nested
        }
        for (const p of part.parts) {
          if (p.mimeType === 'text/html' && p.body && p.body.data) return Buffer.from(p.body.data, 'base64url').toString('utf-8')
        }
      }
      return ''
    }

    const rawBody = decodeBody(msgData.payload)
    const cleanBody = stripHtml(rawBody)
    const headers = msgData.payload?.headers || [];
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const summary = summarizeEmail(cleanBody, subject)

    res.json({ summary, body: cleanBody })
  } catch (err) {
    console.error('Gmail summary error:', err);
    res.status(500).json({ error: err.message || 'Erreur lors du résumé' });
  }
});

// Reply to an email via Gmail
router.post('/gmail/reply', auth, async (req, res) => {
  try {
    const { to, subject, body, threadId } = req.body;
    if (!to || !subject || !body) return res.status(400).json({ error: 'Destinataire, sujet et message requis' });

    const result = await sql`SELECT access_token, refresh_token, token_expires_at FROM connected_services WHERE user_id = ${req.userId} AND service_name = 'gmail'`;
    if (result.length === 0) return res.status(400).json({ error: 'Gmail non connecté' });

    let { access_token: token, refresh_token: refreshToken, token_expires_at: expiresAt } = result[0];
    if (expiresAt && new Date(expiresAt) < new Date() && refreshToken) {
      token = await refreshGmailToken(req.userId, refreshToken);
    }

    // Build raw email
    const emailParts = [
      `To: ${to}`,
      `Subject: Re: ${subject.replace(/^Re:\s*/i, '')}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body,
    ];
    if (threadId) emailParts.splice(2, 0, `In-Reply-To: ${threadId}`);
    const rawEmail = Buffer.from(emailParts.join('\r\n')).toString('base64url');

    const gmailRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: rawEmail }),
    });
    const gmailData = await gmailRes.json();
    if (gmailData.error) throw new Error(gmailData.error.message);

    res.json({ success: true, messageId: gmailData.id });
  } catch (err) {
    console.error('Gmail reply error:', err);
    res.status(500).json({ error: err.message || "Erreur lors de l'envoi" });
  }
});

// Get user email rules
router.get('/email-rules', auth, async (req, res) => {
  try {
    const rules = await sql`SELECT id, sender, keyword, priority, created_at FROM email_rules WHERE user_id = ${req.userId} ORDER BY created_at DESC`;
    res.json({ rules });
  } catch (err) {
    console.error('Get rules error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Add or update email rule (sender or keyword)
router.post('/email-rules', auth, async (req, res) => {
  try {
    const { sender, keyword, priority } = req.body;
    if (!priority) return res.status(400).json({ error: 'Priorité requise' });
    if (!['high', 'low'].includes(priority)) return res.status(400).json({ error: 'Priorité invalide' });

    if (keyword) {
      await sql`DELETE FROM email_rules WHERE user_id = ${req.userId} AND keyword = ${keyword.toLowerCase()}`;
      await sql`INSERT INTO email_rules (user_id, keyword, priority) VALUES (${req.userId}, ${keyword.toLowerCase()}, ${priority})`;
    } else if (sender) {
      await sql`DELETE FROM email_rules WHERE user_id = ${req.userId} AND sender = ${sender.toLowerCase()}`;
      await sql`INSERT INTO email_rules (user_id, sender, priority) VALUES (${req.userId}, ${sender.toLowerCase()}, ${priority})`;
    } else {
      return res.status(400).json({ error: 'Sender ou keyword requis' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Add rule error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Delete email rule
router.delete('/email-rules/:id', auth, async (req, res) => {
  try {
    await sql`DELETE FROM email_rules WHERE id = ${req.params.id} AND user_id = ${req.userId}`;
    res.json({ success: true });
  } catch (err) {
    console.error('Delete rule error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ========== WHATSAPP ==========

const WHATSAPP_API = 'https://graph.facebook.com/v21.0';

// Get WhatsApp config status
router.get('/whatsapp/config', auth, async (req, res) => {
  try {
    const result = await sql`SELECT access_token, service_name FROM connected_services WHERE user_id = ${req.userId} AND service_name = 'whatsapp'`;
    if (result.length === 0) return res.json({ connected: false });
    res.json({
      connected: true,
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || null,
    });
  } catch (err) {
    console.error('WhatsApp config error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Connect WhatsApp (store token)
router.post('/whatsapp/connect', auth, async (req, res) => {
  try {
    const { accessToken, phoneNumberId } = req.body;
    if (!accessToken) return res.status(400).json({ error: 'Token requis' });

    // Verify the token works
    const verifyRes = await fetch(`${WHATSAPP_API}/${phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const verifyData = await verifyRes.json();
    if (verifyData.error) return res.status(400).json({ error: 'Token invalide' });

    await sql`
      INSERT INTO connected_services (user_id, service_name, access_token)
      VALUES (${req.userId}, 'whatsapp', ${accessToken})
      ON CONFLICT (user_id, service_name)
      DO UPDATE SET access_token = ${accessToken}, created_at = NOW()
    `;

    res.json({ success: true, phoneNumberId: phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID });
  } catch (err) {
    console.error('WhatsApp connect error:', err);
    res.status(500).json({ error: err.message || 'Erreur de connexion' });
  }
});

// Disconnect WhatsApp
router.delete('/whatsapp', auth, async (req, res) => {
  try {
    await sql`DELETE FROM connected_services WHERE user_id = ${req.userId} AND service_name = 'whatsapp'`;
    res.json({ success: true });
  } catch (err) {
    console.error('WhatsApp disconnect error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Send WhatsApp message
router.post('/whatsapp/send', auth, async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Destinataire et message requis' });

    const result = await sql`SELECT access_token FROM connected_services WHERE user_id = ${req.userId} AND service_name = 'whatsapp'`;
    const token = result.length > 0 ? result[0].access_token : process.env.WHATSAPP_ACCESS_TOKEN;
    if (!token) return res.status(400).json({ error: 'WhatsApp non configuré' });

    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    const waRes = await fetch(`${WHATSAPP_API}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to.replace(/\D/g, ''),
        type: 'text',
        text: { body: message },
      }),
    });
    const waData = await waRes.json();
    if (waData.error) throw new Error(waData.error.message);

    res.json({ success: true, messageId: waData.messages?.[0]?.id });
  } catch (err) {
    console.error('WhatsApp send error:', err);
    res.status(500).json({ error: err.message || "Erreur lors de l'envoi" });
  }
});

// Get WhatsApp conversations (messages from a number)
router.get('/whatsapp/messages', auth, async (req, res) => {
  try {
    const result = await sql`SELECT access_token FROM connected_services WHERE user_id = ${req.userId} AND service_name = 'whatsapp'`;
    const token = result.length > 0 ? result[0].access_token : process.env.WHATSAPP_ACCESS_TOKEN;
    if (!token) return res.status(400).json({ error: 'WhatsApp non configuré' });

    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    // Get recent conversations
    const waRes = await fetch(`${WHATSAPP_API}/${phoneNumberId}/conversations?fields=wa_id,name,last_message,unread_count&limit=20`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const waData = await waRes.json();
    if (waData.error) throw new Error(waData.error.message);

    res.json({ conversations: waData.data || [] });
  } catch (err) {
    console.error('WhatsApp messages error:', err);
    res.status(500).json({ error: err.message || 'Erreur lors de la récupération' });
  }
});

// Webhook for receiving WhatsApp messages
router.get('/whatsapp/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('WhatsApp webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

router.post('/whatsapp/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    if (changes?.field === 'messages') {
      const messages = changes.value?.messages || [];
      const contacts = changes.value?.contacts || [];

      for (const msg of messages) {
        console.log(`WhatsApp message from ${msg.from}: ${msg.text?.body || '[media]'}`);
        // TODO: store in DB, notify connected users
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('WhatsApp webhook error:', err);
    res.sendStatus(200);
  }
});

module.exports = router;