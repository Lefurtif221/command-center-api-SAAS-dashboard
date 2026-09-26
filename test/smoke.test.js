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
    env: { ...process.env, PORT: String(PORT), ADMIN_EMAILS: 'smoke-admin@test.local' },
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

test('gmail: plusieurs comptes distincts, suppression par compte', async () => {
  const sql = require(path.join(__dirname, '..', 'db'));
  const email = `smoke-${uniq()}@test.local`;
  const signup = await api('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Mail User', email, password: 'password123' },
  });
  ids.push(signup.data.user.id);
  const token = signup.data.token;
  const userId = signup.data.user.id;

  const empty = await api('/api/services', { token });
  assert.strictEqual(empty.status, 200);
  assert.deepStrictEqual(empty.data.gmailAccounts, []);
  assert.ok(!empty.data.services.includes('gmail'));

  // Deux comptes Gmail simules (aucun appel a Google dans les tests)
  await sql`
    INSERT INTO connected_services (user_id, service_name, access_token, account_key, account_email)
    VALUES (${userId}, 'gmail', 'tok-a', 'a@x.test', 'a@x.test'),
           (${userId}, 'gmail', 'tok-b', 'b@x.test', 'b@x.test')
  `;

  const list = await api('/api/services', { token });
  assert.strictEqual(list.status, 200);
  assert.ok(list.data.services.includes('gmail'));
  assert.strictEqual(list.data.gmailAccounts.length, 2);
  assert.deepStrictEqual(
    list.data.gmailAccounts.map(a => a.email).sort(),
    ['a@x.test', 'b@x.test']
  );

  const del = await api('/api/services/gmail?account_key=a@x.test', { method: 'DELETE', token });
  assert.strictEqual(del.status, 200);

  const after = await api('/api/services', { token });
  assert.strictEqual(after.data.gmailAccounts.length, 1);
  assert.strictEqual(after.data.gmailAccounts[0].email, 'b@x.test');

  await sql`DELETE FROM connected_services WHERE user_id = ${userId}`;
});

test('formule gratuite : 1 equipe max, 3 membres max, puis liberations en pro', async () => {
  const sql = require(path.join(__dirname, '..', 'db'));
  const ownerEmail = `smoke-plan-${uniq()}@test.local`;
  const owner = await api('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Plan Owner', email: ownerEmail, password: 'password123' },
  });
  ids.push(owner.data.user.id);
  const ownerToken = owner.data.token;
  const ownerId = owner.data.user.id;

  // Quotas exposes par l'API
  const list0 = await api('/api/teams', { token: ownerToken });
  assert.strictEqual(list0.data.plan, 'free');
  assert.strictEqual(list0.data.limits.teams, 1);
  assert.strictEqual(list0.data.limits.teamMembers, 3);

  // 1 equipe OK, la 2e est refusee (402)
  const team1 = await api('/api/teams', { method: 'POST', token: ownerToken, body: { name: 'Equipe Free' } });
  assert.strictEqual(team1.status, 201);
  const team2 = await api('/api/teams', { method: 'POST', token: ownerToken, body: { name: 'Trop d equipes' } });
  assert.strictEqual(team2.status, 402);
  assert.strictEqual(team2.data.code, 'PLAN_REQUIRED');

  // 2 invitations acceptees (owner + 1) puis 3e bloque : 3 membres max
  const g1 = `smoke-plan-g1-${uniq()}@test.local`;
  const g2 = `smoke-plan-g2-${uniq()}@test.local`;
  const g3 = `smoke-plan-g3-${uniq()}@test.local`;
  for (const g of [g1, g2, g3]) {
    const u = await api('/api/auth/signup', { method: 'POST', body: { name: 'Guest', email: g, password: 'password123' } });
    ids.push(u.data.user.id);
  }

  const inv1 = await api(`/api/teams/${team1.data.team.id}/invitations`, { method: 'POST', token: ownerToken, body: { email: g1 } });
  assert.strictEqual(inv1.status, 201);
  const inv2 = await api(`/api/teams/${team1.data.team.id}/invitations`, { method: 'POST', token: ownerToken, body: { email: g2 } });
  assert.strictEqual(inv2.status, 201);
  const inv3 = await api(`/api/teams/${team1.data.team.id}/invitations`, { method: 'POST', token: ownerToken, body: { email: g3 } });
  assert.strictEqual(inv3.status, 402);
  assert.strictEqual(inv3.data.code, 'PLAN_REQUIRED');

  // Passage en Pro : les quotas montent
  await sql`UPDATE users SET plan = 'pro' WHERE id = ${ownerId}`;
  const listPro = await api('/api/teams', { token: ownerToken });
  assert.strictEqual(listPro.data.plan, 'pro');
  assert.strictEqual(listPro.data.limits.teams, 7);
  assert.strictEqual(listPro.data.limits.teamMembers, 10);

  const team3 = await api('/api/teams', { method: 'POST', token: ownerToken, body: { name: 'Equipe Pro' } });
  assert.strictEqual(team3.status, 201);
  const invPro = await api(`/api/teams/${team1.data.team.id}/invitations`, { method: 'POST', token: ownerToken, body: { email: g3 } });
  assert.strictEqual(invPro.status, 201);

  // Passage en Entreprise : palier maximal
  await sql`UPDATE users SET plan = 'entreprise' WHERE id = ${ownerId}`;
  const listEnt = await api('/api/teams', { token: ownerToken });
  assert.strictEqual(listEnt.data.plan, 'entreprise');
  assert.strictEqual(listEnt.data.limits.teams, 20);
  assert.strictEqual(listEnt.data.limits.teamMembers, 50);
  assert.strictEqual(listEnt.data.limits.focusDays, 365);

  await api(`/api/teams/${team1.data.team.id}`, { method: 'DELETE', token: ownerToken });
  await api(`/api/teams/${team3.data.team.id}`, { method: 'DELETE', token: ownerToken });
  await sql`UPDATE users SET plan = 'free' WHERE id = ${ownerId}`;
});

test('stats : sessions de focus, historique gratuit 7 jours, compte admin en Entreprise', async () => {
  const email = `smoke-stats-${uniq()}@test.local`;
  const signup = await api('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Stats User', email, password: 'password123' },
  });
  assert.strictEqual(signup.status, 201);
  ids.push(signup.data.user.id);
  const token = signup.data.token;

  const anon = await api('/api/stats/overview');
  assert.strictEqual(anon.status, 401);

  const tooShort = await api('/api/stats/focus', {
    method: 'POST', token, body: { duration_seconds: 10 },
  });
  assert.strictEqual(tooShort.status, 400);

  const saved = await api('/api/stats/focus', {
    method: 'POST', token, body: { duration_seconds: 1500, task_title: 'Deep work' },
  });
  assert.strictEqual(saved.status, 201);

  // Formule gratuite : demande 30 jours, le serveur borne a 7
  const free = await api('/api/stats/overview?days=30', { token });
  assert.strictEqual(free.status, 200);
  assert.strictEqual(free.data.plan, 'free');
  assert.strictEqual(free.data.limitDays, 7);
  assert.strictEqual(free.data.days, 7);
  assert.strictEqual(free.data.clamped, true);
  assert.strictEqual(free.data.focus.length, 7);
  assert.strictEqual(free.data.tasks.length, 7);
  assert.strictEqual(free.data.totals.sessions, 1);
  assert.strictEqual(free.data.totals.focusMinutes, 25);
  assert.strictEqual(free.data.streak, 1);

  // Tache terminee : comptee dans l'historique
  const created = await api('/api/tasks', { method: 'POST', token, body: { title: 'A rendre' } });
  const done = await api(`/api/tasks/${created.data.task.id}`, { method: 'PUT', token, body: { completed: true } });
  assert.strictEqual(done.status, 200);
  const withTask = await api('/api/stats/overview', { token });
  assert.strictEqual(withTask.data.totals.tasksDone, 1);

  // Compte administrataire (ADMIN_EMAILS) : formule Entreprise sans paiement
  const adminEmail = 'smoke-admin@test.local';
  let adminUser;
  let adminToken;
  const admin = await api('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Admin Test', email: adminEmail, password: 'password123' },
  });
  if (admin.status === 201) {
    adminUser = admin.data.user;
    adminToken = admin.data.token;
    ids.push(adminUser.id);
  } else {
    // Compte deja cree par un passage precedent : on se connecte
    const adminLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { email: adminEmail, password: 'password123' },
    });
    assert.strictEqual(adminLogin.status, 200);
    adminUser = adminLogin.data.user;
    adminToken = adminLogin.data.token;
  }
  assert.strictEqual(adminUser.plan, 'entreprise');

  const adminTeams = await api('/api/teams', { token: adminToken });
  assert.strictEqual(adminTeams.data.plan, 'entreprise');
  assert.strictEqual(adminTeams.data.limits.teams, 20);

  const adminStats = await api('/api/stats/overview?days=30', { token: adminToken });
  assert.strictEqual(adminStats.data.plan, 'entreprise');
  assert.strictEqual(adminStats.data.limitDays, 365);
  assert.strictEqual(adminStats.data.clamped, false);
  assert.strictEqual(adminStats.data.focus.length, 30);
});

test('paiement : init retourne le guichet (ou 503 sans identifiants), abonnement et webhook', async () => {
  const email = `smoke-pay-${uniq()}@test.local`;
  const signup = await api('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Pay User', email, password: 'password123' },
  });
  assert.strictEqual(signup.status, 201);
  ids.push(signup.data.user.id);
  const token = signup.data.token;

  const init = await api('/api/pay/init', { method: 'POST', token, body: { plan: 'pro' } });
  if (init.status === 200) {
    // Identifiants valides et IP whitelistee : on recoit l'URL du guichet
    assert.ok(init.data.payment_url, 'payment_url attendu');
    assert.ok(init.data.transaction_id, 'transaction_id attendu');
    assert.strictEqual(init.data.amount, 2000);
    assert.strictEqual(init.data.currency, 'XOF');
    assert.strictEqual(init.data.plan, 'pro');

    // Palier Entreprise : tarif unique 7500 FCFA
    const ent = await api('/api/pay/init', { method: 'POST', token, body: { plan: 'entreprise' } });
    assert.strictEqual(ent.status, 200);
    assert.strictEqual(ent.data.amount, 7500);
    assert.strictEqual(ent.data.plan, 'entreprise');
    assert.strictEqual(ent.data.currency, 'XOF');

    // Formule inconnue refusee
    const bad = await api('/api/pay/init', { method: 'POST', token, body: { plan: 'inconnu' } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.data.code, 'OFFER_UNKNOWN');
  } else {
    // Pas de credentiels, ou IP de l environnement non whitelistee chez CinetPay
    assert.strictEqual(init.status, 503);
    assert.strictEqual(init.data.code, 'PAY_NOT_CONFIGURED');
  }

  const sub = await api('/api/pay/subscription', { token });
  assert.strictEqual(sub.status, 200);
  assert.strictEqual(sub.data.plan, 'free');
  assert.strictEqual(sub.data.subscription, null);

  const status = await api('/api/pay/status?transaction_id=inconnu', { token });
  assert.strictEqual(status.status, 404);

  // Le webhook est publique et ne doit jamais echouer
  const notify = await api('/api/pay/notify', { method: 'POST', body: {} });
  assert.strictEqual(notify.status, 200);

  if (init.status === 200) {
    // Deuxieme mois : l utilisateur a deja un abonnement actif -> tarif mensuel 2500
    const sql = require(path.join(__dirname, '..', 'db'));
    await sql`
      INSERT INTO subscriptions (user_id, plan, status, provider, provider_tx_id, amount, currency, period_days, expires_at)
      VALUES (${signup.data.user.id}, 'pro', 'active', 'cinetpay', ${'pp' + Date.now() + 'renew'},
              2500, 'XOF', 31, ${new Date(Date.now() + 31 * 86400000).toISOString()})
    `;
    const renew = await api('/api/pay/init', { method: 'POST', token, body: { plan: 'pro' } });
    assert.strictEqual(renew.status, 200);
    assert.strictEqual(renew.data.amount, 2500);
    assert.strictEqual(renew.data.first_month, false);
  }
});

test('nettoyage des comptes de test', async () => {
  const sql = require(path.join(__dirname, '..', 'db'));
  for (const id of ids) {
    await sql`DELETE FROM users WHERE id = ${id} AND email LIKE '%@test.local'`;
  }
  await sql`DELETE FROM users WHERE email LIKE 'smoke-%@test.local'`;
  assert.ok(true);
});
