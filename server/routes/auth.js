import { randomBytes } from 'node:crypto';
import { db, isSetupComplete } from '../db.js';
import { config } from '../config.js';
import {
  hashPassword,
  verifyPassword,
  encrypt,
  decrypt,
  generateTotpSecret,
  totpVerify,
  totpUri,
} from '../crypto.js';
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
    let twoFactor = false;
    if (session) {
      const u = db.prepare('SELECT totp_enabled FROM users WHERE username = ?').get(session.username);
      twoFactor = !!(u && u.totp_enabled);
    }
    return {
      setupComplete: isSetupComplete(),
      authenticated: !!session,
      username: session?.username || null,
      twoFactor,
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
      const { username, password, code } = request.body || {};
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
      if (!user || !verifyPassword(password || '', user.password_hash)) {
        return reply.code(401).send({ error: 'invalid_credentials', message: '用户名或密码错误' });
      }
      if (user.totp_enabled) {
        if (!code) return reply.code(401).send({ error: 'totp_required', message: '请输入两步验证码' });
        if (!totpVerify(decrypt(user.totp_secret), code)) {
          return reply.code(401).send({ error: 'totp_invalid', message: '两步验证码错误' });
        }
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

  // ---- Two-factor authentication (TOTP) ----

  // Begin setup: generate + store a (not-yet-enabled) secret, return it for the QR.
  fastify.post('/2fa/setup', { preHandler: requireAuth }, async (request, reply) => {
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(request.user.username);
    if (u.totp_enabled) return reply.code(409).send({ error: 'already_enabled', message: '已启用两步验证' });
    const secret = generateTotpSecret();
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(encrypt(secret), u.id);
    return { secret, uri: totpUri(secret, u.username) };
  });

  // Confirm a code against the pending secret, then enable.
  fastify.post('/2fa/enable', { preHandler: requireAuth }, async (request, reply) => {
    const { code } = request.body || {};
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(request.user.username);
    if (u.totp_enabled) return reply.code(409).send({ error: 'already_enabled', message: '已启用' });
    if (!u.totp_secret) return reply.code(400).send({ error: 'no_pending', message: '请先开始设置' });
    if (!totpVerify(decrypt(u.totp_secret), code)) {
      return reply.code(400).send({ error: 'totp_invalid', message: '验证码错误,请重试' });
    }
    db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(u.id);
    return { ok: true };
  });

  // Disable: require the password, plus a current code while still enabled.
  fastify.post('/2fa/disable', { preHandler: requireAuth }, async (request, reply) => {
    const { password, code } = request.body || {};
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(request.user.username);
    if (!verifyPassword(password || '', u.password_hash)) {
      return reply.code(401).send({ error: 'invalid_credentials', message: '密码错误' });
    }
    if (u.totp_enabled && !totpVerify(decrypt(u.totp_secret), code)) {
      return reply.code(400).send({ error: 'totp_invalid', message: '验证码错误' });
    }
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(u.id);
    return { ok: true };
  });
}
