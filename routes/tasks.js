const express = require('express');
const sql = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

// Get all tasks for user
router.get('/', auth, async (req, res) => {
  try {
    const tasks = await sql`
      SELECT id, title, completed, priority, due_date, created_at, updated_at
      FROM tasks WHERE user_id = ${req.userId}
      ORDER BY due_date ASC NULLS LAST, created_at DESC
    `;
    res.json({ tasks });
  } catch (err) {
    console.error('Get tasks error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Create a task
router.post('/', auth, async (req, res) => {
  try {
    const { title, priority, due_date } = req.body;
    if (!title) return res.status(400).json({ error: 'Titre requis' });

    const result = await sql`
      INSERT INTO tasks (user_id, title, priority, due_date)
      VALUES (${req.userId}, ${title}, ${priority || 'medium'}, ${due_date || null})
      RETURNING id, title, completed, priority, due_date, created_at
    `;
    res.status(201).json({ task: result[0] });
  } catch (err) {
    console.error('Create task error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Update a task (toggle completed, edit)
router.put('/:id', auth, async (req, res) => {
  try {
    const { title, completed, priority, due_date } = req.body;
    const result = await sql`
      UPDATE tasks SET
        title = COALESCE(${title}, title),
        completed = COALESCE(${completed}, completed),
        priority = COALESCE(${priority}, priority),
        due_date = ${due_date !== undefined ? due_date : sql`due_date`},
        updated_at = NOW()
      WHERE id = ${req.params.id} AND user_id = ${req.userId}
      RETURNING id, title, completed, priority, due_date, created_at, updated_at
    `;
    if (result.length === 0) return res.status(404).json({ error: 'Tâche non trouvée' });
    res.json({ task: result[0] });
  } catch (err) {
    console.error('Update task error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Delete a task
router.delete('/:id', auth, async (req, res) => {
  try {
    await sql`DELETE FROM tasks WHERE id = ${req.params.id} AND user_id = ${req.userId}`;
    res.json({ success: true });
  } catch (err) {
    console.error('Delete task error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
