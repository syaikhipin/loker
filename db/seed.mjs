// Creates a user + API key. Prints the raw key ONCE — store it; only the
// sha256 hash is kept in the database.
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool } from '../src/db.mjs';
import { hashKey } from '../src/auth.mjs';

export async function seedUser(db, email) {
  await db.query(
    `INSERT INTO users (id, email) VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING`,
    [randomUUID(), email],
  );
  const { rows } = await db.query(`SELECT id FROM users WHERE email = $1`, [email]);
  const userId = rows[0].id;
  const raw = 'cops_' + randomBytes(24).toString('hex');
  await db.query(
    `INSERT INTO api_keys (id, user_id, key_hash, name) VALUES ($1, $2, $3, 'seed')`,
    [randomUUID(), userId, hashKey(raw)],
  );
  return { userId, apiKey: raw };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const email = process.argv[2] ?? 'demo@example.com';
  const { userId, apiKey } = await seedUser(pool, email);
  console.log(`USER_ID=${userId}`);
  console.log(`API_KEY=${apiKey}`);
  await pool.end();
}
