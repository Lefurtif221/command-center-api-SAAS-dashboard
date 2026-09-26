const express = require('express');
const sql = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

// Get all tasks for user ( perso + equipes partagees )
router.get('/', auth, async (req, res) => {
  try {
    const tasks = await sql`
      SELECT t.id, t.title, t.completed, t.completed_at, t.priority, t.due_date, t.created_at, t.updated_at,
             t.team_id, tm.name AS team_name,
             CASE WHEN t.user_id = ${req.userId} THEN true ELSE false END AS is_owner,
             owner.name AS shared_by
      FROM tasks t
      LEFT JOIN teams tm ON tm.id = t.team_id
      LEFT JOIN users owner ON owner.id = t.user_id
      WHERE t.user_id = ${req.userId}
         OR t.team_id IN (SELECT team_id FROM team_members WHERE user_id = ${req.userId})
      ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC
    `;
    res.json({ tasks });
  } catch (err) {
    console.error('Get tasks error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Create a task (optionnellement partagee avec une equipe)
router.post('/', auth, async (req, res) => {
  try {
    const { title, priority, due_date, team_id } = req.body;
    if (!title) return res.status(400).json({ error: 'Titre requis' });

    if (team_id) {
      const member = await sql`
        SELECT 1 FROM team_members WHERE team_id = ${team_id} AND user_id = ${req.userId}
      `;
      if (member.length === 0) return res.status(403).json({ error: 'Vous n\'êtes pas membre de cette équipe' });
    }

    const result = await sql`
      INSERT INTO tasks (user_id, title, priority, due_date, team_id)
      VALUES (${req.userId}, ${title}, ${priority || 'medium'}, ${due_date || null}, ${team_id || null})
      RETURNING id, title, completed, completed_at, priority, due_date, created_at, team_id
    `;
    res.status(201).json({ task: result[0] });
  } catch (err) {
    console.error('Create task error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Update a task (toggle completed, edit) - proprietaire ou membre de l'equipe
router.put('/:id', auth, async (req, res) => {
  try {
    const { title, completed, priority, due_date, team_id } = req.body;
    const completedAt = completed === true ? sql`NOW()` : completed === false ? sql`NULL` : sql`completed_at`;
    const result = await sql`
      UPDATE tasks SET
        title = COALESCE(${title}, title),
        completed = COALESCE(${completed}, completed),
        completed_at = ${completedAt},
        priority = COALESCE(${priority}, priority),
        due_date = ${due_date !== undefined ? due_date : sql`due_date`},
        updated_at = NOW()
      WHERE id = ${req.params.id}
        AND (
          user_id = ${req.userId}
          OR team_id IN (SELECT team_id FROM team_members WHERE user_id = ${req.userId})
        )
      RETURNING id, title, completed, completed_at, priority, due_date, created_at, updated_at, team_id
    `;
    if (result.length === 0) return res.status(404).json({ error: 'Tâche non trouvée' });

    // Partager / retirer le partage
    if (team_id !== undefined) {
      if (team_id) {
        const member = await sql`
          SELECT 1 FROM team_members WHERE team_id = ${team_id} AND user_id = ${req.userId}
        `;
        if (member.length === 0) return res.status(403).json({ error: 'Vous n\'êtes pas membre de cette équipe' });
      }
      await sql`UPDATE tasks SET team_id = ${team_id || null}, updated_at = NOW() WHERE id = ${req.params.id}`;
      result[0].team_id = team_id || null;
    }

    res.json({ task: result[0] });
  } catch (err) {
    console.error('Update task error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Delete a task - proprietaire, ou admin de l'equipe si partagee
router.delete('/:id', auth, async (req, res) => {
  try {
    const rows = await sql`
      SELECT t.user_id, t.team_id,
             (SELECT role FROM team_members WHERE team_id = t.team_id AND user_id = ${req.userId}) AS my_role
      FROM tasks t WHERE t.id = ${req.params.id}
    `;
    if (rows.length === 0) return res.json({ success: true });

    const task = rows[0];
    const isOwner = task.user_id === req.userId;
    const isTeamAdmin = task.team_id && ['owner', 'admin'].includes(task.my_role);

    if (!isOwner && !isTeamAdmin) {
      return res.status(403).json({ error: 'Seul le propriétaire ou un administrateur peut supprimer cette tâche' });
    }

    await sql`DELETE FROM tasks WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (err) {
    console.error('Delete task error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
