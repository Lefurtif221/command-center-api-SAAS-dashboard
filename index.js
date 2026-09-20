require('dotenv').config();
const express = require('express');
const authRoutes = require('./routes/auth');
const servicesRoutes = require('./routes/services');
const tasksRoutes = require('./routes/tasks');
const calendarRoutes = require('./routes/calendar');
const whatsappRoutes = require('./routes/whatsapp');
const { sql } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

// Auto-migrate: add phone_number_id column if missing
(async () => {
  try {
    await sql`ALTER TABLE connected_services ADD COLUMN IF NOT EXISTS phone_number_id VARCHAR(100)`;
    console.log('Migration: phone_number_id column ensured');
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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Erreur serveur' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});