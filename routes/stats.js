const express = require('express');
const sql = require('../db');
const { auth } = require('../middleware/auth');
const { getPlan } = require('../middleware/plan');

const router = express.Router();

// Enregistre une session de focus terminee (Pomodoro / minuterie)
router.post('/focus', auth, async (req, res) => {
  try {
    const duration = parseInt(req.body.duration_seconds, 10);
    if (!Number.isFinite(duration) || duration < 60 || duration > 86400) {
      return res.status(400).json({ error: 'Duree invalide' });
    }
    const title = (req.body.task_title || '').slice(0, 500);
    const rows = await sql`
      INSERT INTO focus_sessions (user_id, duration_seconds, task_title)
      VALUES (${req.userId}, ${duration}, ${title || null})
      RETURNING id, duration_seconds, task_title, started_at
    `;
    res.status(201).json({ session: rows[0] });
  } catch (err) {
    console.error('Focus session error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

function lastNDates(days) {
  const dates = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    dates.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
  }
  return dates;
}

// Vue d'ensemble : minutes de focus/jour, sessions, taches terminees, serie
// gratuit = 7 derniers jours, pro = 365
router.get('/overview', auth, async (req, res) => {
  try {
    const info = await getPlan(req.userId);
    const limitDays = info.limits.focusDays;
    const requested = parseInt(req.query.days, 10) || 7;
    const clamped = requested > limitDays;
    const days = Math.min(Math.max(requested, 1), limitDays);

    const focusRows = await sql`
      SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
             COUNT(*)::int AS sessions,
             COALESCE(SUM(duration_seconds), 0)::int AS seconds
      FROM focus_sessions
      WHERE user_id = ${req.userId}
        AND started_at >= NOW() - make_interval(days => ${days})
      GROUP BY 1
    `;
    const taskRows = await sql`
      SELECT to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
             COUNT(*)::int AS count
      FROM tasks
      WHERE user_id = ${req.userId}
        AND completed_at >= NOW() - make_interval(days => ${days})
      GROUP BY 1
    `;

    const focusMap = new Map(focusRows.map((r) => [r.date, r]));
    const taskMap = new Map(taskRows.map((r) => [r.date, r.count]));
    const dates = lastNDates(days);

    const focus = dates.map((date) => {
      const row = focusMap.get(date);
      return {
        date,
        sessions: row ? row.sessions : 0,
        minutes: row ? Math.round(row.seconds / 60) : 0,
      };
    });
    const tasks = dates.map((date) => ({ date, count: taskMap.get(date) || 0 }));

    // Serie : jours consecutifs avec au moins une session (aujourd'hui ou hier)
    const activeDays = new Set(focus.filter((f) => f.sessions > 0).map((f) => f.date));
    let streak = 0;
    const cursor = new Date();
    if (!activeDays.has(cursor.toISOString().slice(0, 10))) {
      cursor.setTime(cursor.getTime() - 86400000);
    }
    while (activeDays.has(cursor.toISOString().slice(0, 10))) {
      streak++;
      cursor.setTime(cursor.getTime() - 86400000);
    }

    res.json({
      plan: info.plan,
      days,
      limitDays,
      clamped,
      focus,
      tasks,
      streak,
      totals: {
        focusMinutes: focus.reduce((sum, f) => sum + f.minutes, 0),
        sessions: focus.reduce((sum, f) => sum + f.sessions, 0),
        tasksDone: tasks.reduce((sum, t) => sum + t.count, 0),
      },
    });
  } catch (err) {
    console.error('Stats overview error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
