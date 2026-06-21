import { randomBytes } from 'node:crypto';
import { db, isSetupComplete } from '../db.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword } from '../crypto.js';
import { requireAuth, getSession } from '../middleware/auth.js';

function startSession(reply, username) {
  const sid = randomBytes(24).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, username, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    sid,
    username,
    now,
    now + config.sessionTtlMs,
  );
  reply.setCookie(config.cookieName, sid, {
    path: config.basePath || '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    signed: true,
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
  return { ok: true, username };
}

export default async function authRoutes(fastify) {
  // Public: tells the SPA whether to show setup, login, or the app.
  fastify.get('/status', async (request) => {
    const session = getSession(request);
    return {
      setupComplete: isSetupComplete(),
      authenticated: !!session,
      username: session?.username || null,
    };
  });

  // First-run only: create the single admin user.
  fastify.post('/setup', async (request, reply) => {
    if (isSetupComplete()) return reply.code(409).send({ error: 'already_setup', message: '已初始化' });
    const { username, password } = request.body || {};
    if (!username || !password || password.length < 8) {
      return reply.code(400).send({ error: 'invalid_input', message: '用户名必填,密码至少 8 位' });
    }
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
      username,
      hashPassword(password),
    );
    return startSession(reply, username);
  });

  fastify.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const { username, password } = request.body || {};
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
      if (!user || !verifyPassword(password || '', user.password_hash)) {
        return reply.code(401).send({ error: 'invalid_credentials', message: '用户名或密码错误' });
      }
      return startSession(reply, user.username);
    },
  );

  fastify.post('/logout', async (request, reply) => {
    const session = getSession(request);
    if (session) db.prepare('DELETE FROM sessions WHERE id = ?').run(session.sid);
    reply.clearCookie(config.cookieName, { path: config.basePath || '/' });
    return { ok: true };
  });

  fastify.post('/change-password', { preHandler: requireAuth }, async (request, reply) => {
    const { oldPassword, newPassword } = request.body || {};
    if (!newPassword || newPassword.length < 8) {
      return reply.code(400).send({ error: 'invalid_input', message: '新密码至少 8 位' });
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(request.user.username);
    if (!user || !verifyPassword(oldPassword || '', user.password_hash)) {
      return reply.code(401).send({ error: 'invalid_credentials', message: '原密码错误' });
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      hashPassword(newPassword),
      user.id,
    );
    // Invalidate every other session for this user.
    db.prepare('DELETE FROM sessions WHERE username = ? AND id != ?').run(
      user.username,
      request.user.sid,
    );
    return { ok: true };
  });
}
