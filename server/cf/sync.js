import {
  listAllRecords,
  getZone,
  createRecord,
  updateRecord,
  deleteRecord,
  CloudflareError,
} from './client.js';
import { sanitizeRecord, toFqdn, recordKey } from './records-util.js';

const MANAGED = new Set(['SOA', 'NS']); // Cloudflare-managed; never created/updated/deleted
const CONCURRENCY = 6;
const MAX_RECORDS = 5000; // refuse pathologically large syncs (thousands of serial CF calls)

/** Typed error so callers can map to a 4xx instead of a generic 500. */
export class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Upsert `records` into a zone by (type, name). With deleteMissing, existing
 * records absent from `records` are deleted too (never SOA/NS). dryRun computes
 * the plan and writes nothing. onChange(action, cfRecord) fires per applied
 * create/update/delete (used for audit). Shared by snapshot restore.
 */
export async function syncRecords(
  token,
  zoneId,
  { zoneName, records, deleteMissing = false, dryRun = false, onChange } = {},
) {
  if (records.length > MAX_RECORDS) {
    throw new SyncError('too_many_records', `记录数 ${records.length} 超过上限 ${MAX_RECORDS},已拒绝`);
  }
  // Authoritative zone name (so relative names qualify correctly, like import).
  if (!zoneName) zoneName = (await getZone(token, zoneId)).name;
  const existing = await listAllRecords(token, zoneId);

  const byKey = new Map();
  for (const r of existing) {
    const k = recordKey(r.type, r.name);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }

  const result = { total: records.length, created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0, errors: [] };
  const plan = [];
  for (let i = 0; i < records.length; i++) {
    const line = i + 1;
    const raw = records[i];
    let type;
    let name;
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('记录格式不是对象');
      type = String(raw.type || '').trim().toUpperCase();
      if (!type) throw new Error('缺少 type');
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

  const leftovers = [];
  for (const bucket of byKey.values()) {
    for (const r of bucket) if (!MANAGED.has(r.type)) leftovers.push(r);
  }

  // A full-sync that resolved to zero valid records would treat every live record
  // as "missing" and delete the whole zone. Refuse it (matches the import guard).
  // Fires for dryRun too so the preview surfaces the refusal instead of "delete all".
  if (deleteMissing && plan.length === 0) {
    throw new SyncError('empty_plan', '未解析出任何有效记录,已拒绝全量同步(否则会删光整个域名)');
  }

  const willCreate = plan.filter((p) => !p.targetId).length;
  const willUpdate = plan.filter((p) => p.targetId).length;
  const willDelete = deleteMissing ? leftovers.length : 0;

  if (dryRun) {
    return {
      dryRun: true,
      total: records.length,
      willCreate,
      willUpdate,
      willDelete,
      skipped: result.skipped,
      failed: result.failed,
      zoneName,
      errors: result.errors.sort((a, b) => (a.line || 0) - (b.line || 0)),
    };
  }

  let cursor = 0;
  async function worker() {
    while (cursor < plan.length) {
      const item = plan[cursor++];
      try {
        if (item.targetId) {
          const res = await updateRecord(token, zoneId, item.targetId, item.body);
          result.updated++;
          if (onChange) onChange('update', res);
        } else {
          const res = await createRecord(token, zoneId, item.body);
          result.created++;
          if (onChange) onChange('create', res);
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
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, plan.length) }, worker));

  if (deleteMissing && leftovers.length) {
    let dc = 0;
    async function delWorker() {
      while (dc < leftovers.length) {
        const r = leftovers[dc++];
        try {
          await deleteRecord(token, zoneId, r.id);
          result.deleted++;
          if (onChange) onChange('delete', r);
        } catch (e) {
          result.failed++;
          result.errors.push({
            type: r.type, name: r.name,
            message: e instanceof CloudflareError ? e.message : String((e && e.message) || e),
          });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, leftovers.length) }, delWorker));
  }

  result.errors.sort((a, b) => (a.line || 0) - (b.line || 0));
  result.zoneName = zoneName;
  return result;
}
