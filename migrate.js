require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function main() {
  try {
    const r = await sql`SELECT 1 as test`;
    console.log('Connected OK:', r);
  } catch (e) {
    console.error('Connection failed:', e.message);
  }
}

async function migrate() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255),
        oauth_provider VARCHAR(50),
        oauth_id VARCHAR(255),
        initials VARCHAR(10),
        avatar_url TEXT,
        plan VARCHAR(20) DEFAULT 'free',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    console.log('Table users created');

    await sql`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_users_oauth ON users(oauth_provider, oauth_id)`;
    console.log('Indexes created');

    await sql`
      CREATE TABLE IF NOT EXISTS connected_services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        service_name VARCHAR(50) NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        token_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, service_name)
      )
    `;
    console.log('Table connected_services created');

    await sql`
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(500) NOT NULL,
        completed BOOLEAN DEFAULT FALSE,
        priority VARCHAR(20) DEFAULT 'medium',
        due_date DATE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    console.log('Table tasks created');

    await sql`
      CREATE TABLE IF NOT EXISTS investments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        symbol VARCHAR(20) NOT NULL,
        type VARCHAR(50) NOT NULL,
        quantity DECIMAL(18, 8) NOT NULL,
        buy_price DECIMAL(18, 2) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    console.log('Table investments created');

    console.log('All migrations done!');
  } catch (e) {
    console.error('Migration failed:', e.message);
  }
}

main().then(() => migrate());