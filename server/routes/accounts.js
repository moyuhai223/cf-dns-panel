import { db } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { requireAuth } from '../middleware/auth.js';
import { verifyToken, listZones, listAllRecords, cfProbe, CloudflareError } from '../cf/client.js';

const SEARCH_MAX_ZONES = 200; // bound the fan-out
const SEARCH_MAX_RESULTS = 500;
const SEARCH_CONCURRENCY = 8;

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
    db.prepare('DELETE FROM ddns WHERE account_id = ?').run(request.params.id); // drop orphaned DDNS configs
    db.prepare('DELETE FROM snapshots WHERE account_id = ?').run(request.params.id); // and snapshots
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

  // GET /:id/check — probe (read-only) which Cloudflare features this token can use.
  // Write-only capabilities (DNS edit / cache purge) can't be safely probed and are
  // reported as "use to verify".
  fastify.get('/:id/check', async (request, reply) => {
    const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(request.params.id);
    if (!acct) return reply.code(404).send({ error: 'not_found', message: '账号不存在' });
    const token = decrypt(acct.token_encrypted);

    const checks = {};
    let zones = [];
    try {
      zones = await listZones(token);
      checks.zones = { ok: true, count: zones.length };
    } catch (e) {
      checks.zones = { ok: false, message: e instanceof CloudflareError ? e.message : String((e && e.message) || e) };
    }

    const z = zones[0];
    if (z) {
      const [dns, settings, rulesets] = await Promise.all([
        cfProbe(token, `/zones/${z.id}/dns_records?per_page=1`),
        cfProbe(token, `/zones/${z.id}/settings/ssl`),
        cfProbe(token, `/zones/${z.id}/rulesets`),
      ]);
      checks.dnsRead = dns;
      checks.zoneSettings = settings;
      checks.rules = rulesets;
    }
    return { checks, sampleZone: z?.name || null };
  });

  // GET /:id/search?q=&type=  — search records across ALL zones of this account.
  // Cloudflare has no cross-zone DNS search, so we list every zone's records and
  // filter server-side (bounded fan-out). Returns matches tagged with their zone.
  fastify.get('/:id/search', async (request, reply) => {
    const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(request.params.id);
    if (!acct) return reply.code(404).send({ error: 'not_found', message: '账号不存在' });
    const q = String(request.query.q || '').trim().toLowerCase();
    const type = request.query.type ? String(request.query.type).toUpperCase() : '';
    if (!q && !type) {
      return reply.code(400).send({ error: 'invalid_input', message: '请输入搜索词或选择类型' });
    }

    const token = decrypt(acct.token_encrypted);
    let zones;
    try {
      zones = await listZones(token);
    } catch (e) {
      if (e instanceof CloudflareError) {
        return reply.code(502).send({ error: 'cf_error', message: e.message, errors: e.errors });
      }
      throw e;
    }

    const targets = zones.slice(0, SEARCH_MAX_ZONES);
    const results = [];
    const errors = [];
    let truncated = zones.length > SEARCH_MAX_ZONES;
    let cursor = 0;

    async function worker() {
      while (cursor < targets.length && results.length < SEARCH_MAX_RESULTS) {
        const z = targets[cursor++];
        try {
          const recs = await listAllRecords(token, z.id);
          for (const r of recs) {
            if (results.length >= SEARCH_MAX_RESULTS) {
              truncated = true;
              break;
            }
            if (type && r.type !== type) continue;
            if (q) {
              const hay = `${r.name}\n${r.content}\n${r.comment || ''}`.toLowerCase();
              if (!hay.includes(q)) continue;
            }
            results.push({
              zoneId: z.id,
              zoneName: z.name,
              record: {
                id: r.id,
                type: r.type,
                name: r.name,
                content: r.content,
                ttl: r.ttl,
                proxied: r.proxied,
                priority: r.priority,
                comment: r.comment,
              },
            });
          }
        } catch (e) {
          errors.push({ zone: z.name, message: e instanceof CloudflareError ? e.message : String((e && e.message) || e) });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, targets.length) }, worker));

    return { results, zonesSearched: targets.length, totalZones: zones.length, truncated, errors };
  });
}
