const sql = require('../db');

// Quotas par formule
const PLANS = {
  free: { teams: 1, teamMembers: 3 },
  pro: { teams: 20, teamMembers: 50 },
};

async function getPlan(userId) {
  const rows = await sql`SELECT plan FROM users WHERE id = ${userId}`;
  const plan = rows[0] && rows[0].plan === 'pro' ? 'pro' : 'free';
  return { plan, limits: PLANS[plan] };
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

module.exports = { getPlan, requirePlan, PLANS };
