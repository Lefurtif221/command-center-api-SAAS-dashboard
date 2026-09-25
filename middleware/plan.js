const sql = require('../db');

// Quotas par formule
const PLANS = {
  free: { teams: 1, teamMembers: 3, focusDays: 7 },
  pro: { teams: 20, teamMembers: 50, focusDays: 365 },
};

// Comptes proprietaire : Pro permanent, toutes les options debloquees.
// Se surcharge avec la variable d'env ADMIN_EMAILS (separee par des virgules).
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'thebigmaster2k2@gmail.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function isAdminEmail(email) {
  return !!email && ADMIN_EMAILS.includes(String(email).trim().toLowerCase());
}

// Formule renvoyee au client : les comptes proprietaire sont toujours en Pro
function publicUser(user) {
  if (user && isAdminEmail(user.email)) return { ...user, plan: 'pro' };
  return user;
}

async function getPlan(userId) {
  const rows = await sql`SELECT plan, email FROM users WHERE id = ${userId}`;
  const row = rows[0];
  const admin = isAdminEmail(row && row.email);
  const plan = admin || (row && row.plan === 'pro') ? 'pro' : 'free';
  return { plan, limits: PLANS[plan], admin };
}

// 402 si la formule requise n'est pas activee
function requirePlan(required = 'pro') {
  return async (req, res, next) => {
    try {
      const info = await getPlan(req.userId);
      req.plan = info.plan;
      req.limits = info.limits;
      if (required === 'pro' && info.plan !== 'pro') {
        return res.status(402).json({
          error: 'Fonctionnalite reservee aux comptes Pro',
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

module.exports = { getPlan, requirePlan, PLANS, isAdminEmail, publicUser, ADMIN_EMAILS };
