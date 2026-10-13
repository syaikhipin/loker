// Central env config. Throws on missing required values.
const req = (name, { required = false, def = undefined } = {}) => {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (required) throw new Error(`Missing required env var ${name}`);
    return def;
  }
  return v;
};
const num = (name, def) => {
  const n = Number(req(name, { def: String(def) }));
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number`);
  return n;
};

export const config = {
  port: num('PORT', 3000),
  databaseUrl: req('DATABASE_URL', { required: true }),
  s3: {
    endpoint: req('S3_ENDPOINT', { def: '' }) || undefined,
    region: req('S3_REGION', { def: 'us-east-1' }),
    bucket: req('S3_BUCKET', { required: true }),
    accessKeyId: req('S3_ACCESS_KEY_ID', { required: true }),
    secretAccessKey: req('S3_SECRET_ACCESS_KEY', { required: true }),
    forcePathStyle: req('S3_FORCE_PATH_STYLE', { def: 'false' }) === 'true',
  },
  careerOpsHome: req('CAREER_OPS_HOME', { required: true }),
  pollIntervalMs: num('POLL_INTERVAL_MS', 2000),
  jobTimeoutMs: num('JOB_TIMEOUT_MS', 600000),
  maxLogBytes: num('MAX_LOG_BYTES', 131072),
  // Forwarded into career-ops child processes. Never logged.
  forwardEnv: [
    'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL',
    'GEMINI_API_KEY', 'GEMINI_MODEL',
    'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY',
  ],
};
