import { db } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { requireAuth } from '../middleware/auth.js';
import { verifyToken, listZones, CloudflareError } from '../cf/client.js';

export default async function accountRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // List configured Cloudflare credentials (never returns the raw token).
  fastify.get('/', async () => {
    const accounts = db
      .prepare('SELECT id, label, token_last4, created_at FROM accounts ORDER BY id')
      .all();
    return { accounts };
  });

  // Add a token: verify against Cloudflare first, then store it encrypted.
  fastify.post('/', async (request, reply) => {
    const { label, token } = request.body || {};
    if (!token || typeof token !== 'string') {
      return reply.code(400).send({ error: 'invalid_input', message: 'Token 必填' });
    }
    try {
      await verifyToken(token.trim());
    } catch (e) {
      if (e instanceof CloudflareError) {
        return reply.code(400).send({ error: 'token_invalid', message: 'Token 校验失败: ' + e.message });
      }
      throw e;
    }
    const last4 = token.trim().slice(-4);
    const info = db
      .prepare('INSERT INTO accounts (label, token_encrypted, token_last4) VALUES (?, ?, ?)')
      .run(label?.trim() || 'Cloudflare', encrypt(token.trim()), last4);
    return { id: info.lastInsertRowid, label: label?.trim() || 'Cloudflare', token_last4: last4 };
  });

  fastify.delete('/:id', async (request) => {
    db.prepare('DELETE FROM accounts WHERE id = ?').run(request.params.id);
    return { ok: true };
  });

  // List zones visible to this credential.
  fastify.get('/:id/zones', async (request, reply) => {
    const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(request.params.id);
    if (!acct) return reply.code(404).send({ error: 'not_found', message: '账号不存在' });
    try {
      const zones = await listZones(decrypt(acct.token_encrypted));
      return {
        zones: zones.map((z) => ({
          id: z.id,
          name: z.name,
          status: z.status,
          paused: z.paused,
          account: z.account?.name,
        })),
      };
    } catch (e) {
      if (e instanceof CloudflareError) {
        return reply.code(502).send({ error: 'cf_error', message: e.message, errors: e.errors });
      }
      throw e;
    }
  });
}
