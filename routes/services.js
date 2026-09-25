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

// --- Helpers multi-comptes Gmail ---

// All Gmail accounts of a user (one row per Gmail address)
async function getGmailAccounts(userId) {
  return await sql`
    SELECT id, user_id, account_key, account_email, access_token, refresh_token, token_expires_at
    FROM connected_services
    WHERE user_id = ${userId} AND service_name = 'gmail'
    ORDER BY created_at ASC
  `;
}

// Return a valid access token for a stored account row (refreshes if needed)
async function gmailTokenFor(account) {
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (expiresAt && expiresAt - Date.now() < 5 * 60 * 1000 && account.refresh_token) {
    return await refreshGmailToken(account.user_id, account.refresh_token, account.account_key);
  }
  return account.access_token;
}

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

    // Gmail: identity of the account = the Gmail address, so the same mailbox
    // always maps to the same row and several mailboxes can coexist.
    let gmailEmail = null;
    if (service === 'gmail') {
      try {
        const profileResp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const profile = await profileResp.json();
        gmailEmail = profile.emailAddress || null;
      } catch (profileErr) {
        console.error('Gmail profile error:', profileErr.message);
      }
    }

    if (service === 'gmail' && gmailEmail) {
      const byEmail = await sql`
        SELECT id FROM connected_services
        WHERE user_id = ${req.userId} AND service_name = 'gmail' AND account_email = ${gmailEmail}
      `;
      let targetId = byEmail[0]?.id;
      if (!targetId) {
        // Claim the legacy single-account row (created before multi-mail)
        const legacy = await sql`
          SELECT id FROM connected_services
          WHERE user_id = ${req.userId} AND service_name = 'gmail' AND account_key = 'default'
        `;
        targetId = legacy[0]?.id;
      }

      if (targetId) {
        await sql`
          UPDATE connected_services
          SET access_token = ${accessToken},
              refresh_token = COALESCE(${refreshToken}, refresh_token),
              token_expires_at = ${expiresAt},
              account_key = ${gmailEmail},
              account_email = ${gmailEmail},
              created_at = NOW()
          WHERE id = ${targetId}
        `;
      } else {
        await sql`
          INSERT INTO connected_services (user_id, service_name, access_token, refresh_token, token_expires_at, account_key, account_email)
          VALUES (${req.userId}, 'gmail', ${accessToken}, ${refreshToken}, ${expiresAt}, ${gmailEmail}, ${gmailEmail})
        `;
      }
    } else {
      await sql`
        INSERT INTO connected_services (user_id, service_name, access_token, refresh_token, token_expires_at, account_key)
        VALUES (${req.userId}, ${service}, ${accessToken}, ${refreshToken}, ${expiresAt}, 'default')
        ON CONFLICT (user_id, service_name, account_key)
        DO UPDATE SET access_token = ${accessToken}, refresh_token = COALESCE(${refreshToken}, connected_services.refresh_token), token_expires_at = ${expiresAt}, created_at = NOW()
      `;
    }

    res.json({ success: true, service, account: gmailEmail });
  } catch (err) {
    console.error(`${service} callback error:`, err);
    res.status(500).json({ error: err.message || 'Erreur lors de la connexion' });
  }
});

// Get connected services status
router.get('/', auth, async (req, res) => {
  try {
    const result = await sql`SELECT service_name, account_key, account_email, created_at FROM connected_services WHERE user_id = ${req.userId}`;
    const services = [...new Set(result.map(r => r.service_name))];
    const gmailAccounts = result
      .filter(r => r.service_name === 'gmail')
      .map(r => ({ account_key: r.account_key, email: r.account_email || r.account_key, created_at: r.created_at }));
    res.json({ services, gmailAccounts });
  } catch (err) {
    console.error('Services list error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Disconnect a service (optionally a single Gmail account via ?account_key=)
router.delete('/:service', auth, async (req, res) => {
  try {
    const { service } = req.params;
    const accountKey = req.query.account_key;
    if (accountKey && service === 'whatsapp') return res.status(400).json({ error: 'Operation non supportée' });
    if (accountKey) {
      await sql`DELETE FROM connected_services WHERE user_id = ${req.userId} AND service_name = ${service} AND account_key = ${accountKey}`;
    } else {
      await sql`DELETE FROM connected_services WHERE user_id = ${req.userId} AND service_name = ${service}`;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Disconnect error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Auto-refresh Gmail token if expired
async function refreshGmailToken(userId, refreshToken, accountKey = 'default') {
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
    WHERE user_id = ${userId} AND service_name = 'gmail' AND account_key = ${accountKey}
  `;
  return newToken;
}

// Fetch emails from Gmail (merged across all connected accounts)
router.get('/gmail/emails', auth, async (req, res) => {
  try {
    const accounts = await getGmailAccounts(req.userId);
    if (accounts.length === 0) return res.status(400).json({ error: 'Gmail non connecté' });

    // Fetch user rules
    const rules = await sql`SELECT sender, keyword, priority FROM email_rules WHERE user_id = ${req.userId}`;
    const senderRules = {};
    const keywordRules = [];
    for (const r of rules) {
      if (r.sender) senderRules[r.sender.toLowerCase()] = r.priority;
      if (r.keyword) keywordRules.push({ keyword: r.keyword.toLowerCase(), priority: r.priority });
    }

    const emails = [];
    const failedAccounts = [];

    for (const account of accounts) {
      const accountEmail = account.account_email || account.account_key;
      let token;
      try {
        token = await gmailTokenFor(account);
      } catch (refreshErr) {
        console.error('Token refresh failed:', refreshErr.message);
        failedAccounts.push(accountEmail);
        continue;
      }

      const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();

      // If 401, try refresh once
      if (data.error && data.error.code === 401 && account.refresh_token) {
        try {
          token = await refreshGmailToken(req.userId, account.refresh_token, account.account_key);
          const retry = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20', {
            headers: { Authorization: `Bearer ${token}` },
          });
          const retryData = await retry.json();
          if (retryData.error) throw new Error(retryData.error.message);
          Object.assign(data, retryData);
        } catch {
          failedAccounts.push(accountEmail);
          continue;
        }
      } else if (data.error) {
        failedAccounts.push(accountEmail);
        continue;
      }

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
        accountKey: account.account_key,
        accountEmail,
      });
    }
    } // for (accounts)

    if (emails.length === 0 && failedAccounts.length === accounts.length) {
      return res.status(401).json({ error: 'Session Gmail expirée. Reconnectez Gmail.', reconnect: true });
    }

    emails.sort((a, b) => (new Date(b.date).getTime() || 0) - (new Date(a.date).getTime() || 0));
    res.json({ emails, failedAccounts });
  } catch (err) {
    console.error('Gmail fetch error:', err);
    res.status(500).json({ error: err.message || 'Erreur lors de la récupération des emails' });
  }
});

// Fetch full email body by message ID
router.get('/gmail/emails/:messageId', auth, async (req, res) => {
  try {
    const accounts = await getGmailAccounts(req.userId);
    if (accounts.length === 0) return res.status(400).json({ error: 'Gmail non connecté' });

    const requested = req.query.account_key;
    const candidates = requested ? accounts.filter(a => a.account_key === requested) : accounts;
    if (candidates.length === 0) return res.status(400).json({ error: 'Compte Gmail introuvable' });

    let msgData = null;
    let accountUsed = null;
    for (const account of candidates) {
      try {
        const token = await gmailTokenFor(account);
        const msgResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${req.params.messageId}?format=full`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await msgResp.json();
        if (!data.error) { msgData = data; accountUsed = account; break; }
      } catch (accErr) {
        console.error('Gmail detail error:', accErr.message);
      }
    }
    if (!msgData) throw new Error('Email introuvable sur les comptes connectes');

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
    res.json({ body, accountKey: accountUsed.account_key })
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
    const accounts = await getGmailAccounts(req.userId);
    if (accounts.length === 0) return res.status(400).json({ error: 'Gmail non connecté' });

    const requested = req.query.account_key;
    const candidates = requested ? accounts.filter(a => a.account_key === requested) : accounts;
    if (candidates.length === 0) return res.status(400).json({ error: 'Compte Gmail introuvable' });

    let msgData = null;
    for (const account of candidates) {
      try {
        const token = await gmailTokenFor(account);
        const msgResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${req.params.messageId}?format=full`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await msgResp.json();
        if (!data.error) { msgData = data; break; }
      } catch (accErr) {
        console.error('Gmail summary account error:', accErr.message);
      }
    }
    if (!msgData) throw new Error('Email introuvable sur les comptes connectes');

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
    const { to, subject, body, threadId, account_key } = req.body;
    if (!to || !subject || !body) return res.status(400).json({ error: 'Destinataire, sujet et message requis' });

    const accounts = await getGmailAccounts(req.userId);
    if (accounts.length === 0) return res.status(400).json({ error: 'Gmail non connecté' });

    let account;
    if (account_key) {
      account = accounts.find(a => a.account_key === account_key);
      if (!account) return res.status(400).json({ error: 'Compte Gmail introuvable' });
    } else if (accounts.length === 1) {
      account = accounts[0];
    } else {
      return res.status(400).json({ error: 'Plusieurs comptes Gmail : precise le compte d origine' });
    }

    const token = await gmailTokenFor(account);

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

// Connect WhatsApp (user provides their own token)
router.post('/whatsapp/connect', auth, async (req, res) => {
  try {
    const { accessToken, phoneNumberId } = req.body;
    if (!accessToken) return res.status(400).json({ error: 'Token requis' });
    if (!phoneNumberId) return res.status(400).json({ error: 'Phone Number ID requis' });

    // Verify the token works
    const verifyRes = await fetch(`${WHATSAPP_API}/${phoneNumberId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const verifyData = await verifyRes.json();
    if (verifyData.error) return res.status(400).json({ error: 'Token invalide ou Phone Number ID incorrect' });

    await sql`
      INSERT INTO connected_services (user_id, service_name, access_token, phone_number_id)
      VALUES (${req.userId}, 'whatsapp', ${accessToken}, ${phoneNumberId})
      ON CONFLICT (user_id, service_name)
      DO UPDATE SET access_token = ${accessToken}, phone_number_id = ${phoneNumberId}, created_at = NOW()
    `;

    res.json({ success: true, phoneNumberId });
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

    const result = await sql`SELECT access_token, phone_number_id FROM connected_services WHERE user_id = ${req.userId} AND service_name = 'whatsapp'`;
    const token = result.length > 0 ? result[0].access_token : null;
    const phoneNumberId = result.length > 0 ? result[0].phone_number_id : null;
    if (!token || !phoneNumberId) return res.status(400).json({ error: 'WhatsApp non configuré' });

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
    const result = await sql`SELECT access_token, phone_number_id FROM connected_services WHERE user_id = ${req.userId} AND service_name = 'whatsapp'`;
    const token = result.length > 0 ? result[0].access_token : null;
    const phoneNumberId = result.length > 0 ? result[0].phone_number_id : null;
    if (!token || !phoneNumberId) return res.status(400).json({ error: 'WhatsApp non configuré' });

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