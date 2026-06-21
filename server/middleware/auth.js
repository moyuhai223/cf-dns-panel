import { db } from '../db.js';
import { config } from '../config.js';

/** Resolve the current session from the signed cookie, or null. */
export function getSession(request) {
  const raw = request.cookies?.[config.cookieName];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;

  const sid = unsigned.value;
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    return null;
  }
  return { sid, username: row.username };
}

/** Fastify preHandler: 401 unless a valid session is present. */
export async function requireAuth(request, reply) {
  const session = getSession(request);
  if (!session) {
    return reply.code(401).send({ error: 'unauthorized', message: '未登录或会话已过期' });
  }
  request.user = session;
}

/** Real client IP (works because the server runs with trustProxy=true). */
export function clientIp(request) {
  return request.ip;
}
