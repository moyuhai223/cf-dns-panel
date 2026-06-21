import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toCsv,
  parseCsv,
  parseImport,
  normalizeRecord,
  csvEscape,
  simplify,
} from '../web/src/dnsio.js';
import { sanitizeRecord, toFqdn, recordKey } from '../server/cf/records-util.js';

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
