// Applies db/schema.sql on boot. All statements are IF NOT EXISTS, so this
// is idempotent and safe to run from every service on every start.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, '..', 'db', 'schema.sql');

export async function migrate(db) {
  const sql = readFileSync(schemaPath, 'utf8');
  await db.query(sql);
  await seedFromEnv(db);
}

// One-time first-user seed. Set SEED_EMAIL + SEED_API_KEY_HASH (sha256 hex
// of the raw key, same as db/seed.mjs stores) to create a user + API key on
// boot. Idempotent (ON CONFLICT DO NOTHING). Remove the env vars after the
// first successful boot; the raw key is shown to its owner exactly once,
// outside this process.
export async function seedFromEnv(db) {
  const email = process.env.SEED_EMAIL;
  const keyHash = process.env.SEED_API_KEY_HASH;
  if (!email || !keyHash) return false;
  await db.query(
    `INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING`,
    [randomUUID(), email],
  );
  const { rows } = await db.query(`SELECT id FROM users WHERE email = $1`, [email]);
  await db.query(
    `INSERT INTO api_keys (id, user_id, key_hash, name) VALUES ($1, $2, $3, 'seed')
     ON CONFLICT (key_hash) DO NOTHING`,
    [randomUUID(), rows[0].id, keyHash],
  );
  console.log(`[seed] ensured user ${email}`);
  return true;
}
