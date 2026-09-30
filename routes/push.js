const express = require('express');
const webPush = require('web-push');
const { auth } = require('../middleware/auth');
const sql = require('../db');

const router = express.Router();

const VAPID_CONFIGURED = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

// Apple refuse les subjects localhost/.local (erreur BadJwtToken) : on fallback sur un domaine reel
function vapidSubject() {
  const s = process.env.VAPID_SUBJECT || '';
  if (!s) return 'mailto:design-577906391@gmail.com';
  if (/\.local\b|localhost/i.test(s)) return 'mailto:design-577906391@gmail.com';
  return s;
}

if (VAPID_CONFIGURED) {
  webPush.setVapidDetails(
    vapidSubject(),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

async function sendPush(userId, payload) {
  if (!VAPID_CONFIGURED) return;
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

router.get('/vapid-public-key', (req, res) => {
  if (!VAPID_CONFIGURED) {
    return res.status(503).json({ error: 'Push non configuré (VAPID manquant)' });
  }
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

router.post('/subscribe', auth, async (req, res) => {
  const userId = req.userId;
  const { endpoint, keys } = req.body;

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Subscription invalide (endpoint, keys.p256dh, keys.auth requis)' });
  }

  try {
    await sql`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
      VALUES (${userId}, ${endpoint}, ${keys.p256dh}, ${keys.auth})
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
});

// Test utilisateur : envoie une notif de diagnostic sur tous les appareils abonnes
// et renvoie le resultat par appareil (pour savoir si le blocage est cote Apple/Google
// ou cote affichage sur l'appareil)
router.post('/test', auth, async (req, res) => {
  if (!VAPID_CONFIGURED) {
    return res.status(503).json({ error: 'Push non configuré (VAPID manquant)' });
  }
  const userId = req.userId;
  try {
    const rows = await sql`
      SELECT endpoint, p256dh, auth
      FROM push_subscriptions
      WHERE user_id = ${userId}
    `;
    if (rows.length === 0) {
      return res.json({ devices: 0, results: [], hint: 'Aucun appareil abonné — active les notifications sur cet appareil' });
    }

    const payload = JSON.stringify(buildPayload({
      title: 'Test Personal Place',
      body: 'Si tu vois cette notification, les push fonctionnent sur cet appareil.',
      url: '/dashboard',
      tag: 'push-test',
      requireInteraction: true,
    }));

    const results = await Promise.all(rows.map(async (sub) => {
      let host = '';
      try { host = new URL(sub.endpoint).host; } catch { host = 'endpoint invalide'; }
      try {
        await webPush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        return { host, ok: true };
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await sql`DELETE FROM push_subscriptions WHERE endpoint = ${sub.endpoint}`;
          return { host, ok: false, error: 'abonnement expiré (supprimé)', status: err.statusCode };
        }
        console.error('Push test error:', host, err.statusCode || '', err.message);
        return { host, ok: false, error: err.message, status: err.statusCode || null };
      }
    }));

    res.json({ devices: rows.length, results });
  } catch (err) {
    console.error('Push test error:', err.message);
    res.status(500).json({ error: 'Échec du test' });
  }
});

router.post('/unsubscribe', auth, async (req, res) => {
  const userId = req.userId;
  const { endpoint } = req.body;

  if (!endpoint) {
    return res.status(400).json({ error: 'Endpoint requis' });
  }

  try {
    await sql`DELETE FROM push_subscriptions WHERE user_id = ${userId} AND endpoint = ${endpoint}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('Unsubscribe error:', err.message);
    res.status(500).json({ error: 'Échec désabonnement' });
  }
});

module.exports = { router, sendPush, buildPayload, webPush };
