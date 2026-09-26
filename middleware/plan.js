const sql = require('../db');

// Quotas par formule
const PLANS = {
  free: { teams: 1, teamMembers: 3, focusDays: 7 },
  pro: { teams: 7, teamMembers: 10, focusDays: 90 },
  entreprise: { teams: 20, teamMembers: 50, focusDays: 365 },
};

// Ordre des paliers : free < pro < entreprise
const PLAN_RANK = { free: 0, pro: 1, entreprise: 2 };

function planRank(plan) {
  return PLAN_RANK[plan] !== undefined ? PLAN_RANK[plan] : 0;
}

function isPaidPlan(plan) {
  return planRank(plan) > 0;
}

// Comptes proprietaire : Pro permanent, toutes les options debloquees.
// Se surcharge avec la variable d'env ADMIN_EMAILS (separee par des virgules).
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'thebigmaster2k2@gmail.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function isAdminEmail(email) {
  return !!email && ADMIN_EMAILS.includes(String(email).trim().toLowerCase());
}

// Formule renvoyee au client : les comptes proprietaire sont toujours en Entreprise
function publicUser(user) {
  if (user && isAdminEmail(user.email)) return { ...user, plan: 'entreprise' };
  return user;
}

async function getPlan(userId) {
  const rows = await sql`SELECT plan, email FROM users WHERE id = ${userId}`;
  const row = rows[0];
  const admin = isAdminEmail(row && row.email);
  const stored = row && PLAN_RANK[row.plan] !== undefined ? row.plan : 'free';
  let plan = admin ? 'entreprise' : stored;

  // Un compte passe en Pro/Entreprise par paiement : l'abonnement doit encore etre valide.
  // Sans aucun abonnement (grant manuel), on garde le plan en l'etat.
  if (!admin && isPaidPlan(plan)) {
    const subs = await sql`SELECT 1 FROM subscriptions WHERE user_id = ${userId} LIMIT 1`;
    if (subs.length > 0) {
      const active = await sql`
        SELECT 1 FROM subscriptions
        WHERE user_id = ${userId} AND status = 'active'
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1
      `;
      if (active.length === 0) plan = 'free';
    }
  }

  return { plan, limits: PLANS[plan] || PLANS.free, admin };
}

// 402 si la formule requise n'est pas activee
function requirePlan(required = 'pro') {
  return async (req, res, next) => {
    try {
      const info = await getPlan(req.userId);
      req.plan = info.plan;
      req.limits = info.limits;
      if (planRank(info.plan) < planRank(required)) {
        return res.status(402).json({
          error: `Fonctionnalite reservee aux comptes ${required}`,
          code: 'PLAN_REQUIRED',
          required,
          plan: info.plan,
        });
      }
      next();
    } catch (err) {
      console.error('requirePlan error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  };
}

module.exports = { getPlan, requirePlan, PLANS, PLAN_RANK, planRank, isPaidPlan, isAdminEmail, publicUser, ADMIN_EMAILS };
