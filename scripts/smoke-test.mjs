// Black-box end-to-end test. Uses REAL Postgres, REAL S3 API (s3rver), REAL
// API + worker child processes, and a REAL career-ops script.
//
// Required env:
//   TEST_DATABASE_URL   e.g. postgresql://postgres@127.0.0.1:5432/cops_test
//   S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
//   S3_FORCE_PATH_STYLE, CAREER_OPS_HOME
// Optional: API_PORT (default 3210)
//
// What it proves:
//   1. auth works (401 without key, 400 on path traversal)
//   2. POST /jobs -> 202, worker claims it (FOR UPDATE SKIP LOCKED)
//   3. worker syncs the user's S3 dir down, runs the script with
//      CAREER_OPS_ROOT pointed at it (proven: the repo checkout itself has
//      no config/profile.yml, so exit 0 means the fixture was used)
//   4. worker syncs back up, skipping *.sqlite* (derived index, never stored)
//   5. GET /jobs/:id reports done with the script's real exit code
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const API_PORT = process.env.API_PORT ?? '3210';
const S3RVER_PORT = process.env.S3RVER_PORT ?? '9000';

// Self-contained S3: boot s3rver unless the caller points at a real endpoint.
// Defaults are applied before the required-env check below.
if (!process.env.SMOKE_EXTERNAL_S3) {
  process.env.S3_ENDPOINT ??= `http://127.0.0.1:${S3RVER_PORT}`;
  process.env.S3_FORCE_PATH_STYLE ??= 'true';
  process.env.S3_ACCESS_KEY_ID ??= 'S3RVER';      // s3rver's built-in keypair
  process.env.S3_SECRET_ACCESS_KEY ??= 'S3RVER';
} else if (!process.env.S3_ENDPOINT) {
  console.error('smoke: SMOKE_EXTERNAL_S3 set but S3_ENDPOINT missing');
  process.exit(2);
}

for (const k of ['TEST_DATABASE_URL', 'CAREER_OPS_HOME', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
  if (!process.env[k]) {
    console.error(`smoke: missing env ${k}`);
    process.exit(2);
  }
}
// src/* modules read these at import time — set before dynamic imports.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { pool } = await import('../src/db.mjs');
const { seedUser } = await import('../db/seed.mjs');
const s3mod = await import('../src/s3.mjs');
const { readFileSync } = await import('node:fs');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const apiFetch = (p, opts = {}, key) =>
  fetch(`http://127.0.0.1:${API_PORT}${p}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(opts.headers ?? {}),
    },
  });

const children = [];
// Spawns node for .mjs scripts, or the file directly when it is executable
// (e.g. node_modules/.bin/s3rver).
const spawnChild = (script, extraEnv = {}, args = [], direct = false) => {
  const file = path.join(ROOT, script);
  const c = direct
    ? spawn(file, args, { env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, [file, ...args], { env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  c.stdout.on('data', (d) => process.stdout.write(`[${script}] ${d}`));
  c.stderr.on('data', (d) => process.stderr.write(`[${script}] ${d}`));
  children.push(c);
  return c;
};

try {
  // -1. boot the S3 mock first — everything below needs it
  const s3rverDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cops-s3rver-'));
  if (!process.env.SMOKE_EXTERNAL_S3) {
    spawnChild('node_modules/.bin/s3rver', { PORT: S3RVER_PORT },
      ['-a', '127.0.0.1', '-p', S3RVER_PORT, '-d', s3rverDir, '-s', '--allow-mismatched-signatures'], true);
    // Wait until the S3 mock answers: any HTTP status (even 404 bucket-missing)
    // proves it is up; only connection errors mean "not yet".
    const { HeadBucketCommand } = await import('@aws-sdk/client-s3');
    for (let i = 0; i < 40; i++) {
      try {
        await s3mod.s3.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET }));
        break;
      } catch (e) {
        if (e.$metadata?.httpStatusCode) break; // up (bucket may not exist yet)
        if (!['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(e.code)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    await s3mod.ensureBucket();
  }

  // 0. schema + clean slate
  await pool.query(readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8'));
  await pool.query(`DELETE FROM jobs`);
  await pool.query(`DELETE FROM users`);

  // 1. seed user
  const { userId, apiKey } = await seedUser(pool, 'smoke@example.com');
  check('seed user + api key', !!userId && apiKey.startsWith('cops_'));

  // 2. fixture user dir -> S3 (profile copied from the repo's own example,
  //    plus a junk sqlite file that must NOT be persisted)
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cops-fixture-'));
  await fs.mkdir(path.join(fixture, 'config'), { recursive: true });
  await fs.copyFile(
    path.join(process.env.CAREER_OPS_HOME, 'config/profile.example.yml'),
    path.join(fixture, 'config/profile.yml'),
  );
  await fs.writeFile(path.join(fixture, 'cv.md'), '# Smoke User\n\nQA engineer.\n');
  await fs.writeFile(path.join(fixture, 'tracker.sqlite'), 'SQLite format 3\0dummy');
  const repoHasProfile = await fs.stat(path.join(process.env.CAREER_OPS_HOME, 'config/profile.yml'))
    .then(() => true).catch(() => false);
  check('repo checkout has no profile.yml of its own', !repoHasProfile,
    'so a passing validate proves CAREER_OPS_ROOT plumbing');
  const up0 = await s3mod.uploadUserDir(userId, fixture);
  check('fixture uploaded to S3', up0.count === 2 && up0.skipped === 1, `${up0.count} up, ${up0.skipped} skipped`);

  // 3. start API + worker (S3 mock already up)
  spawnChild('api/server.mjs', { PORT: API_PORT });
  spawnChild('worker/worker.mjs', { POLL_INTERVAL_MS: '500' });
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${API_PORT}/health`);
      healthy = r.ok;
    } catch { /* retry */ }
    if (!healthy) await new Promise((r) => setTimeout(r, 500));
  }
  check('api /health', healthy);
  if (!healthy) throw new Error('api did not start');

  // 4. auth: no key -> 401
  let r = await apiFetch('/jobs', { method: 'POST', body: JSON.stringify({ type: 'scan' }) });
  check('POST /jobs without key -> 401', r.status === 401);

  // 5. validation: path traversal in script name -> 400
  r = await apiFetch('/jobs', {
    method: 'POST',
    body: JSON.stringify({ type: 'run-script', script: '../../etc/passwd' }),
  }, apiKey);
  check('path traversal script name -> 400', r.status === 400);

  // 6. enqueue a REAL career-ops script (offline, no LLM, no browser)
  r = await apiFetch('/jobs', {
    method: 'POST',
    body: JSON.stringify({ type: 'run-script', script: 'validate-profile.mjs', args: [] }),
  }, apiKey);
  const created = await r.json();
  check('POST /jobs -> 202 queued', r.status === 202 && created.status === 'queued', `id=${created.id}`);

  // 7. poll until terminal
  let job = null;
  for (let i = 0; i < 120; i++) {
    const jr = await apiFetch(`/jobs/${created.id}`, {}, apiKey);
    job = await jr.json();
    if (job.status === 'done' || job.status === 'error') break;
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  check('job reached terminal state', job.status === 'done' || job.status === 'error', job.status);
  check('script exit code 0 (fixture profile validated)', job.status === 'done' && job.result?.exitCode === 0,
    `exit=${job.result?.exitCode} stderr=${(job.result?.stderr ?? '').slice(-120)}`);

  // 8. S3 round-trip: files back up, sqlite skipped
  const keys = await s3mod.listUserFiles(userId);
  const rel = keys.map((k) => k.replace(`users/${userId}/`, ''));
  check('cv.md + profile.yml persisted to S3', rel.includes('cv.md') && rel.includes('config/profile.yml'), rel.join(','));
  check('*.sqlite* NOT persisted to S3', !rel.some((k) => k.includes('sqlite')), rel.join(',') || '(empty)');

  // 9. job listing scoped to the user
  r = await apiFetch('/jobs', {}, apiKey);
  const list = await r.json();
  check('GET /jobs lists the job', list.jobs?.some((j) => j.id === created.id));

  // 10. other-user isolation: second user cannot read the job
  const other = await seedUser(pool, 'smoke2@example.com');
  r = await apiFetch(`/jobs/${created.id}`, {}, other.apiKey);
  check('cross-user job read -> 404', r.status === 404);
} catch (e) {
  check('smoke completed without exception', false, e.message);
} finally {
  for (const c of children) c.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1000));
  for (const c of children) c.kill('SIGKILL');
  await pool.query(`DELETE FROM users`).catch(() => {});
  await pool.end();
}

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
