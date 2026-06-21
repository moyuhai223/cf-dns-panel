import { db } from '../db.js';
import { decrypt } from '../crypto.js';
import { requireAuth, clientIp } from '../middleware/auth.js';
import {
  listRecords,
  createRecord,
  updateRecord,
  deleteRecord,
  CloudflareError,
} from '../cf/client.js';
import { writeAudit } from '../services/audit.js';

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

// Whitelist the fields Cloudflare accepts; the UI may send extras.
function sanitize(record) {
  const { type, name, content, ttl, proxied, priority, comment, tags, data } = record || {};
  const out = { type, name, content, ttl: ttl ? Number(ttl) : 1 };
  if (proxied !== undefined) out.proxied = !!proxied;
  if (priority !== undefined && priority !== null && priority !== '') out.priority = Number(priority);
  if (comment) out.comment = comment;
  if (Array.isArray(tags)) out.tags = tags;
  if (data && typeof data === 'object') out.data = data; // structured SRV/CAA/etc.
  return out;
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
      const result = await createRecord(token, zoneId, sanitize(record));
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
      const result = await updateRecord(token, zoneId, recordId, sanitize(record));
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
}
