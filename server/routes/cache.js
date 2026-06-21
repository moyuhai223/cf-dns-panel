import { db } from '../db.js';
import { decrypt } from '../crypto.js';
import { requireAuth, clientIp } from '../middleware/auth.js';
import { purgeCache, getZoneSetting, patchZoneSetting, CloudflareError } from '../cf/client.js';
import { writeAudit } from '../services/audit.js';

// Whitelisted zone settings the cache page exposes.
const SETTING_KEYS = [
  'development_mode',
  'cache_level',
  'browser_cache_ttl',
  'always_online',
  'always_use_https',
  'ssl',
];

function tokenFor(accountId) {
  const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  return a ? decrypt(a.token_encrypted) : null;
}

function onCf(reply, e) {
  if (e instanceof CloudflareError) {
    return reply.code(502).send({ error: 'cf_error', message: e.message, errors: e.errors });
  }
  throw e;
}

export default async function cacheRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // GET /api/cache/settings?accountId=&zoneId=
  // Reads each whitelisted setting; ones unavailable on the plan come back null.
  fastify.get('/settings', async (request, reply) => {
    const { accountId, zoneId } = request.query;
    const token = tokenFor(accountId);
    if (!token) return reply.code(400).send({ error: 'invalid_account', message: '账号无效' });
    const entries = await Promise.all(
      SETTING_KEYS.map(async (key) => {
        try {
          const r = await getZoneSetting(token, zoneId, key);
          return [key, { value: r.value, editable: r.editable !== false }];
        } catch (e) {
          if (e instanceof CloudflareError) return [key, null]; // not on this plan / no perm
          throw e;
        }
      }),
    ).catch((e) => e);
    if (entries instanceof Error) return onCf(reply, entries);
    return { settings: Object.fromEntries(entries) };
  });

  // PATCH /api/cache/settings  { accountId, zoneId, zoneName, key, value }
  fastify.patch('/settings', async (request, reply) => {
    const { accountId, zoneId, zoneName, key, value } = request.body || {};
    const token = tokenFor(accountId);
    if (!token) return reply.code(400).send({ error: 'invalid_account', message: '账号无效' });
    if (!SETTING_KEYS.includes(key)) {
      return reply.code(400).send({ error: 'invalid_input', message: '不支持的设置项' });
    }
    try {
      const r = await patchZoneSetting(token, zoneId, key, value);
      writeAudit({
        username: request.user.username, accountId, zoneId, zoneName,
        action: 'update', rrType: 'setting', rrName: key,
        detail: { value }, clientIp: clientIp(request),
      });
      return { setting: { value: r.value } };
    } catch (e) {
      return onCf(reply, e);
    }
  });

  // POST /api/cache/purge  { accountId, zoneId, zoneName, everything?, files? }
  fastify.post('/purge', async (request, reply) => {
    const { accountId, zoneId, zoneName, everything, files } = request.body || {};
    const token = tokenFor(accountId);
    if (!token) return reply.code(400).send({ error: 'invalid_account', message: '账号无效' });
    const list = Array.isArray(files) ? files.map((f) => String(f).trim()).filter(Boolean) : [];
    if (!everything && list.length === 0) {
      return reply.code(400).send({ error: 'invalid_input', message: '请填写要清除的 URL,或选择全部清除' });
    }
    if (list.length > 30) {
      return reply.code(400).send({ error: 'invalid_input', message: '按 URL 清除单次最多 30 条' });
    }
    const body = everything ? { purge_everything: true } : { files: list };
    try {
      await purgeCache(token, zoneId, body);
      writeAudit({
        username: request.user.username, accountId, zoneId, zoneName,
        action: 'delete', rrType: 'cache', rrName: everything ? '全部缓存' : `${list.length} 条 URL`,
        detail: { everything: !!everything, files: list }, clientIp: clientIp(request),
      });
      return { ok: true };
    } catch (e) {
      return onCf(reply, e);
    }
  });
}
