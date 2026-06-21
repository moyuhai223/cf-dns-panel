import { db } from '../db.js';
import { decrypt } from '../crypto.js';
import { requireAuth, clientIp } from '../middleware/auth.js';
import { listAllRecords, CloudflareError } from '../cf/client.js';
import { syncRecords } from '../cf/sync.js';
import { writeAudit } from '../services/audit.js';
import { notifyChange } from '../services/notify.js';

const SNAPSHOT_MAX_PER_ZONE = 30; // keep the newest N per zone

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

export default async function snapshotRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // GET /api/snapshots?zoneId=  — list snapshots for a zone (without the records blob)
  fastify.get('/', async (request, reply) => {
    const { zoneId } = request.query;
    if (!zoneId) return reply.code(400).send({ error: 'invalid_input', message: '缺少 zoneId' });
    const snapshots = db
      .prepare(
        'SELECT id, zone_name, label, record_count, created_at FROM snapshots WHERE zone_id = ? ORDER BY id DESC',
      )
      .all(zoneId);
    return { snapshots };
  });

  // POST /api/snapshots  { accountId, zoneId, zoneName, label }  — capture current records
  fastify.post('/', async (request, reply) => {
    const { accountId, zoneId, zoneName, label } = request.body || {};
    const token = tokenFor(accountId);
    if (!token) return reply.code(400).send({ error: 'invalid_account', message: '账号无效' });
    if (!zoneId || typeof zoneId !== 'string') {
      return reply.code(400).send({ error: 'invalid_input', message: '缺少 zoneId' });
    }
    let records;
    try {
      records = await listAllRecords(token, zoneId);
    } catch (e) {
      return onCf(reply, e);
    }
    const info = db
      .prepare(
        `INSERT INTO snapshots (account_id, zone_id, zone_name, label, record_count, records_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(accountId, zoneId, zoneName || '', String(label || '').slice(0, 80), records.length, JSON.stringify(records));
    // prune old snapshots for this zone
    db.prepare(
      `DELETE FROM snapshots WHERE zone_id = ? AND id NOT IN (
         SELECT id FROM snapshots WHERE zone_id = ? ORDER BY id DESC LIMIT ?
       )`,
    ).run(zoneId, zoneId, SNAPSHOT_MAX_PER_ZONE);
    return { id: info.lastInsertRowid, count: records.length };
  });

  // DELETE /api/snapshots/:id
  fastify.delete('/:id', async (request) => {
    db.prepare('DELETE FROM snapshots WHERE id = ?').run(request.params.id);
    return { ok: true };
  });

  // POST /api/snapshots/:id/restore  { accountId, dryRun? }
  // Makes the live zone match the snapshot (create/overwrite + delete extras),
  // never touching Cloudflare-managed SOA/NS. dryRun returns the plan only.
  fastify.post('/:id/restore', async (request, reply) => {
    const snap = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(request.params.id);
    if (!snap) return reply.code(404).send({ error: 'not_found', message: '快照不存在' });
    const { accountId, dryRun } = request.body || {};
    const token = tokenFor(accountId);
    if (!token) return reply.code(400).send({ error: 'invalid_account', message: '账号无效' });

    let records;
    try {
      records = JSON.parse(snap.records_json);
    } catch {
      return reply.code(500).send({ error: 'corrupt_snapshot', message: '快照数据损坏' });
    }
    if (!Array.isArray(records)) records = [];

    try {
      const res = await syncRecords(token, snap.zone_id, {
        zoneName: snap.zone_name,
        records,
        deleteMissing: true,
        dryRun: !!dryRun,
        onChange: (action, r) =>
          writeAudit({
            username: request.user.username, accountId, zoneId: snap.zone_id, zoneName: snap.zone_name,
            action, rrType: r.type, rrName: r.name, detail: { source: 'restore' }, clientIp: clientIp(request),
          }),
      });
      if (!dryRun && (res.created || res.updated || res.deleted)) {
        notifyChange({
          event: 'batch', zone: snap.zone_name,
          summary: `回滚快照:新增 ${res.created}、覆盖 ${res.updated}、删除 ${res.deleted}`,
          user: request.user.username,
        });
      }
      return res;
    } catch (e) {
      return onCf(reply, e);
    }
  });
}
