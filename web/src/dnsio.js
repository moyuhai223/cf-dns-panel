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
  if (Array.isArray(r.tags) && r.tags.length) out.tags = r.tags; // JSON only
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
  if (Array.isArray(r.tags)) out.tags = r.tags; // preserve tags (JSON)
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

  if (looksLikeBind(t)) {
    return parseBind(t).map(normalizeRecord);
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

/* --------------------------- BIND zone-file format ------------------------- */
// Matches Cloudflare's "Export" (.txt): `<name>. <ttl> IN <TYPE> <rdata>` with an
// optional trailing `; cf_tags=cf-proxied:true|false` comment. SOA/NS records are
// Cloudflare-managed and skipped on import.

const BIND_PROXYABLE = new Set(['A', 'AAAA', 'CNAME']);
const BIND_LINE = /^(\S+)\s+(?:(\d+)\s+)?(?:IN\s+)?([A-Za-z][A-Za-z0-9]*)\s+(.*)$/;

const stripTrailingDot = (s) => String(s).replace(/\.$/, '');
const ensureTrailingDot = (s) => (String(s).endsWith('.') ? String(s) : String(s) + '.');

/** Heuristic: does this text look like a BIND zone file (vs CSV/JSON)? */
export function looksLikeBind(t) {
  return (
    /^\s*;;/.test(t) ||
    /[ \t]IN[ \t]+(?:A|AAAA|CNAME|MX|TXT|NS|SOA|CAA|SRV|PTR|SPF|NAPTR|SSHFP|TLSA|DS|URI|SVCB|HTTPS|LOC|CERT)\b/i.test(
      t,
    )
  );
}

function bindQuoteTxt(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function bindUnquoteTxt(rdata) {
  const parts = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(rdata))) parts.push(m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  return parts.length ? parts.join('') : rdata.trim();
}

function bindRdata(r) {
  switch (r.type) {
    case 'MX':
      return `${r.priority ?? 0}\t${ensureTrailingDot(r.content)}`;
    case 'TXT':
      return bindQuoteTxt(r.content);
    case 'CAA':
      return r.data ? `${r.data.flags ?? 0} ${r.data.tag} "${r.data.value}"` : r.content;
    case 'SRV':
      return r.data
        ? `${r.data.priority ?? 0}\t${r.data.weight ?? 0}\t${r.data.port ?? 0}\t${ensureTrailingDot(r.data.target || '')}`
        : r.content;
    case 'CNAME':
    case 'NS':
    case 'PTR':
      return ensureTrailingDot(r.content);
    default:
      return r.content;
  }
}

/** Generate a Cloudflare-style BIND zone file from records. */
export function toBind(records, zoneName) {
  const lines = [';; Exported by cf-dns-panel'];
  if (zoneName) lines.push(`;; Domain:     ${ensureTrailingDot(zoneName)}`);
  lines.push('');
  for (const r of records) {
    if (r.type === 'SOA') continue; // not reconstructable / Cloudflare-managed
    let line = `${ensureTrailingDot(r.name)}\t${r.ttl || 1}\tIN\t${r.type}\t${bindRdata(r)}`;
    if (BIND_PROXYABLE.has(r.type)) line += ` ; cf_tags=cf-proxied:${r.proxied ? 'true' : 'false'}`;
    lines.push(line);
  }
  return lines.join('\n') + '\n';
}

/** Drop the trailing `;` comment from a BIND line, ignoring `;` inside quotes. */
function stripBindComment(line) {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== '\\') inQuotes = !inQuotes;
    else if (c === ';' && !inQuotes) return line.slice(0, i);
  }
  return line;
}

function bindLineToRecord(type, name, ttl, rdata, proxied) {
  const base = { type, name: stripTrailingDot(name), ttl, proxied: false };
  switch (type) {
    case 'A':
    case 'AAAA':
      return { ...base, content: rdata.trim(), proxied };
    case 'CNAME':
      return { ...base, content: stripTrailingDot(rdata.trim()), proxied };
    case 'TXT':
      return { ...base, content: bindUnquoteTxt(rdata) };
    case 'MX': {
      const p = rdata.trim().split(/\s+/);
      const priority = Number(p[0]);
      return {
        ...base,
        content: stripTrailingDot(p.slice(1).join(' ')),
        priority: Number.isFinite(priority) ? priority : 0,
      };
    }
    case 'CAA': {
      const mm = rdata.trim().match(/^(\d+)\s+(\S+)\s+"?(.*?)"?$/);
      return mm
        ? { ...base, content: rdata.trim(), data: { flags: Number(mm[1]), tag: mm[2], value: mm[3] } }
        : { ...base, content: rdata.trim() };
    }
    case 'SRV': {
      const p = rdata.trim().split(/\s+/);
      return p.length >= 4
        ? {
            ...base,
            content: rdata.trim(),
            data: {
              priority: Number(p[0]),
              weight: Number(p[1]),
              port: Number(p[2]),
              target: stripTrailingDot(p[3]),
            },
          }
        : { ...base, content: rdata.trim() };
    }
    default:
      return { ...base, content: rdata.trim() };
  }
}

/** Parse a BIND zone file into records. Skips comments and SOA/NS (CF-managed). */
export function parseBind(text) {
  const lines = String(text)
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
  const out = [];
  for (const raw of lines) {
    const tag = raw.match(/cf-proxied:(true|false)/i);
    const proxied = tag ? tag[1].toLowerCase() === 'true' : false;
    const line = stripBindComment(raw).trim();
    if (!line || line[0] === ';') continue;
    const m = line.match(BIND_LINE);
    if (!m) continue;
    const type = m[3].toUpperCase();
    if (type === 'SOA' || type === 'NS') continue;
    out.push(bindLineToRecord(type, m[1], m[2] ? Number(m[2]) : 1, m[4], proxied));
  }
  return out;
}
