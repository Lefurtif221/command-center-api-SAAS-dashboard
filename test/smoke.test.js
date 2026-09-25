const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
require('dotenv').config();

const PORT = process.env.TEST_PORT || 3999;
const BASE = `http://localhost:${PORT}`;
let child = null;

const uniq = () => Math.random().toString(36).slice(2, 10);
const ids = [];

async function api(pathname, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

async function waitForHealth(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* server pas encore pret */ }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('Serveur de test inaccessible');
}

before(async () => {
  child = spawn(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  await waitForHealth();
});

after(async () => {
  if (child) child.kill();
});

test('GET /api/health repond avec la DB', async () => {
  const { status, data } = await api('/api/health');
  assert.strictEqual(status, 200);
  assert.strictEqual(data.db, 'ok');
});

test('route API inconnue -> 404 JSON', async () => {
  const { status, data } = await api('/api/inexistant');
  assert.strictEqual(status, 404);
  assert.ok(data.error);
});

test('auth: signup, login, /me, route protegee', async () => {
  const email = `smoke-${uniq()}@test.local`;
  const created = await api('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Smoke Test', email, password: 'password123' },
  });
  assert.strictEqual(created.status, 201);
  assert.ok(created.data.token);
  const userId = created.data.user.id;
  ids.push(userId);

  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'password123' },
  });
  assert.strictEqual(login.status, 200);
  const token = login.data.token;

  const me = await api('/api/auth/me', { token });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.data.user.email, email);

  const noToken = await api('/api/auth/me');
  assert.strictEqual(noToken.status, 401);
});

test('auth: mauvais mot de passe -> 401', async () => {
  const res = await api('/api/auth/login', {
    method: 'POST',
    body: { email: `missing-${uniq()}@test.local`, password: 'nope' },
  });
  assert.strictEqual(res.status, 401);
});

test('taches: CRUD complet', async () => {
  const email = `smoke-${uniq()}@test.local`;
  const signup = await api('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Tasks User', email, password: 'password123' },
  });
  ids.push(signup.data.user.id);
  const token = signup.data.token;

  const create = await api('/api/tasks', {
    method: 'POST',
    token,
    body: { title: 'Tache smoke', priority: 'high' },
  });
  assert.strictEqual(create.status, 201);
  const id = create.data.task.id;

  const list = await api('/api/tasks', { token });
  assert.strictEqual(list.status, 200);
  assert.ok(list.data.tasks.some(t => t.id === id));

  const toggle = await api(`/api/tasks/${id}`, {
    method: 'PUT',
    token,
    body: { completed: true },
  });
  assert.strictEqual(toggle.status, 200);
  assert.strictEqual(toggle.data.task.completed, true);

  const del = await api(`/api/tasks/${id}`, { method: 'DELETE', token });
  assert.strictEqual(del.status, 200);

  const after = await api('/api/tasks', { token });
  assert.ok(!after.data.tasks.some(t => t.id === id));
});

test('equipes: creation, invitation, acceptation, partage de tache', async () => {
  const ownerEmail = `smoke-owner-${uniq()}@test.local`;
  const guestEmail = `smoke-guest-${uniq()}@test.local`;

  const owner = await api('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Owner', email: ownerEmail, password: 'password123' },
  });
  ids.push(owner.data.user.id);
  const guest = await api('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Guest', email: guestEmail, password: 'password123' },
  });
  ids.push(guest.data.user.id);

  const ownerToken = owner.data.token;
  const guestToken = guest.data.token;

  const createTeam = await api('/api/teams', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Equipe Smoke' },
  });
  assert.strictEqual(createTeam.status, 201);
  const teamId = createTeam.data.team.id;

  const invite = await api(`/api/teams/${teamId}/invitations`, {
    method: 'POST',
    token: ownerToken,
    body: { email: guestEmail, role: 'member' },
  });
  assert.strictEqual(invite.status, 201);
  assert.ok(invite.data.inviteUrl.includes('/team/invite?token='));
  const tokenInvite = invite.data.inviteUrl.split('token=')[1];

  // L'invitation est adressee a un autre email -> refusee
  const wrongUser = await api(`/api/teams/invitations/${tokenInvite}/accept`, {
    method: 'POST',
    token: ownerToken,
  });
  assert.strictEqual(wrongUser.status, 403);

  const accept = await api(`/api/teams/invitations/${tokenInvite}/accept`, {
    method: 'POST',
    token: guestToken,
  });
  assert.strictEqual(accept.status, 200);

  const details = await api(`/api/teams/${teamId}`, { token: guestToken });
  assert.strictEqual(details.status, 200);
  assert.strictEqual(details.data.members.length, 2);

  const shared = await api('/api/tasks', {
    method: 'POST',
    token: ownerToken,
    body: { title: 'Tache partagee', team_id: teamId },
  });
  assert.strictEqual(shared.status, 201);

  const guestTasks = await api('/api/tasks', { token: guestToken });
  const found = guestTasks.data.tasks.find(t => t.id === shared.data.task.id);
  assert.ok(found, 'le membre doit voir la tache partagee');
  assert.strictEqual(found.team_name, 'Equipe Smoke');

  // Un non-membre ne peut pas creer de tache dans l'equipe
  const outsiderEmail = `smoke-outsider-${uniq()}@test.local`;
  const outsider = await api('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Outsider', email: outsiderEmail, password: 'password123' },
  });
  ids.push(outsider.data.user.id);
  const blocked = await api('/api/tasks', {
    method: 'POST',
    token: outsider.data.token,
    body: { title: 'Intrus', team_id: teamId },
  });
  assert.strictEqual(blocked.status, 403);

  const delTeam = await api(`/api/teams/${teamId}`, { method: 'DELETE', token: ownerToken });
  assert.strictEqual(delTeam.status, 200);
});

test('nettoyage des comptes de test', async () => {
  const sql = require(path.join(__dirname, '..', 'db'));
  for (const id of ids) {
    await sql`DELETE FROM users WHERE id = ${id} AND email LIKE '%@test.local'`;
  }
  await sql`DELETE FROM users WHERE email LIKE 'smoke-%@test.local'`;
  assert.ok(true);
});
