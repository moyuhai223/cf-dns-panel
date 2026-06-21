import { db } from '../db.js';
import { decrypt } from '../crypto.js';
import { requireAuth, clientIp } from '../middleware/auth.js';
import {
  listRecords,
  listAllRecords,
  getZone,
  createRecord,
  updateRecord,
  patchRecord,
  deleteRecord,
  CloudflareError,
} from '../cf/client.js';
import { sanitizeRecord, toFqdn, recordKey } from '../cf/records-util.js';
import { writeAudit } from '../services/audit.js';

const IMPORT_MAX = 1000; // hard cap on records accepted per import request
const IMPORT_CONCURRENCY = 6; // parallel Cloudflare writes during an import
const PROXYABLE = new Set(['A', 'AAAA', 'CNAME']);
const MANAGED = new Set(['SOA', 'NS']); // Cloudflare-managed; import never touches them

function tokenForAccount(accountId) {
  const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!acct) return null;
  return decrypt(acct.token_encrypted);
}

function onCfError(reply, e) {
  if (e instanceof CloudflareError) {
    return reply.code(502).send({ error: 'cf_error', message: e.message, errors: e.errors });
  }
  throw e;
}

export default async function recordRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // GET /api/zones/:zoneId/records?accountId=&type=&name=&page=
  fastify.get('/:zoneId/records', async (request, reply) => {
    const { zoneId } = request.params;
    const { accountId, type, name, page } = request.query;
    const token = tokenForAccount(accountId);
    if (!token) return reply.code(400).send({ error: 'invalid_account', message: '账号无效' });
    try {
      const data = await listRecords(token, zoneId, { type, name, page: Number(page) || 1 });
      return { records: data.result, result_info: data.result_info };
    } catch (e) {
      return onCfError(reply, e);
    }
  });

  // POST /api/zones/:zoneId/records  { accountId, zoneName, record }
  fastify.post('/:zoneId/records', async (request, reply) => {
    const { zoneId } = request.params;
    const { accountId, zoneName, record } = request.body || {};
    const token = tokenForAccount(accountId);
    if (!token) return reply.code(400).send({ error: 'invalid_account', message: '账号无效' });
    try {
      const result = await createRecord(token, zoneId, sanitizeRecord(record));
      writeAudit({
        username: request.user.username,
        accountId,
        zoneId,
        zoneName,
        action: 'create',
        rrType: result.type,
        rrName: result.name,
        detail: { content: result.content, ttl: result.ttl, proxied: result.proxied },
        clientIp: clientIp(request),
      });
      return { record: result };
    } catch (e) {
      return onCfError(reply, e);
    }
  });

  // PUT /api/zones/:zoneId/records/:recordId  { accountId, zoneName, record }
  fastify.put('/:zoneId/records/:recordId', async (request, reply) => {
    const { zoneId, recordId } = request.params;
    const { accountId, zoneName, record } = request.body || {};
    const token = tokenForAccount(accountId);
    if (!token) return reply.code(400).send({ error: 'invalid_account', message: '账号无效' });
    try {
      const result = await updateRecord(token, zoneId, recordId, sanitizeRecord(record));
      writeAudit({
        username: request.user.username,
        accountId,
        zoneId,
        zoneName,
        action: 'update',
        rrType: result.type,
        rrName: result.name,
        detail: { content: result.content, ttl: result.ttl, proxied: result.proxied },
        clientIp: clientIp(request),
      });
      return { record: result };
    } catch (e) {
      return onCfError(reply, e);
    }
  });

  // DELETE /api/zones/:zoneId/records/:recordId?accountId=&zoneName=&rrType=&rrName=
  fastify.delete('/:zoneId/records/:recordId', async (request, reply) => {
    const { zoneId, recordId } = request.params;
    const { accountId, zoneName, rrType, rrName } = request.query;
    const token = tokenForAccount(accountId);
    if (!token) return reply.code(400).send({ error: 'invalid_account', message: '账号无效' });
    try {
      await deleteRecord(token, zoneId, recordId);
      writeAudit({
        username: request.user.username,
        accountId,
        zoneId,
        zoneName,
        action: 'delete',
        rrType,
        rrName,
        detail: { recordId },
        clientIp: clientIp(request),
      });
      return { ok: true };
    } catch (e) {
      return onCfError(reply, e);
    }
  });

  // GET /api/zones/:zoneId/export?accountId=  -> { records: [...all...] }
  fastify.get('/:zoneId/export', async (request, reply) => {
    const { zoneId } = request.params;
    const { accountId } = request.query;
    const token = tokenForAccount(accountId);
    if (!token) return reply.code(400).send({ error: 'invalid_account', message: '账号无效' });
    try {
      const records = await listAllRecords(token, zoneId);
      return { records };
    } catch (e) {
      return onCfError(reply, e);
    }
  });

  // POST /api/zones/:zoneId/import
  //   { accountId, zoneName, records: [...], dryRun?, deleteMissing? }
  // Upsert by (type, name): a matching record OVERWRITES; others are created.
  // deleteMissing (full sync) also removes existing records absent from the file
  // (except Cloudflare-managed SOA/NS). dryRun computes the plan and writes nothing.
  fastify.post('/:zoneId/import', async (request, reply) => {
    const { zoneId } = request.params;
    const { accountId, records, dryRun, deleteMissing } = request.body || {};
    const token = tokenForAccount(accountId);
    if (!token) return reply.code(400).send({ error: 'invalid_account', message: '账号无效' });
    if (!Array.isArray(records) || records.length === 0) {
      return reply.code(400).send({ error: 'invalid_input', message: '没有可导入的记录' });
    }
    if (records.length > IMPORT_MAX) {
      return reply.code(413).send({ error: 'too_many_records', message: `单次最多导入 ${IMPORT_MAX} 条` });
    }

    // Derive the zone name from the zone id itself — never trust a client-supplied
    // name to qualify FQDNs. A mismatched name would make every record look
    // "missing" and (under deleteMissing) could wipe the whole zone.
    let zoneName;
    let existing;
    try {
      zoneName = (await getZone(token, zoneId)).name;
      existing = await listAllRecords(token, zoneId);
    } catch (e) {
      return onCfError(reply, e);
    }

    // Buckets of existing records per (type, fqdn). When several records share a
    // key (round-robin A, multi-MX), an incoming row first claims the existing
    // record with matching content, so a sibling's identity is never clobbered.
    const byKey = new Map();
    for (const r of existing) {
      const k = recordKey(r.type, r.name);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }

    const result = {
      total: records.length,
      created: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    // Phase 1 — plan synchronously (bucket matching mutates state, so it must be serial).
    const plan = [];
    for (let i = 0; i < records.length; i++) {
      const line = i + 1;
      const raw = records[i];
      let type;
      let name;
      try {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error('记录格式不是对象');
        }
        type = String(raw.type || '').trim().toUpperCase();
        if (!type) throw new Error('缺少 type');
        // SOA/NS are Cloudflare-managed: never create, update, or delete them.
        if (MANAGED.has(type)) {
          result.skipped++;
          continue;
        }
        if (raw.content == null || String(raw.content).trim() === '') throw new Error('content 为空');
        name = toFqdn(raw.name, zoneName);
        const body = sanitizeRecord({ ...raw, type, name });

        const bucket = byKey.get(recordKey(type, name));
        let targetId = null;
        if (bucket && bucket.length) {
          const idx = bucket.findIndex((e) => e.content === body.content);
          targetId = (idx >= 0 ? bucket.splice(idx, 1)[0] : bucket.shift()).id;
        }
        plan.push({ line, type, name, body, targetId });
      } catch (e) {
        result.failed++;
        result.errors.push({
          line,
          type: type || '',
          name: name || (raw && typeof raw === 'object' ? raw.name : '') || '',
          message: (e && e.message) || String(e),
        });
      }
    }

    // Leftover existing records (unmatched) — full-sync deletion candidates.
    // Cloudflare-managed SOA/NS are never deleted.
    const leftovers = [];
    for (const bucket of byKey.values()) {
      for (const r of bucket) if (r.type !== 'SOA' && r.type !== 'NS') leftovers.push(r);
    }

    const willCreate = plan.filter((p) => !p.targetId).length;
    const willUpdate = plan.filter((p) => p.targetId).length;
    const willDelete = deleteMissing ? leftovers.length : 0;

    // A file that parsed to nothing usable must never be treated as "delete all".
    if (deleteMissing && plan.length === 0) {
      return reply.code(400).send({
        error: 'empty_plan',
        message: '文件未解析出任何有效记录,已拒绝执行「完全同步」删除',
      });
    }

    if (dryRun) {
      return {
        dryRun: true,
        total: records.length,
        willCreate,
        willUpdate,
        willDelete,
        skipped: result.skipped,
        failed: result.failed,
        errors: result.errors.sort((a, b) => a.line - b.line),
      };
    }

    const audit = (action, res, source) =>
      writeAudit({
        username: request.user.username, accountId, zoneId, zoneName,
        action, rrType: res.type, rrName: res.name,
        detail: { source, content: res.content }, clientIp: clientIp(request),
      });

    // Phase 2 — upserts with bounded concurrency. Counter increments are race-free
    // (they run synchronously between awaits on JS's single thread).
    let cursor = 0;
    async function worker() {
      while (cursor < plan.length) {
        const item = plan[cursor++];
        try {
          if (item.targetId) {
            const res = await updateRecord(token, zoneId, item.targetId, item.body);
            result.updated++;
            audit('update', res, 'import');
          } else {
            const res = await createRecord(token, zoneId, item.body);
            result.created++;
            audit('create', res, 'import');
          }
        } catch (e) {
          result.failed++;
          result.errors.push({
            line: item.line, type: item.type, name: item.name,
            message: e instanceof CloudflareError ? e.message : String((e && e.message) || e),
          });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, plan.length) }, worker));

    // Phase 3 — full-sync deletion of leftovers.
    if (deleteMissing && leftovers.length) {
      let dc = 0;
      async function delWorker() {
        while (dc < leftovers.length) {
          const r = leftovers[dc++];
          try {
            await deleteRecord(token, zoneId, r.id);
            result.deleted++;
            audit('delete', r, 'import-sync');
          } catch (e) {
            result.failed++;
            result.errors.push({
              type: r.type, name: r.name,
              message: e instanceof CloudflareError ? e.message : String((e && e.message) || e),
            });
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, leftovers.length) }, delWorker));
    }

    result.errors.sort((a, b) => (a.line || 0) - (b.line || 0));
    return result;
  });

  // POST /api/zones/:zoneId/records/bulk-delete  { accountId, zoneName, ids:[] }
  fastify.post('/:zoneId/records/bulk-delete', async (request, reply) => {
    const { zoneId } = request.params;
    const { accountId, zoneName, ids } = request.body || {};
    const token = tokenForAccount(accountId);
    if (!token) return reply.code(400).send({ error: 'invalid_account', message: '账号无效' });
    if (!Array.isArray(ids) || !ids.length) {
      return reply.code(400).send({ error: 'invalid_input', message: '没有选中记录' });
    }
    if (ids.length > IMPORT_MAX) {
      return reply.code(413).send({ error: 'too_many_records', message: `单次最多 ${IMPORT_MAX} 条` });
    }
    const result = { deleted: 0, failed: 0, errors: [] };
    let cursor = 0;
    async function worker() {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        try {
          await deleteRecord(token, zoneId, id);
          result.deleted++;
          writeAudit({
            username: request.user.username, accountId, zoneId, zoneName,
            action: 'delete', detail: { source: 'bulk', recordId: id }, clientIp: clientIp(request),
          });
        } catch (e) {
          result.failed++;
          result.errors.push({ id, message: e instanceof CloudflareError ? e.message : String((e && e.message) || e) });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, ids.length) }, worker));
    return result;
  });

  // POST /api/zones/:zoneId/records/bulk-patch  { accountId, zoneName, ids:[], patch:{ttl?,proxied?} }
  fastify.post('/:zoneId/records/bulk-patch', async (request, reply) => {
    const { zoneId } = request.params;
    const { accountId, zoneName, ids, patch } = request.body || {};
    const token = tokenForAccount(accountId);
    if (!token) return reply.code(400).send({ error: 'invalid_account', message: '账号无效' });
    if (!Array.isArray(ids) || !ids.length) {
      return reply.code(400).send({ error: 'invalid_input', message: '没有选中记录' });
    }
    if (ids.length > IMPORT_MAX) {
      return reply.code(413).send({ error: 'too_many_records', message: `单次最多 ${IMPORT_MAX} 条` });
    }
    const wantTtl = patch && patch.ttl !== undefined ? Number(patch.ttl) : undefined;
    const ttl = Number.isFinite(wantTtl) && wantTtl > 0 ? wantTtl : undefined;
    const hasProxied = !!(patch && patch.proxied !== undefined);
    const proxied = hasProxied ? !!patch.proxied : undefined;
    if (ttl === undefined && !hasProxied) {
      return reply.code(400).send({ error: 'invalid_input', message: '没有要修改的字段' });
    }

    // `proxied` only applies to A/AAAA/CNAME, so look up each record's type and
    // apply it selectively rather than letting Cloudflare reject the whole batch.
    let typeById = null;
    if (hasProxied) {
      try {
        typeById = new Map((await listAllRecords(token, zoneId)).map((r) => [r.id, r.type]));
      } catch (e) {
        return onCfError(reply, e);
      }
    }

    const result = { updated: 0, skipped: 0, failed: 0, errors: [] };
    let cursor = 0;
    async function worker() {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        const body = {};
        if (ttl !== undefined) body.ttl = ttl;
        if (hasProxied && PROXYABLE.has(typeById.get(id))) {
          body.proxied = proxied;
          if (proxied) body.ttl = 1; // proxied records must use automatic TTL
        }
        if (!Object.keys(body).length) {
          result.skipped++; // e.g. proxied requested on a non-proxyable record
          continue;
        }
        try {
          const res = await patchRecord(token, zoneId, id, body);
          result.updated++;
          writeAudit({
            username: request.user.username, accountId, zoneId, zoneName,
            action: 'update', rrType: res.type, rrName: res.name,
            detail: { source: 'bulk', patch: body }, clientIp: clientIp(request),
          });
        } catch (e) {
          result.failed++;
          result.errors.push({ id, message: e instanceof CloudflareError ? e.message : String((e && e.message) || e) });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, ids.length) }, worker));
    return result;
  });
}
