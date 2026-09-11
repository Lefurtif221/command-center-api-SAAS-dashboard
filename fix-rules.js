require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function fix() {
  await sql`ALTER TABLE email_rules DROP CONSTRAINT IF EXISTS email_rules_user_id_sender_key`;
  await sql`ALTER TABLE email_rules DROP CONSTRAINT IF EXISTS email_rules_sender_not_null`;
  await sql`ALTER TABLE email_rules ALTER COLUMN sender DROP NOT NULL`;
  await sql`ALTER TABLE email_rules ALTER COLUMN priority DROP NOT NULL`;
  console.log('Fixed email_rules constraints');
}

fix().catch(console.error);
