import { randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { decrypt } from '../crypto.js';
import { requireAuth, clientIp } from '../middleware/auth.js';
import { patchRecord, CloudflareError } from '../cf/client.js';
import { writeAudit } from '../services/audit.js';
import { notifyChange } from '../services/notify.js';

function accountToken(accountId) {
  const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  return acct ? decrypt(acct.token_encrypted) : null;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function validIp(ip, type) {
  if (type === 'AAAA') return /^[0-9a-fA-F:]+$/.test(ip) && ip.includes(':');
  return IPV4.test(ip) && ip.split('.').every((o) => Number(o) <= 255);
}

export default async function ddnsRoutes(fastify) {
  // -------------------------------------------------------------------------
  // Public, KEY-authenticated updater (no session). Dyndns2-style text reply.
  // Call from a router / cron on the box whose IP should be tracked:
  //   curl "https://<panel>/api/ddns/update?key=<KEY>"        (uses caller IP)
  //   curl "https://<panel>/api/ddns/update?key=<KEY>&ip=1.2.3.4"
  // -------------------------------------------------------------------------
  fastify.get(
    '/update',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.type('text/plain; charset=utf-8');
      const { key } = request.query;
      if (!key) return reply.code(400).send('badauth');

      const cfg = db.prepare('SELECT * FROM ddns WHERE key = ?').get(key);
      if (!cfg) return reply.code(404).send('nohost');

      let ip = request.query.ip;
      if (!ip || ip === 'auto') ip = clientIp(request);
      ip = String(ip || '').trim();
      if (!validIp(ip, cfg.record_type)) return reply.code(400).send(`badip ${ip}`);

      if (cfg.last_ip === ip) return reply.send(`nochg ${ip}`);

      const token = accountToken(cfg.account_id);
      if (!token) return reply.code(500).send('911'); // account/token gone

      try {
        await patchRecord(token, cfg.zone_id, cfg.record_id, { content: ip });
      } catch (e) {
        request.log.warn({ err: e instanceof CloudflareError ? e.message : String(e) }, 'ddns update failed');
        return reply.code(502).send('dnserr');
      }

      db.prepare("UPDATE ddns SET last_ip = ?, updated_at = datetime('now') WHERE id = ?").run(ip, cfg.id);
      writeAudit({
        username: 'ddns',
        accountId: cfg.account_id,
        zoneId: cfg.zone_id,
        zoneName: cfg.zone_name,
        action: 'update',
        rrType: cfg.record_type,
        rrName: cfg.record_name,
        detail: { source: 'ddns', content: ip },
        clientIp: clientIp(request),
      });
      notifyChange({ event: 'ddns', zone: cfg.zone_name, type: cfg.record_type, name: cfg.record_name, content: ip, user: 'ddns' });
      return reply.send(`good ${ip}`);
    },
  );

  // ------------------------- Management (session) --------------------------
  fastify.get('/', { preHandler: requireAuth }, async () => {
    const ddns = db
      .prepare(
        `SELECT id, key, account_id, zone_name, record_name, record_type, last_ip, updated_at, created_at
         FROM ddns ORDER BY id DESC`,
      )
      .all();
    return { ddns };
  });

  fastify.post('/', { preHandler: requireAuth }, async (request, reply) => {
    const { accountId, zoneId, zoneName, recordId, recordName, recordType } = request.body || {};
    if (!accountId || !zoneId || !recordId || !recordName || !recordType) {
      return reply.code(400).send({ error: 'invalid_input', message: '参数不全' });
    }
    if (recordType !== 'A' && recordType !== 'AAAA') {
      return reply.code(400).send({ error: 'invalid_input', message: '仅支持 A / AAAA 记录' });
    }
    const key = randomBytes(24).toString('hex');
    const info = db
      .prepare(
        `INSERT INTO ddns (key, account_id, zone_id, zone_name, record_id, record_name, record_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(key, accountId, zoneId, zoneName || '', recordId, recordName, recordType);
    return { id: info.lastInsertRowid, key };
  });

  fastify.delete('/:id', { preHandler: requireAuth }, async (request) => {
    db.prepare('DELETE FROM ddns WHERE id = ?').run(request.params.id);
    return { ok: true };
  });
}
