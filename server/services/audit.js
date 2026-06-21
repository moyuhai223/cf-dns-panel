import { db } from '../db.js';

const insertStmt = db.prepare(`
  INSERT INTO audit_log
    (username, account_id, zone_id, zone_name, action, rr_type, rr_name, detail_json, client_ip)
  VALUES
    (@username, @account_id, @zone_id, @zone_name, @action, @rr_type, @rr_name, @detail_json, @client_ip)
`);

export function writeAudit(entry) {
  insertStmt.run({
    username: entry.username ?? null,
    account_id: entry.accountId ?? null,
    zone_id: entry.zoneId ?? null,
    zone_name: entry.zoneName ?? null,
    action: entry.action ?? null,
    rr_type: entry.rrType ?? null,
    rr_name: entry.rrName ?? null,
    detail_json: entry.detail ? JSON.stringify(entry.detail) : null,
    client_ip: entry.clientIp ?? null,
  });
}

export function listAudit({ page = 1, perPage = 50 } = {}) {
  const offset = (page - 1) * perPage;
  const rows = db
    .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(perPage, offset);
  const total = db.prepare('SELECT COUNT(*) AS c FROM audit_log').get().c;
  return { rows, total, page, perPage };
}
