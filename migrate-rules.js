require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function migrate() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS email_rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        sender VARCHAR(255) NOT NULL,
        priority VARCHAR(20) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, sender)
      )
    `;
    console.log('Migration complete: email_rules table created');
  } catch (err) {
    console.error('Migration error:', err);
  }
}

migrate();
