const sql = require('../db');

// --- Helpers Gmail partages (routes/services.js + services/pushJobs.js) ---

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

// Transforme les lignes de email_rules en deux index utilises par evaluateEmail
function parseEmailRules(rows) {
  const senderRules = {};
  const keywordRules = [];
  for (const r of rows) {
    if (r.sender) senderRules[r.sender.toLowerCase()] = r.priority;
    if (r.keyword) keywordRules.push({ keyword: r.keyword.toLowerCase(), priority: r.priority });
  }
  return { senderRules, keywordRules };
}

// Priorite d'un email : non lu = high par defaut, puis sender exact, domaine @, mots-cles
function evaluateEmail(rules, { from = '', subject = '', snippet = '', isUnread = false }) {
  const emailMatch = from.match(/<(.+?)>/);
  const senderEmail = (emailMatch ? emailMatch[1] : from).trim();
  const senderName = from.split('<')[0].trim();

  let priority = isUnread ? 'high' : 'low';
  if (rules.senderRules[senderEmail.toLowerCase()]) {
    priority = rules.senderRules[senderEmail.toLowerCase()];
  } else {
    const domain = senderEmail.split('@')[1];
    if (domain && rules.senderRules['@' + domain]) {
      priority = rules.senderRules['@' + domain];
    }
  }
  const textToCheck = (subject + ' ' + snippet).toLowerCase();
  for (const kr of rules.keywordRules) {
    if (textToCheck.includes(kr.keyword)) {
      priority = kr.priority;
      break;
    }
  }
  return { priority, senderEmail, senderName };
}

module.exports = { getGmailAccounts, gmailTokenFor, refreshGmailToken, parseEmailRules, evaluateEmail };
