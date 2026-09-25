require('dotenv').config();
const express = require('express');
const authRoutes = require('./routes/auth');
const servicesRoutes = require('./routes/services');
const tasksRoutes = require('./routes/tasks');
const calendarRoutes = require('./routes/calendar');
const whatsappRoutes = require('./routes/whatsapp');
const teamsRoutes = require('./routes/teams');
const sql = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

// Auto-migrate: add phone_number_id column if missing + tables equipe
(async () => {
  try {
    await sql`ALTER TABLE connected_services ADD COLUMN IF NOT EXISTS phone_number_id VARCHAR(100)`;
    await sql`
      CREATE TABLE IF NOT EXISTS teams (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS team_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(20) DEFAULT 'member',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(team_id, user_id)
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS team_invitations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'member',
        invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
        token VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id)`;
    await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL`;
    await sql`CREATE INDEX IF NOT EXISTS idx_tasks_team ON tasks(team_id)`;
    console.log('Migration: schema ensured');
  } catch (err) {
    console.error('Migration error:', err.message);
  }
})();

const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''));

app.use((req, res, next) => {
  const origin = (req.headers.origin || '').replace(/\/+$/, '');
  console.log(`${req.method} ${req.url} origin=${origin}`);
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: '10mb', strict: false }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth', authRoutes);
app.use('/api/services', servicesRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/teams', teamsRoutes);

app.get('/api/health', async (req, res) => {
  try {
    await sql`SELECT 1`;
    res.json({ status: 'ok', db: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'ko', error: err.message });
  }
});

// 404 JSON pour toute route API inconnue
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Route introuvable' });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Erreur serveur' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});