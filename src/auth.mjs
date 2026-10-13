import { createHash } from 'node:crypto';

// API keys are stored as sha256 hex; the raw key is shown once at creation.
export const hashKey = (raw) => createHash('sha256').update(raw).digest('hex');

export function apiKeyAuth(pool) {
  return async (req, res, next) => {
    const h = req.headers.authorization ?? '';
    const raw = h.startsWith('Bearer ')
      ? h.slice(7)
      : (req.headers['x-api-key'] ?? '');
    if (!raw || typeof raw !== 'string') {
      return res.status(401).json({ error: 'missing api key' });
    }
    try {
      const { rows } = await pool.query(
        `SELECT u.id AS user_id, u.email
           FROM api_keys k JOIN users u ON u.id = k.user_id
          WHERE k.key_hash = $1`,
        [hashKey(raw)],
      );
      if (!rows.length) return res.status(401).json({ error: 'invalid api key' });
      req.user = rows[0];
      next();
    } catch (e) {
      next(e);
    }
  };
}
