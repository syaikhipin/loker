// career-ops-saas worker: claims queued jobs, syncs the user's data dir
// from S3 to a temp dir, runs the career-ops script with CAREER_OPS_ROOT
// pointed at it, syncs the result back to S3, records the outcome.
//
// Per-user serialization: an in-memory set of busy users (single worker).
// If you run multiple workers, replace with:
//   SELECT pg_try_advisory_xact_lock(hashtext(user_id)) ...
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pool } from '../src/db.mjs';
import { config } from '../src/config.mjs';
import { migrate } from '../src/migrate.mjs';
import { downloadUserDir, uploadUserDir, ensureBucket } from '../src/s3.mjs';
import { runCareerOpsScript } from '../src/runner.mjs';

const busyUsers = new Set();
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

async function claimJob() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 5 FOR UPDATE SKIP LOCKED`,
    );
    const job = rows.find((j) => !busyUsers.has(j.user_id));
    if (!job) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(`UPDATE jobs SET status = 'running', started_at = now() WHERE id = $1`, [job.id]);
    await client.query('COMMIT');
    return job;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

async function processJob(job) {
  busyUsers.add(job.user_id);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cops-job-'));
  try {
    const filesDownloaded = await downloadUserDir(job.user_id, tmp);
    const { script, args } = job.payload;
    const res = await runCareerOpsScript({ script, args, dataRoot: tmp });
    const up = await uploadUserDir(job.user_id, tmp);
    const ok = res.exitCode === 0 && !res.timedOut;
    await pool.query(
      `UPDATE jobs SET status = $2, finished_at = now(), result = $3, error = $4 WHERE id = $1`,
      [
        job.id,
        ok ? 'done' : 'error',
        {
          exitCode: res.exitCode,
          timedOut: res.timedOut,
          filesDownloaded,
          filesUploaded: up.count,
          filesSkipped: up.skipped,
          stdout: res.stdout.slice(-4000),
          stderr: res.stderr.slice(-4000),
        },
        ok ? null : (res.timedOut ? 'timeout; ' : '') + res.stderr.slice(-500),
      ],
    );
    console.log(`[worker] job ${job.id} -> ${ok ? 'done' : 'error'} (exit ${res.exitCode})`);
  } catch (e) {
    console.error(`[worker] job ${job.id} crashed:`, e.message);
    await pool.query(
      `UPDATE jobs SET status = 'error', finished_at = now(), error = $2 WHERE id = $1`,
      [job.id, String(e.message).slice(0, 1000)],
    );
  } finally {
    busyUsers.delete(job.user_id);
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  console.log('[worker] starting');
  await migrate(pool);
  console.log('[worker] schema ready');
  await ensureBucket();
  while (!stopping) {
    try {
      const job = await claimJob();
      if (job) {
        console.log(`[worker] claimed ${job.id} (${job.type})`);
        await processJob(job);
      } else {
        await new Promise((r) => setTimeout(r, config.pollIntervalMs));
      }
    } catch (e) {
      console.error('[worker] loop error:', e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.log('[worker] stopping');
  await pool.end();
}

main();
