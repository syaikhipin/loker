// Render cron entrypoint: enqueue one scan job per user with scan_enabled.
// Runs on a schedule (e.g. daily); the worker picks the jobs up.
import { randomUUID } from 'node:crypto';
import { pool } from '../src/db.mjs';

const { rows } = await pool.query(`SELECT id FROM users WHERE scan_enabled = true`);
for (const u of rows) {
  const { rows: pending } = await pool.query(
    `SELECT 1 FROM jobs WHERE user_id = $1 AND type = 'scan' AND status IN ('queued','running') LIMIT 1`,
    [u.id],
  );
  if (pending.length) {
    console.log(`[trigger-scans] skip ${u.id}: scan already pending`);
    continue;
  }
  await pool.query(
    `INSERT INTO jobs (id, user_id, type, payload) VALUES ($1, $2, 'scan', $3)`,
    [randomUUID(), u.id, { script: 'scan.mjs', args: [] }],
  );
  console.log(`[trigger-scans] enqueued scan for ${u.id}`);
}
await pool.end();
