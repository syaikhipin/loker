// career-ops-saas API: thin async job frontend.
// POST /jobs -> 202 { id } ; the worker does the work; poll GET /jobs/:id.
// Long career-ops runs are never held on an open HTTP connection.
import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool } from '../src/db.mjs';
import { apiKeyAuth } from '../src/auth.mjs';
import { config } from '../src/config.mjs';
import { migrate } from '../src/migrate.mjs';

const JOB_TYPES = ['run-script', 'scan', 'pdf'];
// No path traversal, no absolute paths: a bare script filename only.
const SCRIPT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.mjs$/;
const SAFE_ARG = (s) => typeof s === 'string' && s.length <= 500 && !s.includes('\0');
const SAFE_REL = (s) => typeof s === 'string' && s.length <= 500 && !s.includes('..') && !path.isAbsolute(s);

export function createApp(db = pool) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // CORS: the browser frontend (Vercel) calls this API cross-origin.
  // Auth is a Bearer token, never cookies, so a wildcard origin is safe.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'authorization, content-type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  const auth = apiKeyAuth(db);

  app.post('/jobs', auth, async (req, res, next) => {
    try {
      const { type, script, args = [], payload = {} } = req.body ?? {};
      if (!JOB_TYPES.includes(type)) {
        return res.status(400).json({ error: `type must be one of: ${JOB_TYPES.join(', ')}` });
      }
      let jobScript;
      let jobArgs;
      if (type === 'run-script') {
        if (!SCRIPT_RE.test(script ?? '')) return res.status(400).json({ error: 'invalid script name' });
        if (!Array.isArray(args) || !args.every(SAFE_ARG)) return res.status(400).json({ error: 'invalid args' });
        jobScript = script;
        jobArgs = args.slice(0, 20);
      } else if (type === 'scan') {
        if (args !== undefined && (!Array.isArray(args) || !args.every(SAFE_ARG))) {
          return res.status(400).json({ error: 'invalid args' });
        }
        jobScript = 'scan.mjs';
        jobArgs = (args ?? []).slice(0, 20);
      } else { // pdf
        const { input, output } = payload ?? {};
        if (!SAFE_REL(input) || !SAFE_REL(output)) {
          return res.status(400).json({ error: 'payload.input/output required: relative paths, no ".."' });
        }
        jobScript = 'generate-pdf.mjs';
        jobArgs = [input, output];
      }
      const id = randomUUID();
      await db.query(
        `INSERT INTO jobs (id, user_id, type, payload) VALUES ($1, $2, $3, $4)`,
        [id, req.user.user_id, type, { script: jobScript, args: jobArgs }],
      );
      res.status(202).json({ id, status: 'queued' });
    } catch (e) {
      next(e);
    }
  });

  app.get('/jobs', auth, async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT id, type, status, created_at, started_at, finished_at
           FROM jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [req.user.user_id],
      );
      res.json({ jobs: rows });
    } catch (e) {
      next(e);
    }
  });

  app.get('/jobs/:id', auth, async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT * FROM jobs WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.user.user_id],
      );
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      res.json(rows[0]);
    } catch (e) {
      next(e);
    }
  });

  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[api] error:', err.message);
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  await migrate(pool);
  console.log('[api] schema ready');
  const app = createApp();
  app.listen(config.port, () => console.log(`[api] listening on :${config.port}`));
}
