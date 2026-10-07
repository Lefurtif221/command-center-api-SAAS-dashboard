// Stats d activation et d attribution : d ou viennent les inscrits,
// combien creent une premiere tache, qui est dormant.
// Usage (depuis server/) : node insights.js
require('dotenv').config();
const sql = require('./db');

const NOT_TEST = '%@test.local';

async function section(title, fn) {
  console.log(`\n## ${title}`);
  try {
    const rows = await fn();
    if (rows.length === 0) { console.log('  (vide)'); return; }
    const cols = Object.keys(rows[0]);
    console.log('  ' + cols.join(' | '));
    for (const r of rows) console.log('  ' + cols.map((c) => String(r[c] ?? '')).join(' | '));
  } catch (err) {
    console.error('  ERREUR :', err.message);
  }
}

async function main() {
  await section('Compteurs', () => sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE email NOT ILIKE ${NOT_TEST})::int AS reels,
           count(*) FILTER (WHERE email NOT ILIKE ${NOT_TEST} AND created_at >= now() - interval '24 hours')::int AS d24h,
           count(*) FILTER (WHERE email NOT ILIKE ${NOT_TEST} AND created_at >= now() - interval '7 days')::int AS d7j
    FROM users
  `);

  await section('Activation par semaine (premiere tache)', () => sql`
    SELECT date_trunc('week', created_at)::date AS semaine,
           count(*)::int AS inscrits,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM tasks t WHERE t.user_id = users.id
           ))::int AS avec_tache
    FROM users
    WHERE email NOT ILIKE ${NOT_TEST}
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT 8
  `);

  await section('Sources d inscription', () => sql`
    SELECT COALESCE(
             signup_source->>'utm_source',
             signup_source->>'ref',
             CASE WHEN signup_source->>'referrer' IS NOT NULL THEN 'referrer' ELSE 'direct' END
           ) AS source,
           count(*)::int AS n
    FROM users
    WHERE email NOT ILIKE ${NOT_TEST}
    GROUP BY 1
    ORDER BY n DESC
  `);

  await section('Referrers (hotes)', () => sql`
    SELECT split_part(split_part(signup_source->>'referrer', '/', 3), ':', 1) AS hote,
           count(*)::int AS n
    FROM users
    WHERE email NOT ILIKE ${NOT_TEST}
      AND signup_source->>'referrer' IS NOT NULL
    GROUP BY 1
    ORDER BY n DESC
    LIMIT 8
  `);

  await section('Tunnel dormance', () => sql`
    WITH act AS (
      SELECT user_id, max(created_at) AS last FROM tasks GROUP BY user_id
      UNION ALL
      SELECT user_id, max(created_at) FROM focus_sessions GROUP BY user_id
      UNION ALL
      SELECT user_id, max(created_at) FROM calendar_events GROUP BY user_id
      UNION ALL
      SELECT user_id, max(created_at) FROM connected_services GROUP BY user_id
      UNION ALL
      SELECT user_id, max(created_at) FROM push_subscriptions GROUP BY user_id
    ),
    per AS (
      SELECT u.id, u.created_at::date AS inscrit, max(a.last) AS derniere_action
      FROM users u
      LEFT JOIN act a ON a.user_id = u.id
      WHERE u.email NOT ILIKE ${NOT_TEST}
      GROUP BY u.id, u.created_at::date
    )
    SELECT CASE WHEN derniere_action IS NULL THEN 'sans_action'
                WHEN derniere_action::date <= inscrit THEN 'j0_only'
                ELSE 'revu' END AS statut,
           count(*)::int AS n
    FROM per
    GROUP BY 1
    ORDER BY n DESC
  `);

  await section('Cibles reactivation (dernier envoi)', () => sql`
    SELECT count(*) FILTER (WHERE reactivated_at IS NOT NULL)::int AS deja_reactive,
           count(*) FILTER (WHERE reactivated_at IS NULL)::int AS jamais_reactive
    FROM users
    WHERE email NOT ILIKE ${NOT_TEST}
  `);

  process.exit(0);
}

main().catch((err) => {
  console.error('Erreur :', err.message || err);
  process.exit(1);
});
