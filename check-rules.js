require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function check() {
  const constraints = await sql`SELECT conname, contype FROM pg_constraint WHERE conrelid = 'email_rules'::regclass`;
  console.log('Constraints:', JSON.stringify(constraints, null, 2));
  
  const columns = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'email_rules'`;
  console.log('Columns:', JSON.stringify(columns, null, 2));
}

check().catch(console.error);
