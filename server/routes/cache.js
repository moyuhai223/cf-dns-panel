import { db } from '../db.js';
import { decrypt } from '../crypto.js';
import { requireAuth, clientIp } from '../middleware/auth.js';
import { purgeCache, getZoneSetting, patchZoneSetting, CloudflareError } from '../cf/client.js';
import { writeAudit } from '../services/audit.js';

// Whitelisted zone settings the cache page exposes, with allowed values.
const ONOFF = ['on', 'off'];
const SETTING_VALUES = {
  development_mode: ONOFF,
  cache_level: ['aggressive', 'basic', 'simplified'],
  browser_cache_ttl: (v) => Number.isInteger(v) && v >= 0,
  always_online: ONOFF,
  always_use_https: ONOFF,
  ssl: ['off', 'flexible', 'full', 'strict'],
};
const SETTING_KEYS = Object.keys(SETTING_VALUES);

function validSettingValue(key, value) {
  const spec = SETTING_VALUES[key];
  if (typeof spec === 'function') return spec(value);
  if (Array.isArray(spec)) return spec.includes(value);
  return false;
}

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
  fastify.get('/settings', async (request, reply) => {
    const { accountId, zoneId } = request.query;
    const token = tokenFor(accountId);
    if (!token) return reply.code(400).send({ error: 'invalid_account', message: '账号无效' });
    if (!zoneId || typeof zoneId !== 'string') {
      return reply.code(400).send({ error: 'invalid_input', message: '缺少 zoneId' });
    }

    const results = await Promise.allSettled(SETTING_KEYS.map((k) => getZoneSetting(token, zoneId, k)));
    const settings = {};
    for (let i = 0; i < SETTING_KEYS.length; i++) {
      const key = SETTING_KEYS[i];
      const r = results[i];
      if (r.status === 'fulfilled') {
        settings[key] = { value: r.value.value, editable: r.value.editable !== false };
      } else if (r.reason instanceof CloudflareError && (r.reason.status === 404 || r.reason.status === 400)) {
        settings[key] = null; // genuinely unavailable on this plan/zone
      } else {
        return onCf(reply, r.reason); // auth/permission/rate-limit/connection -> surface
      }
    }
    return { settings };
  });

  // PATCH /api/cache/settings  { accountId, zoneId, zoneName, key, value }
  fastify.patch('/settings', async (request, reply) => {
    const { accountId, zoneId, zoneName, key, value } = request.body || {};
    const token = tokenFor(accountId);
    if (!token) return reply.code(400).send({ error: 'invalid_account', message: '账号无效' });
    if (!zoneId || typeof zoneId !== 'string') {
      return reply.code(400).send({ error: 'invalid_input', message: '缺少 zoneId' });
    }
    if (!SETTING_KEYS.includes(key)) {
      return reply.code(400).send({ error: 'invalid_input', message: '不支持的设置项' });
    }
    if (!validSettingValue(key, value)) {
      return reply.code(400).send({ error: 'invalid_input', message: '设置值不合法' });
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
    if (!zoneId || typeof zoneId !== 'string') {
      return reply.code(400).send({ error: 'invalid_input', message: '缺少 zoneId' });
    }
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
