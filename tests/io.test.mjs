import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toCsv,
  parseCsv,
  parseImport,
  normalizeRecord,
  csvEscape,
  simplify,
  looksLikeBind,
  parseBind,
  toBind,
} from '../web/src/dnsio.js';
import { sanitizeRecord, toFqdn, recordKey } from '../server/cf/records-util.js';
import { syncRecords, SyncError } from '../server/cf/sync.js';

/* ----------------------------- dnsio (CSV/JSON) ---------------------------- */

test('csvEscape quotes fields with comma/quote/newline', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
  assert.equal(csvEscape(undefined), '');
});

test('CSV round-trip preserves commas, quotes, and field types', () => {
  const recs = [
    { type: 'TXT', name: 'a.example.com', content: 'v=spf1 include:_spf.google.com ~all', ttl: 1, proxied: false, priority: undefined },
    { type: 'TXT', name: 'b.example.com', content: 'hello, "world", end', ttl: 300, proxied: false, priority: undefined },
    { type: 'A', name: 'www.example.com', content: '1.2.3.4', ttl: 1, proxied: true, priority: undefined },
    { type: 'MX', name: 'example.com', content: 'mail.example.com', ttl: 3600, proxied: false, priority: 10 },
  ];
  const parsed = parseImport(toCsv(recs));
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].content, 'v=spf1 include:_spf.google.com ~all');
  assert.equal(parsed[1].content, 'hello, "world", end');
  assert.equal(parsed[2].type, 'A');
  assert.equal(parsed[2].proxied, true);
  assert.equal(parsed[3].type, 'MX');
  assert.equal(parsed[3].priority, 10);
  assert.equal(parsed[3].ttl, 3600);
});

test('parseImport accepts a JSON array', () => {
  const json = JSON.stringify([{ type: 'a', name: 'www', content: '1.1.1.1' }]);
  const recs = parseImport(json);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].type, 'A'); // uppercased
  assert.equal(recs[0].ttl, 1); // default
  assert.equal(recs[0].proxied, false);
  assert.equal(recs[0].priority, undefined);
});

test('parseImport accepts a { records: [...] } JSON object', () => {
  const recs = parseImport('{"records":[{"type":"TXT","name":"x","content":"y"}]}');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].type, 'TXT');
});

test('parseImport handles a UTF-8 BOM prefix', () => {
  const csv = '﻿' + 'type,name,content\nA,www,1.2.3.4';
  const recs = parseImport(csv);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].type, 'A');
  assert.equal(recs[0].name, 'www');
});

test('parseImport accepts CSV without a header (canonical order)', () => {
  const recs = parseImport('A,www,1.2.3.4,1,false,');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].name, 'www');
  assert.equal(recs[0].content, '1.2.3.4');
});

test('parseImport ignores blank lines', () => {
  const recs = parseImport('type,name,content\n\nA,www,1.2.3.4\n\n');
  assert.equal(recs.length, 1);
});

test('normalizeRecord coerces proxied truthiness and ttl/priority', () => {
  assert.equal(normalizeRecord({ proxied: 'true' }).proxied, true);
  assert.equal(normalizeRecord({ proxied: '1' }).proxied, true);
  assert.equal(normalizeRecord({ proxied: 'yes' }).proxied, true);
  assert.equal(normalizeRecord({ proxied: 'false' }).proxied, false);
  assert.equal(normalizeRecord({ proxied: '' }).proxied, false);
  assert.equal(normalizeRecord({ ttl: '' }).ttl, 1);
  assert.equal(normalizeRecord({ ttl: 'abc' }).ttl, 1);
  assert.equal(normalizeRecord({ ttl: '300' }).ttl, 300);
  assert.equal(normalizeRecord({ priority: '' }).priority, undefined);
  assert.equal(normalizeRecord({ priority: '5' }).priority, 5);
});

test('parseCsv handles quoted newlines inside a field', () => {
  const rows = parseCsv('a,"b\nc",d');
  assert.deepEqual(rows, [['a', 'b\nc', 'd']]);
});

/* --------------------------- records-util (server) ------------------------- */

test('toFqdn qualifies relative names within the zone', () => {
  const z = 'example.com';
  assert.equal(toFqdn('@', z), 'example.com');
  assert.equal(toFqdn('', z), 'example.com');
  assert.equal(toFqdn('www', z), 'www.example.com');
  assert.equal(toFqdn('www.example.com', z), 'www.example.com');
  assert.equal(toFqdn('www.example.com.', z), 'www.example.com'); // trailing dot stripped
  assert.equal(toFqdn('WWW.Example.Com', z), 'WWW.Example.Com'); // already fqdn (case-insensitive match)
  assert.equal(toFqdn('*', z), '*.example.com');
  assert.equal(toFqdn('a.b', z), 'a.b.example.com');
});

test('recordKey is case-insensitive on name and type', () => {
  assert.equal(recordKey('a', 'WWW.Example.com'), recordKey('A', 'www.example.COM'));
  assert.notEqual(recordKey('A', 'www.example.com'), recordKey('TXT', 'www.example.com'));
});

test('sanitizeRecord only sets proxied for A/AAAA/CNAME and forces auto TTL when proxied', () => {
  const a = sanitizeRecord({ type: 'A', name: 'w', content: '1.2.3.4', ttl: 300, proxied: true });
  assert.equal(a.proxied, true);
  assert.equal(a.ttl, 1); // proxied -> automatic TTL

  const txt = sanitizeRecord({ type: 'TXT', name: 'w', content: 'hi', ttl: 300, proxied: true });
  assert.equal('proxied' in txt, false); // proxied ignored for non-proxyable types
  assert.equal(txt.ttl, 300);

  const mx = sanitizeRecord({ type: 'MX', name: 'w', content: 'mail', priority: '20' });
  assert.equal(mx.priority, 20);
  assert.equal(mx.ttl, 1); // default
});

/* --------------------------- review-fix regressions ------------------------ */

test('TXT content is preserved exactly; other types are trimmed', () => {
  assert.equal(normalizeRecord({ type: 'TXT', content: '  v=spf1 ~all  ' }).content, '  v=spf1 ~all  ');
  assert.equal(normalizeRecord({ type: 'A', content: '  1.2.3.4  ' }).content, '1.2.3.4');
});

test('normalizeRecord drops non-finite priority and falls back ttl', () => {
  assert.equal(normalizeRecord({ priority: 'abc' }).priority, undefined);
  assert.equal(normalizeRecord({ ttl: 'fast' }).ttl, 1);
});

test('structured data survives normalizeRecord and simplify', () => {
  const data = { priority: 1, weight: 5, port: 5060, target: 'sip.example.com' };
  assert.deepEqual(normalizeRecord({ type: 'SRV', content: '', data }).data, data);
  assert.deepEqual(simplify({ type: 'SRV', name: 'x', content: 'c', data: { a: 1 } }).data, { a: 1 });
});

test('parseImport does not mistake a data row for a header (fixes includes() bug)', () => {
  const recs = parseImport('A,type,name'); // a record literally named "type" with content "name"
  assert.equal(recs.length, 1);
  assert.equal(recs[0].type, 'A');
  assert.equal(recs[0].name, 'type');
  assert.equal(recs[0].content, 'name');
});

test('sanitizeRecord never forwards NaN ttl/priority to Cloudflare', () => {
  assert.equal(sanitizeRecord({ type: 'A', name: 'x', content: '1.2.3.4', ttl: 'fast' }).ttl, 1);
  assert.equal('priority' in sanitizeRecord({ type: 'MX', name: 'x', content: 'mail', priority: 'high' }), false);
});

test('sanitizeRecord uses structured data for SRV, folds priority in, drops content', () => {
  const srv = sanitizeRecord({
    type: 'SRV', name: '_sip._tcp.x', content: '5 5060 sip.x', priority: 10,
    data: { weight: 5, port: 5060, target: 'sip.x' },
  });
  assert.equal('content' in srv, false);
  assert.equal(srv.data.priority, 10);
  assert.equal(srv.data.weight, 5);
});

test('toFqdn leaves underscore ASCII labels untouched and punycodes IDN', () => {
  assert.equal(toFqdn('_dmarc', 'example.com'), '_dmarc.example.com');
  assert.equal(toFqdn('_acme-challenge.sub', 'example.com'), '_acme-challenge.sub.example.com');
  assert.equal(toFqdn('café', 'example.com'), 'xn--caf-dma.example.com');
});

/* ------------------------------ sync engine -------------------------------- */

test('syncRecords refuses an oversized record set before touching the network', async () => {
  // > MAX_RECORDS (5000) must reject up-front, before getZone/listAllRecords run,
  // so a fake token never reaches Cloudflare.
  const records = Array.from({ length: 5001 }, (_, i) => ({ type: 'A', name: `h${i}`, content: '1.2.3.4' }));
  await assert.rejects(
    () => syncRecords('faketoken', 'zoneid', { records, deleteMissing: true, zoneName: 'example.com' }),
    (e) => e instanceof SyncError && e.code === 'too_many_records',
  );
});

/* ------------------------------ BIND format -------------------------------- */

test('looksLikeBind detects BIND but not CSV/JSON', () => {
  assert.equal(looksLikeBind('www.x.com.\t1\tIN\tA\t1.2.3.4'), true);
  assert.equal(looksLikeBind(';; Domain: x.com.'), true);
  assert.equal(looksLikeBind('type,name,content\nA,www,1.2.3.4'), false);
  assert.equal(looksLikeBind('[{"type":"A"}]'), false);
});

test('parseBind parses a Cloudflare export, reads cf-proxied, skips SOA/NS', () => {
  const txt = [
    ';; SOA Record',
    'hostloc.tech\t3600\tIN\tSOA\tkip.ns.cloudflare.com. dns.cloudflare.com. 2053368469 10000 2400 604800 3600',
    ';; NS Records',
    'hostloc.tech.\t86400\tIN\tNS\tkip.ns.cloudflare.com.',
    ';; A Records',
    'www.hostloc.tech.\t1\tIN\tA\t193.123.224.129 ; cf_tags=cf-proxied:false',
    'arm.hostloc.tech.\t1\tIN\tA\t193.123.224.129 ; cf_tags=cf-proxied:true',
    'hostloc.tech.\t1\tIN\tMX\t10 mail.hostloc.tech.',
    'hostloc.tech.\t1\tIN\tTXT\t"v=spf1 include:_spf.google.com ~all"',
    'hostloc.tech.\t1\tIN\tCAA\t0 issue "letsencrypt.org"',
  ].join('\n');
  const recs = parseBind(txt);
  assert.equal(recs.length, 5); // SOA + NS skipped
  assert.equal(recs.find((r) => r.name === 'www.hostloc.tech').proxied, false);
  assert.equal(recs.find((r) => r.name === 'arm.hostloc.tech').proxied, true);
  const mx = recs.find((r) => r.type === 'MX');
  assert.equal(mx.priority, 10);
  assert.equal(mx.content, 'mail.hostloc.tech'); // trailing dot stripped
  assert.equal(recs.find((r) => r.type === 'TXT').content, 'v=spf1 include:_spf.google.com ~all');
  assert.deepEqual(recs.find((r) => r.type === 'CAA').data, {
    flags: 0,
    tag: 'issue',
    value: 'letsencrypt.org',
  });
});

test('BIND export -> parse round-trip keeps proxied and quoted-semicolon TXT', () => {
  const recs = [
    { type: 'A', name: 'www.x.com', content: '1.2.3.4', ttl: 1, proxied: true },
    { type: 'TXT', name: 'x.com', content: 'hello; with ; semicolons', ttl: 300, proxied: false },
    { type: 'MX', name: 'x.com', content: 'mail.x.com', ttl: 1, priority: 10 },
  ];
  const back = parseBind(toBind(recs, 'x.com'));
  assert.equal(back.length, 3);
  assert.equal(back.find((r) => r.type === 'A').proxied, true);
  assert.equal(back.find((r) => r.type === 'TXT').content, 'hello; with ; semicolons');
  assert.equal(back.find((r) => r.type === 'MX').priority, 10);
});
