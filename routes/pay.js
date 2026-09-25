const express = require('express');
const sql = require('../db');
const { auth } = require('../middleware/auth');
const { getPlan } = require('../middleware/plan');
const { CinetPayClient, ApiError, AuthenticationError } = require('cinetpay-js');

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const API_URL = process.env.API_URL || 'http://localhost:3001';
const COUNTRY = (process.env.CINETPAY_COUNTRY || 'SN').toUpperCase();

// Offre Pro : 31 jours (montant entre 100 et 2 500 000 XOF)
const OFFERS = {
  pro: { amount: 2000, currency: 'XOF', periodDays: 31, designation: 'Personal Place Formule Pro 31 jours' },
};

// Un client par paire de credentials (le SDK cache le token JWT)
let cachedClient = null;
let cachedClientKey = null;

function getClient() {
  const apiKey = process.env.CINETPAY_API_KEY;
  const apiPassword = process.env.CINETPAY_API_PASSWORD;
  if (!apiKey || !apiPassword) return null;

  const key = `${apiKey}:${apiPassword}:${process.env.CINETPAY_API_URL || ''}`;
  if (!cachedClient || cachedClientKey !== key) {
    const config = { credentials: { [COUNTRY]: { apiKey, apiPassword } } };
    if (process.env.CINETPAY_API_URL) config.baseUrl = process.env.CINETPAY_API_URL;
    cachedClient = new CinetPayClient(config);
    cachedClientKey = key;
  }
  return cachedClient;
}

// Statut reel chez CinetPay (source de verite, jamais le webhook seul)
async function checkStatus(identifier) {
  try {
    const status = await getClient().payment.getStatus(identifier, COUNTRY);
    return String(status.status || '').toUpperCase();
  } catch (err) {
    if (err instanceof ApiError && err.apiStatus !== 'NOT_FOUND') {
      console.error('CinetPay check error:', err.message);
    }
    return null;
  }
}

// Active l'abonnement uniquement si CinetPay confirme le paiement
async function activateIfPaid(merchantTransactionId) {
  const rows = await sql`
    SELECT id, user_id, status, period_days, provider_ref
    FROM subscriptions
    WHERE provider_tx_id = ${merchantTransactionId}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const sub = rows[0];
  if (sub.status === 'active') return sub;

  const status = await checkStatus(merchantTransactionId);
  if (status !== 'SUCCESS') return null;

  const period = Number(sub.period_days) || 31;
  const expiresAt = new Date(Date.now() + period * 86400000).toISOString();
  await sql`
    UPDATE subscriptions
    SET status = 'active', expires_at = ${expiresAt}, updated_at = NOW()
    WHERE id = ${sub.id}
  `;
  await sql`UPDATE users SET plan = 'pro', updated_at = NOW() WHERE id = ${sub.user_id}`;
  return { ...sub, status: 'active', expires_at: expiresAt };
}

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  const first = parts[0] || 'Client';
  const last = parts.slice(1).join(' ') || 'Utilisateur';
  return {
    clientFirstName: first.length >= 2 ? first.slice(0, 255) : `${first}X`,
    clientLastName: last.length >= 2 ? last.slice(0, 255) : `${last}X`,
  };
}

// Initialisation du paiement : renvoie l'URL du guichet CinetPay
router.post('/init', auth, async (req, res) => {
  let merchantTransactionId = null;
  try {
    const client = getClient();
    if (!client) {
      return res.status(503).json({ error: 'Paiement pas encore configure', code: 'PAY_NOT_CONFIGURED' });
    }

    const offer = OFFERS.pro;
    const user = await sql`SELECT name, email FROM users WHERE id = ${req.userId}`;
    if (user.length === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });

    merchantTransactionId = `pp${Date.now()}${Math.random().toString(36).slice(2, 6)}`.slice(0, 30);
    await sql`
      INSERT INTO subscriptions (user_id, plan, status, provider, provider_tx_id, amount, currency, period_days)
      VALUES (${req.userId}, 'pro', 'pending', 'cinetpay', ${merchantTransactionId},
              ${offer.amount}, ${offer.currency}, ${offer.periodDays})
    `;

    const payment = await client.payment.initialize(
      {
        currency: offer.currency,
        merchantTransactionId,
        amount: offer.amount,
        lang: 'fr',
        designation: offer.designation,
        clientEmail: user[0].email,
        ...splitName(user[0].name),
        successUrl: `${FRONTEND_URL}/dashboard?pay_tx=${encodeURIComponent(merchantTransactionId)}`,
        failedUrl: `${FRONTEND_URL}/dashboard?pay_failed=1`,
        notifyUrl: `${API_URL}/api/pay/notify`,
        channel: 'PUSH',
      },
      COUNTRY
    );

    if (payment.notifyToken) {
      await sql`UPDATE subscriptions SET notify_token = ${payment.notifyToken} WHERE provider_tx_id = ${merchantTransactionId}`;
    }
    if (payment.transactionId) {
      await sql`UPDATE subscriptions SET provider_ref = ${payment.transactionId} WHERE provider_tx_id = ${merchantTransactionId}`;
    }

    res.json({
      payment_url: payment.paymentUrl,
      transaction_id: merchantTransactionId,
      amount: offer.amount,
      currency: offer.currency,
      period_days: offer.periodDays,
    });
  } catch (err) {
    // Echec de l'init : on ne garde pas d'abonnement fantome en attente
    if (merchantTransactionId) {
      try {
        await sql`DELETE FROM subscriptions WHERE provider_tx_id = ${merchantTransactionId} AND status = 'pending'`;
      } catch (cleanupErr) {
        console.error('Pay init cleanup error:', cleanupErr);
      }
    }
    if (err instanceof AuthenticationError) {
      return res.status(503).json({ error: 'Identifiants CinetPay invalides', code: 'PAY_NOT_CONFIGURED' });
    }
    if (err instanceof ApiError) {
      console.error('CinetPay init error:', err.apiCode, err.apiStatus, err.description);
      return res.status(502).json({ error: "Impossible d'initialiser le paiement", code: 'PAY_INIT_FAILED', detail: err.description });
    }
    console.error('Pay init error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Webhook CinetPay (sans token) : on re-verifie tout cote serveur
router.post('/notify', async (req, res) => {
  try {
    const body = req.body || {};
    const merchantId = body.merchant_transaction_id || body.transaction_id || body.cpm_trans_id;
    if (merchantId) {
      const sub = await activateIfPaid(merchantId);
      if (!sub && body.transaction_id) {
        const byRef = await sql`SELECT provider_tx_id FROM subscriptions WHERE provider_ref = ${body.transaction_id} LIMIT 1`;
        if (byRef.length) await activateIfPaid(byRef[0].provider_tx_id);
      }
      console.log('CinetPay notify:', merchantId, sub ? 'active' : 'ignore');
    }
  } catch (err) {
    console.error('Pay notify error:', err);
  }
  res.status(200).send('OK');
});

// Retour du guichet : le frontend appelle ce point une fois
router.get('/status', auth, async (req, res) => {
  try {
    const transactionId = req.query.transaction_id;
    if (!transactionId) return res.status(400).json({ error: 'transaction_id requis' });

    const rows = await sql`
      SELECT id, status, expires_at, amount, currency
      FROM subscriptions
      WHERE provider_tx_id = ${transactionId} AND user_id = ${req.userId}
      LIMIT 1
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Transaction introuvable' });

    if (rows[0].status !== 'active') await activateIfPaid(transactionId);

    const fresh = await sql`SELECT status, expires_at FROM subscriptions WHERE id = ${rows[0].id}`;
    res.json({
      status: fresh[0].status,
      expires_at: fresh[0].expires_at,
      plan: fresh[0].status === 'active' ? 'pro' : 'free',
    });
  } catch (err) {
    console.error('Pay status error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Etat de l'abonnement courant
router.get('/subscription', auth, async (req, res) => {
  try {
    const info = await getPlan(req.userId);
    const rows = await sql`
      SELECT amount, currency, status, expires_at, provider_tx_id, period_days
      FROM subscriptions
      WHERE user_id = ${req.userId} AND status = 'active'
      ORDER BY expires_at DESC NULLS LAST
      LIMIT 1
    `;
    res.json({ plan: info.plan, subscription: rows[0] || null });
  } catch (err) {
    console.error('Pay subscription error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
