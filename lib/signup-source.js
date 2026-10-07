// Sanitise la source d'inscription capturee par le front (UTM, ref, referrer).
// Retourne une chaine JSON prete pour une colonne JSONB, ou null.
const KEYS = ['ref', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'referrer', 'landed_at'];

function sanitizeSource(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const k of KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 300);
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

module.exports = { sanitizeSource };
