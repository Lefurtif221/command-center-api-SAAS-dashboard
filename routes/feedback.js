const express = require('express');
const sql = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

const CATEGORIES = ['idea', 'bug', 'other'];

router.post('/', auth, async (req, res) => {
  try {
    const { category, message, page } = req.body || {};
    const msg = String(message || '').trim();
    if (!msg) return res.status(400).json({ error: 'Message requis' });
    if (msg.length > 2000) return res.status(400).json({ error: 'Message trop long (2000 caractères max)' });
    const cat = CATEGORIES.includes(category) ? category : 'other';

    const result = await sql`
      INSERT INTO feedbacks (user_id, category, message, page)
      VALUES (${req.userId}, ${cat}, ${msg}, ${page ? String(page).slice(0, 100) : null})
      RETURNING id, category, message, created_at
    `;
    res.status(201).json({ feedback: result[0] });
  } catch (err) {
    console.error('Create feedback error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
