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
//
// Quirk: if the connection string still carries sslmode=..., pg's
// connection-string parser silently discards an explicitly passed ssl
// option (resolved ssl becomes {}). So sslmode is stripped from the string
// and the computed ssl option below is the single source of truth.
function sslConfig() {
  const url = new URL(config.databaseUrl);
  const sslmode = url.searchParams.get('sslmode') ?? 'prefer';
  url.searchParams.delete('sslmode');
  const cleanUrl = url.toString();

  const caPem = process.env.DATABASE_SSL_CA
    || (process.env.PGSSLROOTCERT ? readFileSync(process.env.PGSSLROOTCERT, 'utf8') : undefined);
  if (sslmode === 'disable') return { connectionString: cleanUrl, ssl: undefined };
  if (caPem) return { connectionString: cleanUrl, ssl: { ca: caPem, rejectUnauthorized: true } };
  if (sslmode === 'verify-ca' || sslmode === 'verify-full') {
    return { connectionString: cleanUrl, ssl: { rejectUnauthorized: true } };
  }
  return { connectionString: cleanUrl, ssl: { rejectUnauthorized: false } };
}

const { Pool } = pg;
const { connectionString, ssl } = sslConfig();
export const pool = new Pool({ connectionString, ssl, max: 10 });
pool.on('error', (e) => console.error('[db] pool error:', e.message));
