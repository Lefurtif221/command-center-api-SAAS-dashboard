const express = require('express');
const crypto = require('crypto');
const { Resend } = require('resend');
const sql = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const INVITE_TTL_DAYS = 7;
const VALID_ROLES = ['admin', 'member'];

async function getMembership(teamId, userId) {
  const rows = await sql`
    SELECT tm.role, t.owner_id, t.name
    FROM team_members tm
    JOIN teams t ON t.id = tm.team_id
    WHERE tm.team_id = ${teamId} AND tm.user_id = ${userId}
  `;
  return rows[0] || null;
}

function canManage(role) {
  return role === 'owner' || role === 'admin';
}

// Creer une equipe
router.post('/', auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });

    const existing = await sql`
      SELECT COUNT(*)::int AS count FROM team_members WHERE user_id = ${req.userId}
    `;
    if (existing[0].count >= 5) {
      return res.status(400).json({ error: 'Maximum 5 equipes par compte' });
    }

    const team = await sql`
      INSERT INTO teams (name, owner_id) VALUES (${name.trim()}, ${req.userId})
      RETURNING id, name, owner_id, created_at
    `;
    await sql`
      INSERT INTO team_members (team_id, user_id, role)
      VALUES (${team[0].id}, ${req.userId}, 'owner')
      ON CONFLICT (team_id, user_id) DO NOTHING
    `;
    res.status(201).json({ team: team[0] });
  } catch (err) {
    console.error('Create team error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Lister mes equipes
router.get('/', auth, async (req, res) => {
  try {
    const teams = await sql`
      SELECT t.id, t.name, t.owner_id, t.created_at, tm.role,
             (SELECT COUNT(*)::int FROM team_members WHERE team_id = t.id) AS member_count,
             o.name AS owner_name, o.initials AS owner_initials
      FROM teams t
      JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ${req.userId}
      JOIN users o ON o.id = t.owner_id
      ORDER BY t.created_at DESC
    `;
    res.json({ teams });
  } catch (err) {
    console.error('List teams error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Details d'une equipe (membres + invitations en attente)
router.get('/:id', auth, async (req, res) => {
  try {
    const membership = await getMembership(req.params.id, req.userId);
    if (!membership) return res.status(404).json({ error: 'Equipe introuvable' });

    const members = await sql`
      SELECT tm.user_id, tm.role, u.name, u.email, u.initials, u.avatar_url
      FROM team_members tm
      JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ${req.params.id}
      ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.name
    `;

    let invitations = [];
    if (canManage(membership.role)) {
      invitations = await sql`
        SELECT id, email, role, status, created_at, expires_at
        FROM team_invitations
        WHERE team_id = ${req.params.id} AND status = 'pending'
        ORDER BY created_at DESC
      `;
    }

    res.json({ team: { id: req.params.id, name: membership.name, owner_id: membership.owner_id }, role: membership.role, members, invitations });
  } catch (err) {
    console.error('Team details error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Renommer
router.put('/:id', auth, async (req, res) => {
  try {
    const membership = await getMembership(req.params.id, req.userId);
    if (!membership) return res.status(404).json({ error: 'Equipe introuvable' });
    if (!canManage(membership.role)) return res.status(403).json({ error: 'Action reservee aux administrateurs' });

    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });

    const result = await sql`
      UPDATE teams SET name = ${name.trim()}, updated_at = NOW()
      WHERE id = ${req.params.id} RETURNING id, name
    `;
    res.json({ team: result[0] });
  } catch (err) {
    console.error('Rename team error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Inviter par email
router.post('/:id/invitations', auth, async (req, res) => {
  try {
    const membership = await getMembership(req.params.id, req.userId);
    if (!membership) return res.status(404).json({ error: 'Equipe introuvable' });
    if (!canManage(membership.role)) return res.status(403).json({ error: 'Action reservee aux administrateurs' });

    const { email, role } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email invalide' });
    const inviteRole = VALID_ROLES.includes(role) ? role : 'member';

    const target = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (target.length > 0) {
      const already = await sql`
        SELECT id FROM team_members WHERE team_id = ${req.params.id} AND user_id = ${target[0].id}
      `;
      if (already.length > 0) return res.status(409).json({ error: 'Cet utilisateur est deja dans l\'equipe' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400000);

    await sql`DELETE FROM team_invitations WHERE team_id = ${req.params.id} AND email = ${email} AND status = 'pending'`;
    await sql`
      INSERT INTO team_invitations (team_id, email, role, invited_by, token, expires_at)
      VALUES (${req.params.id}, ${email}, ${inviteRole}, ${req.userId}, ${token}, ${expiresAt})
    `;

    const inviteUrl = `${FRONTEND_URL}/team/invite?token=${token}`;

    if (resend) {
      const inviter = await sql`SELECT name FROM users WHERE id = ${req.userId}`;
      try {
        await resend.emails.send({
          from: 'Personal Place <onboarding@resend.dev>',
          to: email,
          subject: `${inviter[0]?.name || 'Quelqu un'} vous invite a rejoindre "${membership.name}"`,
          html: `
            <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
              <h2 style="color:#0b0f14;margin-bottom:16px;">Invitation a l'equipe ${membership.name}</h2>
              <p style="color:#666;font-size:14px;line-height:1.6;">
                ${inviter[0]?.name || 'Quelqu un'} vous invite a rejoindre son espace sur Personal Place.
                Creez un compte ou connectez-vous avec cet email pour accepter.
              </p>
              <a href="${inviteUrl}" style="display:inline-block;background:#2563EB;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;margin:16px 0;">
                Accepter l'invitation
              </a>
              <p style="color:#999;font-size:12px;margin-top:24px;">Lien valable ${INVITE_TTL_DAYS} jours.</p>
            </div>
          `,
        });
      } catch (e) {
        console.error('Invite email error:', e.message);
      }
    }

    res.status(201).json({ invitation: { email, role: inviteRole, expires_at: expiresAt }, inviteUrl });
  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Annuler une invitation
router.delete('/:id/invitations/:invId', auth, async (req, res) => {
  try {
    const membership = await getMembership(req.params.id, req.userId);
    if (!membership) return res.status(404).json({ error: 'Equipe introuvable' });
    if (!canManage(membership.role)) return res.status(403).json({ error: 'Action reservee aux administrateurs' });

    await sql`DELETE FROM team_invitations WHERE id = ${req.params.invId} AND team_id = ${req.params.id}`;
    res.json({ success: true });
  } catch (err) {
    console.error('Revoke invite error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Consulter une invitation (avant acceptation)
router.get('/invitations/:token', auth, async (req, res) => {
  try {
    const rows = await sql`
      SELECT i.email, i.role, i.expires_at, i.status, t.name AS team_name, t.id AS team_id
      FROM team_invitations i JOIN teams t ON t.id = i.team_id
      WHERE i.token = ${req.params.token}
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Invitation introuvable' });
    const inv = rows[0];
    if (inv.status !== 'pending') return res.status(400).json({ error: 'Cette invitation n\'est plus valide' });
    if (new Date(inv.expires_at) < new Date()) return res.status(400).json({ error: 'Invitation expiree' });
    res.json({ invitation: inv });
  } catch (err) {
    console.error('Get invite error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Accepter une invitation
router.post('/invitations/:token/accept', auth, async (req, res) => {
  try {
    const rows = await sql`
      SELECT i.id, i.email, i.role, i.status, i.expires_at, i.team_id, t.name AS team_name
      FROM team_invitations i JOIN teams t ON t.id = i.team_id
      WHERE i.token = ${req.params.token}
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Invitation introuvable' });
    const inv = rows[0];
    if (inv.status !== 'pending') return res.status(400).json({ error: 'Cette invitation n\'est plus valide' });
    if (new Date(inv.expires_at) < new Date()) return res.status(400).json({ error: 'Invitation expiree' });

    const me = await sql`SELECT email FROM users WHERE id = ${req.userId}`;
    if (me[0].email.toLowerCase() !== inv.email.toLowerCase()) {
      return res.status(403).json({ error: 'Cette invitation est adressee a ' + inv.email });
    }

    await sql`
      INSERT INTO team_members (team_id, user_id, role)
      VALUES (${inv.team_id}, ${req.userId}, ${inv.role})
      ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role
    `;
    await sql`UPDATE team_invitations SET status = 'accepted' WHERE id = ${inv.id}`;

    res.json({ team: { id: inv.team_id, name: inv.team_name }, role: inv.role });
  } catch (err) {
    console.error('Accept invite error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Modifier un role
router.put('/:id/members/:userId', auth, async (req, res) => {
  try {
    const membership = await getMembership(req.params.id, req.userId);
    if (!membership) return res.status(404).json({ error: 'Equipe introuvable' });
    if (membership.role !== 'owner') return res.status(403).json({ error: 'Seul le proprietaire peut changer les roles' });

    const { role } = req.body;
    if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Role invalide' });
    if (req.params.userId === membership.owner_id) return res.status(400).json({ error: 'Le role du proprietaire ne change pas' });

    const result = await sql`
      UPDATE team_members SET role = ${role}
      WHERE team_id = ${req.params.id} AND user_id = ${req.params.userId}
      RETURNING user_id, role
    `;
    if (result.length === 0) return res.status(404).json({ error: 'Membre introuvable' });
    res.json({ member: result[0] });
  } catch (err) {
    console.error('Update role error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Retirer un membre
router.delete('/:id/members/:userId', auth, async (req, res) => {
  try {
    const membership = await getMembership(req.params.id, req.userId);
    if (!membership) return res.status(404).json({ error: 'Equipe introuvable' });

    const isSelf = req.params.userId === req.userId;
    if (!isSelf && !canManage(membership.role)) {
      return res.status(403).json({ error: 'Action reservee aux administrateurs' });
    }
    if (req.params.userId === membership.owner_id) {
      return res.status(400).json({ error: 'Impossible de retirer le proprietaire' });
    }

    await sql`DELETE FROM team_members WHERE team_id = ${req.params.id} AND user_id = ${req.params.userId}`;
    res.json({ success: true });
  } catch (err) {
    console.error('Remove member error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Supprimer l'equipe (proprietaire)
router.delete('/:id', auth, async (req, res) => {
  try {
    const membership = await getMembership(req.params.id, req.userId);
    if (!membership) return res.status(404).json({ error: 'Equipe introuvable' });
    if (membership.owner_id !== req.userId) return res.status(403).json({ error: 'Seul le proprietaire peut supprimer l\'equipe' });

    await sql`UPDATE tasks SET team_id = NULL WHERE team_id = ${req.params.id}`;
    await sql`DELETE FROM teams WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (err) {
    console.error('Delete team error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
