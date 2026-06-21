import { db } from '../db.js';
import { decrypt } from '../crypto.js';
import { requireAuth, clientIp } from '../middleware/auth.js';
import {
  listRecords,
  listAllRecords,
  createRecord,
  updateRecord,
  deleteRecord,
  CloudflareError,
} from '../cf/client.js';
import { sanitizeRecord, toFqdn, recordKey } from '../cf/records-util.js';
import { writeAudit } from '../services/audit.js';

const IMPORT_MAX = 1000; // hard cap on records accepted per import request
const IMPORT_CONCURRENCY = 6; // parallel Cloudflare writes during an import

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
  //   { accountId, zoneName, records: [{type,name,content,ttl,proxied,priority}] }
  // Upsert by (type, name): an incoming record matching an existing one OVERWRITES
  // it; otherwise it is created. Existing records absent from the payload are left
  // untouched (no deletion).
  fastify.post('/:zoneId/import', async (request, reply) => {
    const { zoneId } = request.params;
    const { accountId, zoneName, records } = request.body || {};
    const token = tokenForAccount(accountId);
    if (!token) return reply.code(400).send({ error: 'invalid_account', message: '账号无效' });
    if (!zoneName) return reply.code(400).send({ error: 'invalid_input', message: '缺少 zoneName' });
    if (!Array.isArray(records) || records.length === 0) {
      return reply.code(400).send({ error: 'invalid_input', message: '没有可导入的记录' });
    }
    if (records.length > IMPORT_MAX) {
      return reply.code(413).send({ error: 'too_many_records', message: `单次最多导入 ${IMPORT_MAX} 条` });
    }

    let existing;
    try {
      existing = await listAllRecords(token, zoneId);
    } catch (e) {
      return onCfError(reply, e);
    }

    // Buckets of existing records per (type, fqdn). When several records share a
    // key (round-robin A, multi-MX), an incoming row first claims the existing
    // record with matching content, so a sibling's identity is never clobbered;
    // otherwise it claims the next unclaimed one (positional fallback).
    const byKey = new Map();
    for (const r of existing) {
      const k = recordKey(r.type, r.name);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }

    const result = { total: records.length, created: 0, updated: 0, failed: 0, errors: [] };

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

    // Phase 2 — execute the plan with bounded concurrency. Counter increments are
    // race-free: they run synchronously between awaits on JS's single thread.
    const audit = (action, res) =>
      writeAudit({
        username: request.user.username, accountId, zoneId, zoneName,
        action, rrType: res.type, rrName: res.name,
        detail: { source: 'import', content: res.content }, clientIp: clientIp(request),
      });
    let cursor = 0;
    async function worker() {
      while (cursor < plan.length) {
        const item = plan[cursor++];
        try {
          if (item.targetId) {
            const res = await updateRecord(token, zoneId, item.targetId, item.body);
            result.updated++;
            audit('update', res);
          } else {
            const res = await createRecord(token, zoneId, item.body);
            result.created++;
            audit('create', res);
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

    result.errors.sort((a, b) => a.line - b.line);
    return result;
  });
}
