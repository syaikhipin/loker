import pg from 'pg';
import { readFileSync } from 'node:fs';
import { config } from './config.mjs';

// node-postgres (pg v9) treats sslmode=require/prefer/verify-ca as aliases
// for verify-full, which breaks providers like Aiven whose server certs are
// signed by a private CA. libpq semantics are what users expect:
//   - require/prefer: encrypt, do not verify the chain
//     (rejectUnauthorized: false)
//   - verify-ca/verify-full: verify against the provider CA.
// Provide the CA via DATABASE_SSL_CA (PEM contents) or PGSSLROOTCERT
// (path to a PEM file) to get full verification instead.
function sslOptions() {
  const url = new URL(config.databaseUrl);
  const sslmode = url.searchParams.get('sslmode') ?? 'prefer';
  const caPem = process.env.DATABASE_SSL_CA
    || (process.env.PGSSLROOTCERT ? readFileSync(process.env.PGSSLROOTCERT, 'utf8') : undefined);
  if (sslmode === 'disable') return undefined;
  if (caPem) return { ca: caPem, rejectUnauthorized: true };
  if (sslmode === 'verify-ca' || sslmode === 'verify-full') {
    return { rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.databaseUrl, ssl: sslOptions(), max: 10 });
pool.on('error', (e) => console.error('[db] pool error:', e.message));
