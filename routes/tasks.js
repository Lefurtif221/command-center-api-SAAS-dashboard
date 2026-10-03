const express = require('express');
const sql = require('../db');
const { auth } = require('../middleware/auth');
const { notifyUser } = require('../services/pushJobs');
const { buildPayload } = require('./push');

const router = express.Router();

// Get all tasks for user ( perso + equipes partagees )
router.get('/', auth, async (req, res) => {
  try {
    const tasks = await sql`
      SELECT t.id, t.title, t.completed, t.completed_at, t.priority,
             to_char(t.due_date, 'YYYY-MM-DD') AS due_date,
             to_char(t.remind_time, 'HH24:MI') AS remind_time,
             t.created_at, t.updated_at,
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
    const { title, priority, due_date, team_id, remind_time } = req.body;
    if (!title) return res.status(400).json({ error: 'Titre requis' });
    if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) return res.status(400).json({ error: 'Date invalide (AAAA-MM-JJ)' });
    if (remind_time && !/^\d{2}:\d{2}$/.test(remind_time)) return res.status(400).json({ error: 'Heure invalide (HH:MM)' });

    if (team_id) {
      const member = await sql`
        SELECT 1 FROM team_members WHERE team_id = ${team_id} AND user_id = ${req.userId}
      `;
      if (member.length === 0) return res.status(403).json({ error: 'Vous n\'êtes pas membre de cette équipe' });
    }

    const result = await sql`
      INSERT INTO tasks (user_id, title, priority, due_date, team_id, remind_time)
      VALUES (${req.userId}, ${title}, ${priority || 'medium'}, ${due_date || null}, ${team_id || null}, ${remind_time || null})
      RETURNING id, title, completed, completed_at, priority,
                to_char(due_date, 'YYYY-MM-DD') AS due_date,
                to_char(remind_time, 'HH24:MI') AS remind_time,
                created_at, team_id
    `;
    res.status(201).json({ task: result[0] });

    // Tache creee pour aujourd'hui : confirmation push immediate (no-op sans abonnement)
    if (due_date && due_date === new Date().toISOString().slice(0, 10)) {
      notifyUser(req.userId, `created:${result[0].id}`, buildPayload({
        title: 'Tâche ajoutée pour aujourd\'hui',
        body: title,
        url: '/dashboard',
        tag: `task-${result[0].id}`,
      })).catch(() => {});
    }
  } catch (err) {
    console.error('Create task error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Update a task (toggle completed, edit) - proprietaire ou membre de l'equipe
router.put('/:id', auth, async (req, res) => {
  try {
    const { title, completed, priority, due_date, team_id, remind_time } = req.body;
    if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) return res.status(400).json({ error: 'Date invalide (AAAA-MM-JJ)' });
    if (remind_time && !/^\d{2}:\d{2}$/.test(remind_time)) return res.status(400).json({ error: 'Heure invalide (HH:MM)' });
    const completedAt = completed === true ? sql`NOW()` : completed === false ? sql`NULL` : sql`completed_at`;
    const result = await sql`
      UPDATE tasks SET
        title = COALESCE(${title}, title),
        completed = COALESCE(${completed}, completed),
        completed_at = ${completedAt},
        priority = COALESCE(${priority}, priority),
        due_date = ${due_date !== undefined ? due_date : sql`due_date`},
        remind_time = ${remind_time !== undefined ? (remind_time || null) : sql`remind_time`},
        updated_at = NOW()
      WHERE id = ${req.params.id}
        AND (
          user_id = ${req.userId}
          OR team_id IN (SELECT team_id FROM team_members WHERE user_id = ${req.userId})
        )
      RETURNING id, title, completed, completed_at, priority,
                to_char(due_date, 'YYYY-MM-DD') AS due_date,
                to_char(remind_time, 'HH24:MI') AS remind_time,
                created_at, updated_at, team_id
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
