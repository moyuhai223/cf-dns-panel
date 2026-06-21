// Pure helpers for DNS record handling — no I/O, unit-testable in isolation.
import { domainToASCII } from 'node:url';

const PROXYABLE = new Set(['A', 'AAAA', 'CNAME']);
// Types Cloudflare expects as a structured `data` object rather than a content string.
const STRUCTURED = new Set(['SRV', 'CAA', 'SSHFP', 'TLSA', 'DS', 'NAPTR', 'URI', 'SMIMEA']);

/**
 * Whitelist the fields Cloudflare accepts and coerce types defensively.
 * - `proxied` only applies to A/AAAA/CNAME, and a proxied record must use auto TTL.
 * - ttl/priority are only set when they coerce to a finite number (never NaN/null).
 * - structured `data` (SRV/CAA/…) is authoritative when present; for those types the
 *   content string is dropped so it doesn't conflict with `data`.
 */
export function sanitizeRecord(record) {
  const r = record || {};
  const type = r.type;
  const out = { type, name: r.name, content: r.content };

  const ttl = Number(r.ttl);
  out.ttl = Number.isFinite(ttl) && ttl > 0 ? ttl : 1;

  if (PROXYABLE.has(type) && r.proxied !== undefined) {
    out.proxied = !!r.proxied;
    if (out.proxied) out.ttl = 1; // proxied records must use automatic TTL
  }

  if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
    out.data = { ...r.data };
    if (STRUCTURED.has(type)) delete out.content;
  }

  if (r.priority !== undefined && r.priority !== null && r.priority !== '') {
    const pri = Number(r.priority);
    if (Number.isFinite(pri)) {
      // SRV carries priority inside `data`; everything else (MX, URI) uses top-level.
      if (type === 'SRV' && out.data) {
        if (out.data.priority === undefined) out.data.priority = pri;
      } else {
        out.priority = pri;
      }
    }
  }

  if (r.comment) out.comment = r.comment;
  if (Array.isArray(r.tags)) out.tags = r.tags;
  return out;
}

/**
 * Punycode-encode a name only when it contains non-ASCII characters. Pure-ASCII
 * names (including underscore labels like _dmarc / _acme-challenge / _sip._tcp)
 * are returned untouched — domainToASCII would otherwise mangle or empty them.
 */
function asciiName(name) {
  if (/^[\x00-\x7F]*$/.test(name)) return name;
  try {
    return domainToASCII(name) || name;
  } catch {
    return name;
  }
}

/**
 * Normalise a record name to a fully-qualified name within `zoneName`, so imported
 * names (relative "www", root "@", already-qualified, or IDN) match Cloudflare's
 * stored punycode FQDNs. Trailing dots stripped; matching is case-insensitive.
 */
export function toFqdn(name, zoneName) {
  const zone = asciiName(String(zoneName || '').trim().replace(/\.$/, ''));
  const n = asciiName(String(name == null ? '' : name).trim().replace(/\.$/, ''));
  if (!n || n === '@') return zone;
  if (!zone) return n;
  const nl = n.toLowerCase();
  const zl = zone.toLowerCase();
  if (nl === zl || nl.endsWith('.' + zl)) return n;
  return `${n}.${zone}`;
}

/** Map key used to match an imported record against existing ones: type + FQDN. */
export function recordKey(type, fqdn) {
  return `${String(type).toUpperCase()}|${String(fqdn).toLowerCase()}`;
}
