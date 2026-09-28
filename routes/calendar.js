const express = require('express');
const sql = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

const normalizeSlot = (body) => {
  const { title, date, hour, start_minute, end_minute, color } = body;
  if (!title || !date) return { error: 'Titre et date requis' };
  if (String(title).length > 500) return { error: 'Titre trop long (500 caractères max)' };

  let start;
  let end;
  if (start_minute !== undefined && start_minute !== null && start_minute !== '') {
    start = Number(start_minute);
    end = end_minute !== undefined && end_minute !== null && end_minute !== '' ? Number(end_minute) : start + 60;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { error: 'Horaires invalides' };
    start = Math.round(start);
    end = Math.round(end);
    if (start < 0 || start > 1439 || end > 1440) return { error: 'Horaire hors limites (00:00–24:00)' };
    if (end <= start) return { error: 'La fin doit être après le début' };
  } else {
    const h = Number(hour);
    if (!Number.isFinite(h) || h < 0 || h > 23) return { error: 'Heure invalide' };
    start = Math.round(h) * 60;
    end = start + 60;
  }

  return { value: { start, end, hour: Math.floor(start / 60), color: color || 'accent' } };
};

// Get all calendar events for user
router.get('/', auth, async (req, res) => {
  try {
    const events = await sql`
      SELECT id, title, date, hour, color, created_at,
             COALESCE(start_minute, hour * 60) AS start_minute,
             COALESCE(end_minute, hour * 60 + 60) AS end_minute
      FROM calendar_events WHERE user_id = ${req.userId}
      ORDER BY date ASC, start_minute ASC
    `;
    res.json({ events });
  } catch (err) {
    console.error('Get events error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Create a calendar event
router.post('/', auth, async (req, res) => {
  try {
    const slot = normalizeSlot(req.body);
    if (slot.error) return res.status(400).json({ error: slot.error });
    const { start, end, hour, color } = slot.value;
    const title = String(req.body.title).trim();

    const result = await sql`
      INSERT INTO calendar_events (user_id, title, date, hour, color, start_minute, end_minute)
      VALUES (${req.userId}, ${title}, ${req.body.date}, ${hour}, ${color}, ${start}, ${end})
      RETURNING id, title, date, hour, color, created_at, start_minute, end_minute
    `;
    res.status(201).json({ event: result[0] });
  } catch (err) {
    console.error('Create event error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Update a calendar event
router.put('/:id', auth, async (req, res) => {
  try {
    const slot = normalizeSlot(req.body);
    if (slot.error) return res.status(400).json({ error: slot.error });
    const { start, end, hour, color } = slot.value;
    const title = String(req.body.title).trim();

    const result = await sql`
      UPDATE calendar_events
      SET title = ${title}, date = ${req.body.date}, hour = ${hour}, color = ${color},
          start_minute = ${start}, end_minute = ${end}
      WHERE id = ${req.params.id} AND user_id = ${req.userId}
      RETURNING id, title, date, hour, color, created_at, start_minute, end_minute
    `;
    if (!result[0]) return res.status(404).json({ error: 'Evenement introuvable' });
    res.json({ event: result[0] });
  } catch (err) {
    console.error('Update event error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Delete a calendar event
router.delete('/:id', auth, async (req, res) => {
  try {
    await sql`DELETE FROM calendar_events WHERE id = ${req.params.id} AND user_id = ${req.userId}`;
    res.json({ success: true });
  } catch (err) {
    console.error('Delete event error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
