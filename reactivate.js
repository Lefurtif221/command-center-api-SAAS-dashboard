// Campagne de reactivation des comptes dormants (jamais revenus apres J0).
//
// Usage (depuis server/) :
//   node reactivate.js                → dry-run : liste des cibles, rien envoye
//   node reactivate.js --send         → envoie l email aux cibles
//   node reactivate.js --send --limit=20
//   node reactivate.js --send --force → y compris deja reactivus
require('dotenv').config();
const sql = require('./db');
const { sendMail } = require('./lib/mailer');

const SITE = process.env.PUBLIC_URL || 'https://personnal-place.tech';
const CAMPAIGN = 'reactivation_2026_10';

const TARGETS_SQL = `
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
  )
  SELECT u.id, u.name, u.email, u.created_at::date AS inscrit, u.reactivated_at,
         max(a.last) AS derniere_action,
         CASE WHEN max(a.last) IS NULL THEN 'sans_action'
              WHEN max(a.last)::date <= u.created_at::date THEN 'j0'
              ELSE 'revu' END AS statut,
         EXISTS (
           SELECT 1 FROM connected_services c
           WHERE c.user_id = u.id AND c.service_name = 'gmail'
         ) AS gmail
  FROM users u
  LEFT JOIN act a ON a.user_id = u.id
  WHERE u.email NOT ILIKE '%@test.local'
    AND u.email_verified
    AND u.created_at::date <= CURRENT_DATE - 2
  GROUP BY u.id
  HAVING max(a.last) IS NULL OR max(a.last)::date <= u.created_at::date
  ORDER BY (max(a.last) IS NOT NULL), u.created_at
`;

function day(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

function renderEmail(u) {
  const link = `${SITE}/?utm_source=email_reactivation&utm_medium=dormeurs&utm_campaign=${CAMPAIGN}`;
  const intro = u.gmail
    ? `Tu as deja branche ton Gmail sur Personal Place, bravo. Il te reste la derniere etape pour que l espace vive : une premiere tache.`
    : `Ton espace t attend : cree ta premiere tache en 10 secondes et coche-la. C est tout ce qu il faut pour voir le tableau vivre.`;
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
      <h2 style="color: #0b0f14; margin-bottom: 16px;">Bonjour ${u.name || ''},</h2>
      <p style="color: #666; font-size: 14px; line-height: 1.6;">
        Tu t es inscrit sur Personal Place le ${day(u.inscrit)}. ${intro}
      </p>
      <p style="color: #666; font-size: 14px; line-height: 1.6;">
        Entre autres : taches du jour, rappels en cas de retard, calendrier et Gmail au meme endroit.
      </p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${link}" style="background: #2563EB; color: #ffffff; padding: 12px 24px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 14px;">Ouvrir mon espace</a>
      </p>
      <p style="color: #999; font-size: 12px; margin-top: 24px;">
        Si tu ne veux plus recevoir ces messages, reponds simplement a cet email.
      </p>
    </div>
  `;
}

async function main() {
  const args = process.argv.slice(2);
  const send = args.includes('--send');
  const force = args.includes('--force');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;
  if (limitArg && !Number.isFinite(limit)) {
    console.error('--limit invalide (ex: --limit=20)');
    process.exit(1);
  }

  const rows = await sql.query(TARGETS_SQL);
  const targets = rows.filter((r) => force || !r.reactivated_at).slice(0, limit);

  console.log(`Dormants trouves : ${rows.length} | cibles : ${targets.length}`);
  for (const t of targets) {
    console.log(`  - ${t.statut.padEnd(11)} ${day(t.inscrit)} ${t.gmail ? '[gmail]' : '      '} ${t.email}`);
  }

  if (!send) {
    console.log('Dry-run : rien envoye. Relance avec --send pour envoyer.');
    process.exit(0);
  }
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY absente : envoi impossible.');
    process.exit(1);
  }

  let ok = 0;
  let ko = 0;
  for (const t of targets) {
    const res = await sendMail({
      to: t.email,
      subject: 'Ta premiere tache t attend sur Personal Place',
      html: renderEmail(t),
    });
    if (res.sent) {
      ok += 1;
      await sql`UPDATE users SET reactivated_at = NOW() WHERE id = ${t.id}`;
      console.log(`ok   ${t.email}`);
    } else {
      ko += 1;
      console.error(`echec ${t.email} : ${res.reason}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`Envoyes : ${ok} | echecs : ${ko}`);
  process.exit(ko > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Erreur :', err.message || err);
  process.exit(1);
});
