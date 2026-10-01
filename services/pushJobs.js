const sql = require('../db');
const { sendPush, buildPayload } = require('../routes/push');
const { getGmailAccounts, gmailTokenFor, refreshGmailToken, parseEmailRules, evaluateEmail } = require('../lib/gmail');

const VAPID_OK = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
const TICK_MS = 60 * 1000;
const REMIND_BEFORE_MS = 15 * 60 * 1000;
const DIGEST_UTC_HOURS = [6, 7, 8, 9]; // fenetre matin (UTC) pour le rappel "taches du jour"
const EMAIL_POLL_TICKS = 5; // sondage Gmail (emails importants) toutes les 5 minutes
const EMAIL_WINDOW_MS = 15 * 60 * 1000; // ne notifier que les emails recus dans les 15 dernieres minutes

const utcToday = () => new Date().toISOString().slice(0, 10);

async function hasSubscription(userId) {
  const rows = await sql`
    SELECT 1 FROM push_subscriptions WHERE user_id = ${userId} LIMIT 1
  `;
  return rows.length > 0;
}

// Une notification par (user, cle) : la table push_notification_log evite les doublons
async function claim(userId, key) {
  const rows = await sql`
    INSERT INTO push_notification_log (user_id, dedupe_key)
    VALUES (${userId}, ${key})
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
    RETURNING id
  `;
  return rows.length > 0;
}

async function notify(userId, key, payload) {
  try {
    if (!(await hasSubscription(userId))) return false;
    if (!(await claim(userId, key))) return false;
    const res = await sendPush(userId, payload);
    if (res && res.sent === 0) {
      // Aucun envoi reussi : liberer la cle pour qu'une nouvelle tentative soit possible
      await sql`
        DELETE FROM push_notification_log WHERE user_id = ${userId} AND dedupe_key = ${key}
      `;
      return false;
    }
    return true;
  } catch (err) {
    console.error('notify error:', err.message);
    return false;
  }
}

// 1. Tâches en retard : une notif par tâche et par jour
async function checkOverdueTasks() {
  const today = utcToday();
  const rows = await sql`
    SELECT t.id, t.title, t.user_id, t.due_date
    FROM tasks t
    WHERE NOT t.completed
      AND t.due_date < ${today}
      AND NOT EXISTS (
        SELECT 1 FROM push_notification_log l
        WHERE l.user_id = t.user_id
          AND l.dedupe_key = 'overdue:' || t.id || ':' || ${today}
      )
    ORDER BY t.due_date DESC
  `;
  for (const t of rows) {
    await notify(t.user_id, `overdue:${t.id}:${today}`, buildPayload({
      title: 'Tâche en retard',
      body: `« ${t.title} » était prévu le ${t.due_date}`,
      url: '/dashboard',
      tag: `overdue-${t.id}`,
    }));
  }
}

// 2. Tâches du jour : un résumé par user, une fois par jour (fenêtre du matin)
async function checkDailyDigest() {
  const hour = new Date().getUTCHours();
  if (!DIGEST_UTC_HOURS.includes(hour)) return;
  const today = utcToday();
  const rows = await sql`
    SELECT t.user_id, count(*)::int AS n, array_agg(t.title ORDER BY t.priority DESC) AS titles
    FROM tasks t
    WHERE NOT t.completed AND t.due_date = ${today}
    GROUP BY t.user_id
  `;
  for (const r of rows) {
    const titles = (r.titles || []).slice(0, 3);
    const more = r.n > titles.length ? ` +${r.n - titles.length} autre${r.n - titles.length > 1 ? 's' : ''}` : '';
    await notify(r.user_id, `digest:${today}`, buildPayload({
      title: `${r.n} tâche${r.n > 1 ? 's' : ''} pour aujourd'hui`,
      body: `${titles.join(', ')}${more}`,
      url: '/dashboard',
      tag: 'digest',
    }));
  }
}

// 3. Rappel calendrier : 15 min avant le début de l'événement
async function checkCalendarReminders() {
  const today = utcToday();
  const rows = await sql`
    SELECT id, user_id, title, date, COALESCE(start_minute, hour * 60) AS start_minute
    FROM calendar_events
    WHERE date = ${today}
  `;
  const now = Date.now();
  for (const e of rows) {
    const start = Date.parse(`${e.date}T00:00:00Z`) + e.start_minute * 60000;
    const diff = start - now;
    if (diff > 0 && diff <= REMIND_BEFORE_MS) {
      await notify(e.user_id, `cal:${e.id}`, buildPayload({
        title: 'Dans 15 minutes',
        body: e.title,
        url: '/dashboard',
        tag: `cal-${e.id}`,
      }));
    }
  }
}

// 4. Messages d'équipe : notif directe aux autres membres (appelé par routes/teams.js)
async function notifyTeamNewMessage({ teamId, messageId, senderId, senderName, content }) {
  try {
    if (!VAPID_OK) return;
    const members = await sql`
      SELECT DISTINCT tm.user_id
      FROM team_members tm
      JOIN push_subscriptions ps ON ps.user_id = tm.user_id
      WHERE tm.team_id = ${teamId} AND tm.user_id <> ${senderId}
    `;
    const excerpt = content.length > 90 ? `${content.slice(0, 90)}…` : content;
    for (const m of members) {
      await notify(m.user_id, `msg:${messageId}`, buildPayload({
        title: `Nouveau message de ${senderName || 'un membre'}`,
        body: excerpt,
        url: '/dashboard',
        tag: 'team-message',
      }));
    }
  } catch (err) {
    console.error('notifyTeamNewMessage error:', err.message);
  }
}

// 5. Emails importants : sondage Gmail toutes les EMAIL_POLL_TICKS minutes
//    (utilisateurs abonnes au push ET Gmail connecte) — dedup par id Gmail
async function checkImportantEmails() {
  const users = await sql`
    SELECT DISTINCT ps.user_id
    FROM push_subscriptions ps
    JOIN connected_services cs ON cs.user_id = ps.user_id AND cs.service_name = 'gmail'
  `;
  for (const u of users) {
    try {
      await checkUserEmails(u.user_id);
    } catch (err) {
      console.error('checkImportantEmails error:', err.message);
    }
  }
}

async function checkUserEmails(userId) {
  const accounts = await getGmailAccounts(userId);
  if (accounts.length === 0) return;
  const rules = parseEmailRules(await sql`SELECT sender, keyword, priority FROM email_rules WHERE user_id = ${userId}`);
  const windowStart = Date.now() - EMAIL_WINDOW_MS;
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=${encodeURIComponent('is:unread')}`;

  for (const account of accounts) {
    let token;
    try {
      token = await gmailTokenFor(account);
    } catch (err) {
      console.error('Gmail token error:', err.message);
      continue;
    }

    let data = await (await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } })).json();
    if (data.error && data.error.code === 401 && account.refresh_token) {
      try {
        token = await refreshGmailToken(userId, account.refresh_token, account.account_key);
        data = await (await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } })).json();
      } catch (err) {
        console.error('Gmail refresh error:', err.message);
        continue;
      }
    }
    if (data.error) {
      console.error('Gmail list error:', data.error.message);
      continue;
    }

    for (const msg of (data.messages || []).slice(0, 10)) {
      try {
        const detail = await (await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
          { headers: { Authorization: `Bearer ${token}` } }
        )).json();
        if (detail.error) continue;
        const receivedAt = Number(detail.internalDate || 0);
        if (!receivedAt || receivedAt < windowStart) continue; // pas de rappel d'anciens emails
        if (!detail.labelIds || !detail.labelIds.includes('UNREAD')) continue;

        const headers = detail.payload?.headers || [];
        const from = headers.find(h => h.name === 'From')?.value || '';
        const subject = headers.find(h => h.name === 'Subject')?.value || '(sans objet)';
        const { priority, senderName, senderEmail } = evaluateEmail(rules, {
          from,
          subject,
          snippet: detail.snippet || '',
          isUnread: true,
        });
        if (priority !== 'high') continue;

        const who = senderName && senderName !== senderEmail ? `${senderName} — ` : '';
        await notify(userId, `email:${msg.id}`, buildPayload({
          title: 'Nouvel email important',
          body: `${who}${subject}`.slice(0, 140),
          url: '/dashboard',
          tag: `email-${msg.id}`,
        }));
      } catch (err) {
        console.error('Gmail message error:', err.message);
      }
    }
  }
}

let tickCount = 0;

async function tick() {
  if (!VAPID_OK) return;
  try {
    await checkOverdueTasks();
    await checkDailyDigest();
    await checkCalendarReminders();
    tickCount++;
    if (tickCount % EMAIL_POLL_TICKS === 0) await checkImportantEmails();
  } catch (err) {
    console.error('pushJobs tick error:', err.message);
  }
  // Nettoyage mensuel des logs de dedup (1x/jour à 04h UTC)
  const now = new Date();
  if (now.getUTCHours() === 4 && now.getUTCMinutes() === 0) {
    sql`DELETE FROM push_notification_log WHERE created_at < NOW() - INTERVAL '30 days'`.catch(() => {});
  }
}

function startPushJobs() {
  if (!VAPID_OK) {
    console.log('pushJobs: désactivé (VAPID manquant)');
    return;
  }
  if (String(process.env.PORT) === '3999') return; // environnement de test
  setTimeout(tick, 15 * 1000);
  setInterval(tick, TICK_MS);
  console.log('pushJobs: actif (tick 60s)');
}

module.exports = { startPushJobs, notifyTeamNewMessage, notifyUser: notify };
