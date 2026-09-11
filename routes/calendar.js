const express = require('express');
const sql = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

// Get all calendar events for user
router.get('/', auth, async (req, res) => {
  try {
    const events = await sql`
      SELECT id, title, date, hour, color, created_at
      FROM calendar_events WHERE user_id = ${req.userId}
      ORDER BY date ASC, hour ASC
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
    const { title, date, hour, color } = req.body;
    if (!title || !date || hour === undefined) return res.status(400).json({ error: 'Titre, date et heure requis' });

    const result = await sql`
      INSERT INTO calendar_events (user_id, title, date, hour, color)
      VALUES (${req.userId}, ${title}, ${date}, ${hour}, ${color || 'accent'})
      RETURNING id, title, date, hour, color, created_at
    `;
    res.status(201).json({ event: result[0] });
  } catch (err) {
    console.error('Create event error:', err);
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
