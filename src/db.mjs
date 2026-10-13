import pg from 'pg';
import { config } from './config.mjs';

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on('error', (e) => console.error('[db] pool error:', e.message));
