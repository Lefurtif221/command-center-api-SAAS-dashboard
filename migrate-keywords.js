require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function migrate() {
  try {
    await sql`ALTER TABLE email_rules ADD COLUMN IF NOT EXISTS keyword VARCHAR(255)`;
    console.log('Migration complete: keyword column added');
  } catch (err) {
    console.error('Migration error:', err);
  }
}

migrate();
