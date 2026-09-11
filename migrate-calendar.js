require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function migrate() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS calendar_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(500) NOT NULL,
        date VARCHAR(10) NOT NULL,
        hour INTEGER NOT NULL,
        color VARCHAR(20) DEFAULT 'accent',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    console.log('Migration complete: calendar_events table created');
  } catch (err) {
    console.error('Migration error:', err);
  }
}

migrate();
