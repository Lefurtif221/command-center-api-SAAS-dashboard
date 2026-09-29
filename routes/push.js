const webPush = require('web-push');
const { requireAuth } = require('../middleware/auth');
const sql = require('../db');

webPush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:design-577906391@test.local',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

async function sendPush(userId, payload) {
  try {
    const rows = await sql`
      SELECT endpoint, p256dh, auth
      FROM push_subscriptions
      WHERE user_id = ${userId}
    `;
    for (const sub of rows) {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth,
        },
      };
      try {
        await webPush.sendNotification(pushSubscription, JSON.stringify(payload));
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await sql`DELETE FROM push_subscriptions WHERE endpoint = ${sub.endpoint}`;
        } else {
          console.error('Push send error:', err.message);
        }
      }
    }
  } catch (err) {
    console.error('sendPush error:', err.message);
  }
}

function buildPayload({ title, body, url = '/dashboard', icon = '/icons/icon-192.png', badge = '/icons/icon-192.png', data = {}, tag, requireInteraction = false }) {
  return { title, body, url, icon, badge, data, tag, requireInteraction };
}

module.exports = { sendPush, buildPayload, webPush };

async function subscribeHandler(req, res) {
  const user = req.user;
  const { endpoint, keys } = req.body;

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Subscription invalide (endpoint, keys.p256dh, keys.auth requis)' });
  }

  try {
    await sql`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
      VALUES (${user.id}, ${endpoint}, ${keys.p256dh}, ${keys.auth})
      ON CONFLICT (endpoint) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        updated_at = NOW()
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error('Subscribe error:', err.message);
    res.status(500).json({ error: 'Échec enregistrement' });
  }
}

async function unsubscribeHandler(req, res) {
  const user = req.user;
  const { endpoint } = req.body;

  if (!endpoint) {
    return res.status(400).json({ error: 'Endpoint requis' });
  }

  try {
    await sql`DELETE FROM push_subscriptions WHERE user_id = ${user.id} AND endpoint = ${endpoint}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('Unsubscribe error:', err.message);
    res.status(500).json({ error: 'Échec désabonnement' });
  }
}

async function getPublicKeyHandler(req, res) {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
}

module.exports = (req, res) => {
  const method = req.method;
  const path = req.path;

  if (method === 'GET' && path === '/vapid-public-key') {
    return getPublicKeyHandler(req, res);
  }
  if (method === 'POST' && path === '/subscribe') {
    return requireAuth(req, res, () => subscribeHandler(req, res));
  }
  if (method === 'POST' && path === '/unsubscribe') {
    return requireAuth(req, res, () => unsubscribeHandler(req, res));
  }

  res.status(404).json({ error: 'Route introuvable' });
};