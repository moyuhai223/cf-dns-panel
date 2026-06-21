// Pure CSV/JSON helpers for DNS import/export. No DOM access — unit-testable.

export const CSV_HEADERS = ['type', 'name', 'content', 'ttl', 'proxied', 'priority'];

/** Reduce a Cloudflare record object to the exported field set (keeps structured data). */
export function simplify(r) {
  const out = {
    type: r.type,
    name: r.name,
    content: r.content,
    ttl: r.ttl,
    proxied: !!r.proxied,
    priority: r.priority,
  };
  if (r.data && typeof r.data === 'object') out.data = r.data; // SRV/CAA/… (JSON only)
  return out;
}

/** Quote a CSV field if it contains a comma, quote, or newline (RFC 4180). */
export function csvEscape(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Build a CSV document (header + rows) from Cloudflare records. */
export function toCsv(records) {
  const lines = [CSV_HEADERS.join(',')];
  for (const r of records) {
    lines.push(
      [r.type, r.name, r.content, r.ttl, r.proxied ? 'true' : 'false', r.priority ?? '']
        .map(csvEscape)
        .join(','),
    );
  }
  return lines.join('\n');
}

/** Parse a CSV document into an array of string-cell rows (RFC 4180-ish). Strips a leading BOM. */
export function parseCsv(text) {
  const s = String(text)
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let started = false; // did the current row have any content?

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
      started = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
      started = true;
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      started = false;
    } else {
      field += c;
      started = true;
    }
  }
  if (started || field !== '') {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Coerce a loose record (from CSV/JSON) into the panel's record shape.
 * Content is NOT trimmed for TXT (leading/trailing spaces are significant there);
 * trimmed for other types to tolerate sloppy hand-pasted CSV. ttl/priority only
 * become numbers when finite.
 */
export function normalizeRecord(r) {
  const type = String(r.type || '').trim().toUpperCase();
  const ttl = Number(r.ttl);
  const pri = Number(r.priority);
  const rawContent = r.content == null ? '' : String(r.content);
  const proxiedStr = String(r.proxied).trim().toLowerCase();
  const out = {
    type,
    name: String(r.name == null ? '' : r.name).trim(),
    content: type === 'TXT' ? rawContent : rawContent.trim(),
    ttl: Number.isFinite(ttl) && ttl > 0 ? ttl : 1,
    proxied: r.proxied === true || proxiedStr === 'true' || proxiedStr === '1' || proxiedStr === 'yes',
    priority: r.priority === '' || r.priority == null || !Number.isFinite(pri) ? undefined : pri,
  };
  if (r.data && typeof r.data === 'object') out.data = r.data; // preserve structured (JSON)
  return out;
}

/**
 * Parse pasted/uploaded text into normalized records. Accepts JSON (array, or
 * { records: [...] }) or CSV. A header row is recognised only when the first two
 * cells are exactly "type" and "name"; otherwise the canonical column order is
 * assumed. Throws on malformed JSON.
 */
export function parseImport(text) {
  const t = String(text).replace(/^﻿/, '').trim();
  if (!t) return [];

  if (t[0] === '[' || t[0] === '{') {
    const data = JSON.parse(t);
    const arr = Array.isArray(data) ? data : Array.isArray(data.records) ? data.records : [];
    return arr.map(normalizeRecord);
  }

  const rows = parseCsv(t).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length === 0) return [];

  const first = rows[0].map((h) => h.trim().toLowerCase());
  let header = CSV_HEADERS.slice();
  let start = 0;
  // Only treat row 0 as a header when columns 0/1 are exactly type/name — data rows
  // put record-type values (a/cname/txt/…) in column 0, so this won't eat a record.
  if (first[0] === 'type' && first[1] === 'name') {
    header = first;
    start = 1;
  }
  const col = (k) => header.indexOf(k);

  const out = [];
  for (let i = start; i < rows.length; i++) {
    const cells = rows[i];
    const get = (k) => {
      const j = col(k);
      return j >= 0 && cells[j] != null ? String(cells[j]) : '';
    };
    out.push(
      normalizeRecord({
        type: get('type'),
        name: get('name'),
        content: get('content'),
        ttl: get('ttl'),
        proxied: get('proxied'),
        priority: get('priority'),
      }),
    );
  }
  return out;
}
