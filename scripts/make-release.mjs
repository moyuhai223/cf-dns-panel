// One-off helper: create (or update) the GitHub Release for a tag, using the
// CHANGELOG section as the body. Token comes from the GH_TOKEN env var — never
// passed on argv and never printed. Not part of the app; lives under scripts/.
//
//   GH_TOKEN=<pat> node scripts/make-release.mjs v1.0.0
//
import { readFileSync } from 'node:fs';

const tag = process.argv[2] || 'v1.0.0';
const repo = process.env.RELEASE_REPO || 'moyuhai223/cf-dns-panel';
const token = process.env.GH_TOKEN;
if (!token) {
  console.error('no token: set GH_TOKEN'); process.exit(3);
}

// Pull the matching "## [<version>]" section out of CHANGELOG.md as the body.
const version = tag.replace(/^v/, '');
const md = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const lines = md.split('\n');
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
let body = '';
if (start >= 0) {
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  if (end < 0) end = lines.length;
  body = lines
    .slice(start + 1, end)
    .filter((l) => !/^\[[^\]]+\]:\shttps?:/.test(l)) // drop link-reference defs
    .join('\n')
    .trim();
}
if (!body) body = `Release ${tag}.`;

const api = `https://api.github.com/repos/${repo}`;
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'cf-dns-panel-release',
  'X-GitHub-Api-Version': '2022-11-28',
};

const payload = { tag_name: tag, name: tag, body, draft: false, prerelease: false };

// Idempotent: update the release if one already exists for this tag, else create.
const existing = await fetch(`${api}/releases/tags/${tag}`, { headers });
let res;
if (existing.status === 200) {
  const cur = await existing.json();
  res = await fetch(`${api}/releases/${cur.id}`, { method: 'PATCH', headers, body: JSON.stringify(payload) });
  console.log(`updating existing release id=${cur.id}`);
} else {
  res = await fetch(`${api}/releases`, { method: 'POST', headers, body: JSON.stringify(payload) });
  console.log('creating new release');
}

const out = await res.json();
if (!res.ok) {
  console.error(`FAILED ${res.status}: ${out.message || ''}`);
  if (out.errors) console.error(JSON.stringify(out.errors));
  process.exit(1);
}
console.log(`OK ${res.status}  ${out.html_url}`);
