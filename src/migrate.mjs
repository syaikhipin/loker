// Applies db/schema.sql on boot. All statements are IF NOT EXISTS, so this
// is idempotent and safe to run from every service on every start.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, '..', 'db', 'schema.sql');

export async function migrate(db) {
  const sql = readFileSync(schemaPath, 'utf8');
  await db.query(sql);
}
