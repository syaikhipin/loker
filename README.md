# career-ops-saas

Multi-tenant SaaS backend for [career-ops](https://github.com/career-ops-hq/career-ops)
(the open-source AI job-search agent, MIT). Split from the local-first CLI:

```
                 ┌──────────────┐
                 │   Frontend   │  separate (e.g. Vercel) — not in this repo
                 └──────┬───────┘
                        │  HTTPS + Bearer API key
                        ▼
┌──────────────────────────────────────────────────────┐
│ API  (Render web, 512MB)                             │
│  POST /jobs -> 202 {id}   GET /jobs/:id  (poll)      │
│  Auth: per-user API keys (sha256-hashed in Postgres) │
└──────┬───────────────────────────────────────────────┘
       │  Postgres job queue (FOR UPDATE SKIP LOCKED)
       ▼
┌──────────────────────────────────────────────────────┐
│ Worker (Render background worker, 512MB)             │
│  1. claim job                                        │
│  2. S3 users/{id}/ -> temp dir                       │
│  3. run career-ops script, CAREER_OPS_ROOT=temp dir  │
│  4. temp dir -> S3 (skips *.sqlite*: derived index)  │
│  5. mark job done/error                              │
└──────────────────────────────────────────────────────┘
```

Postgres holds **SaaS tables only** (`users`, `api_keys`, `jobs`). Career-ops
user data (cv, tracker, reports) lives in **S3**; the core's "files are
canonical" doctrine is kept. Chromium runs **headless-shell** (what the core
already uses) — see [Chromium](#chromium) below.

## Quickstart (local, Docker)

```bash
cp .env.example .env          # fill in at least the LLM keys you use
docker compose up --build
# in another shell:
export DATABASE_URL=postgresql://cops:cops@127.0.0.1:5432/careerops
npm install
npm run schema                # create tables
npm run seed -- you@example.com   # prints USER_ID and API_KEY (once)
curl -H "Authorization: Bearer <API_KEY>" localhost:3000/health
curl -X POST -H "Authorization: Bearer <API_KEY>" -H 'content-type: application/json' \
  -d '{"type":"run-script","script":"validate-profile.mjs"}' localhost:3000/jobs
# -> { "id": "...", "status": "queued" }; poll GET /jobs/<id>
```

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | no auth |
| POST | `/jobs` | auth; `{type:"run-script",script,args}` \| `{type:"scan",args?}` \| `{type:"pdf",payload:{input,output}}` → `202 {id,status}` |
| GET | `/jobs` | auth; your last 50 jobs |
| GET | `/jobs/:id` | auth; full row incl. `result`/`error`; 404 for other users' jobs |

Jobs are **async by design**: career-ops runs take minutes; never hold an
HTTP connection open. Enqueue → poll.

`run-script` accepts any `*.mjs` in the career-ops checkout (bare filename,
no paths — `../../x` is rejected). `scan` runs `scan.mjs`. `pdf` runs
`generate-pdf.mjs` with `input`/`output` as paths **relative to the user's
data root**.

## Render deploy

`render.yaml` defines three services (all `starter` = 512MB):

- `cops-api` — web, `node api/server.mjs`, health check `/health`
- `cops-worker` — background worker, `node worker/worker.mjs`
- `cops-scan-trigger` — cron `0 6 * * *`, `node scripts/trigger-scans.mjs`
  (enqueues a scan per user with `scan_enabled = true`, skipping users that
  already have a scan queued/running)

Set `DATABASE_URL` (Neon/Supabase free tier — pooled URL) and the `S3_*`
vars in the Render dashboard. Pin `CAREER_OPS_REF` (Docker build arg) to a
career-ops tag for production.

**Render notes**
- Free tier sleeps after 15 min and has no cron/disks — Starter minimum.
- Render gives you no `shm_size` knob: add `--disable-dev-shm-usage` to the
  Chromium launches you use (see below), and keep PDF concurrency at 1 on
  512MB.
- Render disks are ephemeral: user data lives in S3, so this is fine — the
  local temp dir is scratch only.

## S3 layout

```
s3://<bucket>/users/<userId>/cv.md
s3://<bucket>/users/<userId>/config/profile.yml
s3://<bucket>/users/<userId>/data/...
s3://<bucket>/users/<userId>/reports/...
```

The worker downloads the prefix before a job and uploads it back after.
`*.sqlite*`, `node_modules/`, `.git/` are never uploaded — the SQLite file
is a derived index the core rebuilds. Jobs for the same user are serialized
(in-worker set; use `pg_advisory_xact_lock(hashtext(user_id))` if you ever
run multiple workers).

## LLM

The core already speaks OpenAI-compatible endpoints — no code changes.
Set `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` (works with
OpenRouter, DeepSeek, Together, Groq, Zhipu GLM, llama.cpp, vLLM, Ollama)
or `GEMINI_API_KEY`. Keys are forwarded to child processes and **never
logged**. Use `spend_tier: economy` in the user's profile for bulk scans.

## Scan via another API

Three depths, all supported by the core's design:

1. **Drop-in provider** — add `providers/{name}.mjs` exporting `{ id, fetch }`
   in the normalized Job shape (see the core's
   `providers/ADDING_A_PROVIDER.md`). Auto-registered by `_registry.mjs`.
2. **Apify plugin** — already in the core (`plugins/apify/`, opt-in with
   `APIFY_TOKEN`): a keyed source via an Apify actor, e.g. for auth-gated
   boards like LinkedIn that the zero-token core deliberately excludes.
3. **Bypass `scan.mjs`** — your own code calls the external API and writes
   rows straight to `data/pipeline.md`. Downstream (evaluate/tracker)
   doesn't care where rows came from. **Keep writing `data/scan-history.tsv`**
   — it's the dedup source; skipping it means duplicate LLM evaluations.

## Chromium

Since Playwright 1.49, `chromium.launch({ headless: true })` — which is what
the core uses — already resolves to the `chrome-headless-shell` binary
(the slim build). There is no lighter Chromium to switch to. Two trims:

- Docker: `npx playwright install --only-shell chromium` skips the full
  desktop build (~364MB) that is never launched. Already in the Dockerfile.
- Render: add `args: ['--disable-dev-shm-usage']` to the Chromium launches
  you use (`generate-pdf.mjs` has an injectable `launchBrowser` seam, so
  this is a small patch, not a fork), and run one browser at a time.

`liveness-browser` and `browser-extract` are fallbacks — the primary paths
(`liveness-api.mjs`, `fetch-jd.mjs`) need no browser at all.

## Security notes

- API keys: sha256-hashed at rest, raw value shown once.
- `run-script` allowlist is syntactic (bare `*.mjs` filename); a malicious
  user with a key can run any core script — that is the product, but don't
  hand keys to untrusted users without thinking.
- Job postings are untrusted input (the core treats them as data, never
  instructions) — preserved by running the unmodified core.
- Per-user S3 prefixes + `user_id` scoping on every query; cross-user job
  reads return 404 (covered by the smoke test).

## Not in this scaffold (next steps)

- Real user login (OAuth / Auth.js) — API keys are the MVP stand-in.
- Billing (Stripe) — the core's token tracker + `spend_tier` are the
  metering foundation.
- Multi-worker deploys — replace the in-memory per-user set with Postgres
  advisory locks (noted in `worker/worker.mjs`).
- A nicer scan UX than `scan.mjs` args passthrough.

## Test evidence

`npm run smoke` (`scripts/smoke-test.mjs`) is a black-box end-to-end run:
real Postgres, real S3 API (s3rver), real API + worker processes, and a real
career-ops script (`validate-profile.mjs`) executed against an S3-synced
user dir.

**Result 2026-10-13: 13/13 checks passed** (Postgres 16, Node 24):

- seed user + API key; repo checkout has no `config/profile.yml`, so the
  passing validation proves `CAREER_OPS_ROOT` pointed at the S3-synced dir
- fixture uploaded to S3 (2 files up, 1 `*.sqlite` skipped)
- `POST /jobs` without key → 401; path-traversal script name → 400
- `POST /jobs` → 202 queued; worker claimed it (`FOR UPDATE SKIP LOCKED`)
  and ran it to `done` with exit code 0
- `cv.md` + `config/profile.yml` persisted back to S3; `*.sqlite*` not stored
- `GET /jobs` lists it; another user's key gets 404 on the job

Not covered by this run (no Docker daemon on the test machine): the
`Dockerfile` build itself, a real Render deploy, and a Chromium PDF render.
The PDF path uses the core's unmodified `generate-pdf.mjs`, which launches
headless-shell exactly as the core's own CI tests.
