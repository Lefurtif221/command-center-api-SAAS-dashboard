const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
require('dotenv').config();
const sql = require('../db');

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

// Inscription complete : signup -> code en DB -> verification -> token
async function signupUser(name, email, password = 'password123') {
  const created = await api('/api/auth/signup', {
    method: 'POST',
    body: { name, email, password },
  });
  assert.strictEqual(created.status, 201);
  assert.ok(created.data.needsVerification, 'signup doit demander la verification email');
  const rows = await sql`
    SELECT c.code FROM email_verification_codes c
    JOIN users u ON u.id = c.user_id
    WHERE u.email = ${email}
    ORDER BY c.created_at DESC
    LIMIT 1
  `;
  assert.strictEqual(rows.length, 1, 'code de verification cree');
  const verified = await api('/api/auth/verify-email', {
    method: 'POST',
    body: { email, code: rows[0].code },
  });
  assert.strictEqual(verified.status, 200);
  assert.ok(verified.data.token);
  return { data: verified.data };
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

test('auth: signup, verification, login, /me, route protegee', async () => {
  const email = `smoke-${uniq()}@test.local`;
  const created = await signupUser('Smoke Test', email);
  ids.push(created.data.user.id);

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

test('auth: email mal ecrit refuse a l inscription', async () => {
  const { isValidEmail } = require('../lib/email-format');
  assert.strictEqual(isValidEmail('prenom@famille.com'), true);
  assert.strictEqual(isValidEmail('user@site.fr'), true);
  assert.strictEqual(isValidEmail('a@b.local'), true);
  assert.strictEqual(isValidEmail('x@gmail.col'), false);
  assert.strictEqual(isValidEmail('pas-de-at.com'), false);
  assert.strictEqual(isValidEmail('a b@c.com'), false);
  assert.strictEqual(isValidEmail('deux@@c.com'), false);
  assert.strictEqual(isValidEmail(''), false);

  const bad = await api('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Bad Email', email: `bad-${uniq()}@gmail.col`, password: 'password123' },
  });
  assert.strictEqual(bad.status, 400);
  assert.ok(/invalide/i.test(bad.data.error), `message attendu, recu: ${bad.data.error}`);
});

test('auth: code incorrect refuse, login bloque avant verification', async () => {
  const email = `smoke-otp-${uniq()}@test.local`;
  const created = await api('/api/auth/signup', {
    method: 'POST',
    body: { name: 'OTP Test', email, password: 'password123' },
  });
  assert.strictEqual(created.status, 201);
  assert.ok(created.data.needsVerification);

  const blocked = await api('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'password123' },
  });
  assert.strictEqual(blocked.status, 403);
  assert.strictEqual(blocked.data.needsVerification, true);
  assert.strictEqual(blocked.data.email, email);

  const wrong = await api('/api/auth/verify-email', {
    method: 'POST',
    body: { email, code: '000000' },
  });
  assert.strictEqual(wrong.status, 400);

  const rows = await sql`
    SELECT c.code FROM email_verification_codes c
    JOIN users u ON u.id = c.user_id
    WHERE u.email = ${email}
    ORDER BY c.created_at DESC
    LIMIT 1
  `;
  const verified = await api('/api/auth/verify-email', {
    method: 'POST',
    body: { email, code: rows[0].code },
  });
  assert.strictEqual(verified.status, 200);
  ids.push(verified.data.user.id);

  const resend = await api('/api/auth/resend-code', { method: 'POST', body: { email } });
  assert.strictEqual(resend.status, 200);

  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'password123' },
  });
  assert.strictEqual(login.status, 200);
});

test('taches: CRUD complet', async () => {
  const email = `smoke-${uniq()}@test.local`;
  const signup = await signupUser('Tasks User', email);
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

  const owner = await signupUser('Owner', ownerEmail);
  ids.push(owner.data.user.id);
  const guest = await signupUser('Guest', guestEmail);
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
  const outsider = await signupUser('Outsider', outsiderEmail);
  ids.push(outsider.data.user.id);
  const blocked = await api('/api/tasks', {
    method: 'POST',
    token: outsider.data.token,
    body: { title: 'Intrus', team_id: teamId },
  });
  assert.strictEqual(blocked.status, 403);

  // Chat de l'equipe : le membre ecrit, l'exterieur est bloque
  const postMsg = await api(`/api/teams/${teamId}/messages`, {
    method: 'POST',
    token: guestToken,
    body: { content: 'Bonjour tout le monde' },
  });
  assert.strictEqual(postMsg.status, 201);
  const getMsgs = await api(`/api/teams/${teamId}/messages`, { token: ownerToken });
  assert.strictEqual(getMsgs.status, 200);
  assert.strictEqual(getMsgs.data.messages.length, 1);
  assert.strictEqual(getMsgs.data.messages[0].content, 'Bonjour tout le monde');
  const msgOutsider = await api(`/api/teams/${teamId}/messages`, {
    method: 'POST',
    token: outsider.data.token,
    body: { content: 'Intrus' },
  });
  assert.strictEqual(msgOutsider.status, 404);

  // Emploi du temps : seul l'admin ecrit, le membre consulte
  const week = '2026-09-21';
  const schedByMember = await api(`/api/teams/${teamId}/schedule`, {
    method: 'POST',
    token: guestToken,
    body: { week, day: 0, start_minute: 540, end_minute: 600, label: 'Standup' },
  });
  assert.strictEqual(schedByMember.status, 403);
  const sched = await api(`/api/teams/${teamId}/schedule`, {
    method: 'POST',
    token: ownerToken,
    body: { week, day: 0, start_minute: 540, end_minute: 600, label: 'Standup', color: 'green' },
  });
  assert.strictEqual(sched.status, 201);
  const getSched = await api(`/api/teams/${teamId}/schedule?week=${week}`, { token: guestToken });
  assert.strictEqual(getSched.status, 200);
  assert.strictEqual(getSched.data.entries.length, 1);
  assert.strictEqual(getSched.data.entries[0].label, 'Standup');
  const updSched = await api(`/api/teams/${teamId}/schedule/${sched.data.entry.id}`, {
    method: 'PUT',
    token: ownerToken,
    body: { week, day: 2, start_minute: 600, end_minute: 660, label: 'Point hebdo', color: 'violet' },
  });
  assert.strictEqual(updSched.status, 200);
  assert.strictEqual(updSched.data.entry.label, 'Point hebdo');
  const delSched = await api(`/api/teams/${teamId}/schedule/${sched.data.entry.id}`, {
    method: 'DELETE',
    token: ownerToken,
  });
  assert.strictEqual(delSched.status, 200);

  const delTeam = await api(`/api/teams/${teamId}`, { method: 'DELETE', token: ownerToken });
  assert.strictEqual(delTeam.status, 200);
});

test('gmail: plusieurs comptes distincts, suppression par compte', async () => {
  const sql = require(path.join(__dirname, '..', 'db'));
  const email = `smoke-${uniq()}@test.local`;
  const signup = await signupUser('Mail User', email);
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
  const owner = await signupUser('Plan Owner', ownerEmail);
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
    const u = await signupUser('Guest', g);
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
  const signup = await signupUser('Stats User', email);
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
  try {
    const admin = await signupUser('Admin Test', adminEmail);
    adminUser = admin.data.user;
    adminToken = admin.data.token;
    ids.push(adminUser.id);
  } catch {
    // Compte deja cree et verifie par un passage precedent : on se connecte
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
  const signup = await signupUser('Pay User', email);
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

test('auth: email indisponible -> compte active sans verification', async () => {
  // Serveur dedie qui simule une panne de l email (Resend sans domaine verifie)
  const fallbackPort = Number(PORT) + 1;
  const fallbackBase = `http://localhost:${fallbackPort}`;
  const child2 = spawn(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(fallbackPort), RESEND_SIMULATE_FAILURE: '1', ADMIN_EMAILS: 'smoke-admin@test.local' },
    stdio: 'ignore',
  });
  try {
    const start = Date.now();
    let ready = false;
    while (Date.now() - start < 30000) {
      try {
        const res = await fetch(`${fallbackBase}/api/health`);
        if (res.ok) { ready = true; break; }
      } catch { /* pas encore pret */ }
      await new Promise(r => setTimeout(r, 400));
    }
    assert.ok(ready, 'serveur fallback inaccessible');

    const email = `fallback-${uniq()}@test.local`;
    const created = await fetch(`${fallbackBase}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Fallback Test', email, password: 'password123' }),
    }).then(r => r.json());

    assert.ok(created.token, 'le compte doit etre connecte directement');
    assert.strictEqual(created.needsVerification, undefined);
    ids.push(created.user.id);

    const rows = await sql`SELECT email_verified FROM users WHERE email = ${email}`;
    assert.strictEqual(rows[0].email_verified, true, 'compte active malgre l email indisponible');

    const login = await fetch(`${fallbackBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123' }),
    }).then(r => r.json());
    assert.ok(login.token, 'login direct sans blocage');
  } finally {
    child2.kill();
  }
});

test('calendrier : blocs debut/fin, mise a jour, suppression', async () => {
  const email = `smoke-cal-${uniq()}@test.local`;
  const signup = await signupUser('Cal User', email);
  ids.push(signup.data.user.id);
  const token = signup.data.token;

  // Bloc avec debut/fin en minutes (style emploi du temps)
  const created = await api('/api/calendar', {
    method: 'POST',
    token,
    body: { title: 'Bloc focus', date: '2026-09-30', start_minute: 540, end_minute: 615, color: 'success' },
  });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.data.event.start_minute, 540);
  assert.strictEqual(created.data.event.end_minute, 615);
  assert.strictEqual(created.data.event.hour, 9);
  const id = created.data.event.id;

  // Plusieurs blocs le meme jour (y compris qui se chevauchent)
  const second = await api('/api/calendar', {
    method: 'POST',
    token,
    body: { title: 'Point rapide', date: '2026-09-30', start_minute: 570, end_minute: 600 },
  });
  assert.strictEqual(second.status, 201);

  // Ancien format heure seule : conserve pour compatibilite
  const legacy = await api('/api/calendar', {
    method: 'POST',
    token,
    body: { title: 'Legacy', date: '2026-10-01', hour: 14 },
  });
  assert.strictEqual(legacy.status, 201);
  assert.strictEqual(legacy.data.event.start_minute, 840);
  assert.strictEqual(legacy.data.event.end_minute, 900);

  // Fin apres debut obligatoire
  const bad = await api('/api/calendar', {
    method: 'POST',
    token,
    body: { title: 'Invalide', date: '2026-09-30', start_minute: 600, end_minute: 540 },
  });
  assert.strictEqual(bad.status, 400);

  const list = await api('/api/calendar', { token });
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.data.events.filter(e => e.date === '2026-09-30').length, 2);

  const upd = await api(`/api/calendar/${id}`, {
    method: 'PUT',
    token,
    body: { title: 'Bloc focus modifie', date: '2026-09-30', start_minute: 600, end_minute: 720, color: 'purple' },
  });
  assert.strictEqual(upd.status, 200);
  assert.strictEqual(upd.data.event.title, 'Bloc focus modifie');
  assert.strictEqual(upd.data.event.end_minute, 720);

  const del = await api(`/api/calendar/${id}`, { method: 'DELETE', token });
  assert.strictEqual(del.status, 200);
  const after = await api('/api/calendar', { token });
  assert.ok(!after.data.events.some(e => e.id === id));
});

test('retours : enregistrement valide, validations refusees', async () => {
  const email = `smoke-fb-${uniq()}@test.local`;
  const signup = await signupUser('Feedback User', email);
  ids.push(signup.data.user.id);
  const token = signup.data.token;

  const anon = await api('/api/feedback', { method: 'POST', body: { message: 'anon' } });
  assert.strictEqual(anon.status, 401);

  const created = await api('/api/feedback', {
    method: 'POST',
    token,
    body: { category: 'bug', message: 'Le calendrier reste bloque sur la semaine passee', page: 'calendar' },
  });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.data.feedback.category, 'bug');

  // Categorie inconnue -> other ; message vide -> refuse ; trop long -> refuse
  const fallback = await api('/api/feedback', { method: 'POST', token, body: { category: 'zzz', message: 'ok' } });
  assert.strictEqual(fallback.status, 201);
  assert.strictEqual(fallback.data.feedback.category, 'other');

  const empty = await api('/api/feedback', { method: 'POST', token, body: { message: '   ' } });
  assert.strictEqual(empty.status, 400);

  const long = await api('/api/feedback', { method: 'POST', token, body: { message: 'x'.repeat(2001) } });
  assert.strictEqual(long.status, 400);
});

test('parrainage : code, attach une fois, refus des cas invalides', async () => {
  const parrainEmail = `smoke-ref-p-${uniq()}@test.local`;
  const parrain = await signupUser('Parrain Test', parrainEmail);
  ids.push(parrain.data.user.id);
  const parrainToken = parrain.data.token;

  const inviteEmail = `smoke-ref-i-${uniq()}@test.local`;
  const invite = await signupUser('Invite Test', inviteEmail);
  ids.push(invite.data.user.id);
  const inviteToken = invite.data.token;

  const anon = await api('/api/me/referral');
  assert.strictEqual(anon.status, 401);

  // Le code est cree au premier appel, 6 caracteres sans caracteres ambigus
  const mine = await api('/api/me/referral', { token: parrainToken });
  assert.strictEqual(mine.status, 200);
  assert.ok(/^[A-Z2-9]{6}$/.test(mine.data.code), `code invalide: ${mine.data.code}`);

  const again = await api('/api/me/referral', { token: parrainToken });
  assert.strictEqual(again.data.code, mine.data.code);

  // Ref inconnu -> ignore sans erreur
  const unknown = await api('/api/me/referral/attach', { method: 'POST', token: inviteToken, body: { ref: 'ZZZZZZ' } });
  assert.strictEqual(unknown.status, 200);
  assert.strictEqual(unknown.data.attached, false);

  // L'invite rattache le parrain
  const attached = await api('/api/me/referral/attach', { method: 'POST', token: inviteToken, body: { ref: mine.data.code } });
  assert.strictEqual(attached.status, 200);
  assert.strictEqual(attached.data.attached, true);

  // Une seule attribution : une deuxieme tentative ne change rien
  const second = await api('/api/me/referral/attach', { method: 'POST', token: inviteToken, body: { ref: mine.data.code } });
  assert.strictEqual(second.data.attached, false);

  // Son propre code ne compte pas
  const self = await api('/api/me/referral/attach', { method: 'POST', token: parrainToken, body: { ref: mine.data.code } });
  assert.strictEqual(self.data.attached, false);
});

test('nettoyage des comptes de test', async () => {
  const sql = require(path.join(__dirname, '..', 'db'));
  for (const id of ids) {
    await sql`DELETE FROM users WHERE id = ${id} AND email LIKE '%@test.local'`;
  }
  await sql`DELETE FROM users WHERE email LIKE 'smoke-%@test.local'`;
  assert.ok(true);
});
