// Thin Cloudflare REST v4 client built on the global fetch (Node >= 18).
// Every call returns the parsed `result`; failures throw CloudflareError carrying
// the structured `errors[]` so routes can surface them to the UI verbatim.

const CF_BASE = 'https://api.cloudflare.com/client/v4';

export class CloudflareError extends Error {
  constructor(message, errors, status) {
    super(message);
    this.name = 'CloudflareError';
    this.errors = errors || [];
    this.status = status;
  }
}

async function cfFetch(token, method, pathname, { query, body } = {}) {
  const url = new URL(CF_BASE + pathname);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new CloudflareError(`无法连接 Cloudflare API: ${err.message}`, [], 0);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }

  if (!data || data.success !== true) {
    const errors = data?.errors || [];
    const message =
      errors.map((e) => `${e.code ? `[${e.code}] ` : ''}${e.message}`).join('; ') ||
      `Cloudflare API 错误 (HTTP ${res.status})`;
    throw new CloudflareError(message, errors, res.status);
  }
  return data;
}

/**
 * Validate a token by exercising the capability the panel needs — reading zones.
 *
 * This works for BOTH user-owned tokens and ACCOUNT-owned tokens (the `cfat_`
 * prefix). The older `/user/tokens/verify` endpoint only accepts user-owned
 * tokens and rejects account-owned ones with code 1000, so we avoid it and use
 * `/zones` instead (which both token types can call given Zone:Read).
 * Returns the (possibly empty) first page of zones.
 */
export async function verifyToken(token) {
  const data = await cfFetch(token, 'GET', '/zones', { query: { per_page: 1 } });
  return data.result;
}

/** List every zone the token can see (handles pagination). */
export async function listZones(token) {
  const all = [];
  let page = 1;
  for (;;) {
    const data = await cfFetch(token, 'GET', '/zones', { query: { per_page: 50, page } });
    all.push(...data.result);
    const info = data.result_info;
    if (!info || page >= info.total_pages || data.result.length === 0) break;
    page += 1;
  }
  return all;
}

/** Fetch a single zone's metadata (used to derive the authoritative zone name). */
export async function getZone(token, zoneId) {
  const data = await cfFetch(token, 'GET', `/zones/${zoneId}`);
  return data.result;
}

export async function listRecords(token, zoneId, { type, name, page = 1, perPage = 100 } = {}) {
  return cfFetch(token, 'GET', `/zones/${zoneId}/dns_records`, {
    query: { type, name, page, per_page: perPage, order: 'type', direction: 'asc' },
  });
}

/** Fetch every DNS record in a zone (handles pagination). Used by export/import. */
export async function listAllRecords(token, zoneId) {
  const all = [];
  let page = 1;
  for (;;) {
    const data = await cfFetch(token, 'GET', `/zones/${zoneId}/dns_records`, {
      query: { per_page: 100, page, order: 'type', direction: 'asc' },
    });
    all.push(...data.result);
    const info = data.result_info;
    if (!info || page >= info.total_pages || data.result.length === 0) break;
    page += 1;
  }
  return all;
}

export async function createRecord(token, zoneId, record) {
  const data = await cfFetch(token, 'POST', `/zones/${zoneId}/dns_records`, { body: record });
  return data.result;
}

export async function updateRecord(token, zoneId, recordId, record) {
  const data = await cfFetch(token, 'PUT', `/zones/${zoneId}/dns_records/${recordId}`, { body: record });
  return data.result;
}

/** Partial update (e.g. just ttl or proxied) — used by bulk edits. */
export async function patchRecord(token, zoneId, recordId, patch) {
  const data = await cfFetch(token, 'PATCH', `/zones/${zoneId}/dns_records/${recordId}`, { body: patch });
  return data.result;
}

export async function deleteRecord(token, zoneId, recordId) {
  const data = await cfFetch(token, 'DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
  return data.result;
}

/* --------------------------- cache / zone settings ------------------------- */

/** Purge cache: body is { purge_everything: true } or { files: [urls] }. */
export async function purgeCache(token, zoneId, body) {
  const data = await cfFetch(token, 'POST', `/zones/${zoneId}/purge_cache`, { body });
  return data.result;
}

/** GET a single zone setting -> { id, value, editable, modified_on }. */
export async function getZoneSetting(token, zoneId, key) {
  const data = await cfFetch(token, 'GET', `/zones/${zoneId}/settings/${key}`);
  return data.result;
}

/** PATCH a single zone setting value. */
export async function patchZoneSetting(token, zoneId, key, value) {
  const data = await cfFetch(token, 'PATCH', `/zones/${zoneId}/settings/${key}`, { body: { value } });
  return data.result;
}

/* ------------------------------ rulesets ---------------------------------- */
// Cache Rules / Redirect Rules / Transform Rules all live in the Rulesets engine
// as the zone's entrypoint ruleset for a given phase.

/** Read a phase's entrypoint ruleset; returns { rules: [] } when none exists yet. */
export async function getPhaseEntrypoint(token, zoneId, phase) {
  try {
    const data = await cfFetch(token, 'GET', `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`);
    return data.result;
  } catch (e) {
    if (e instanceof CloudflareError && e.status === 404) return { rules: [] };
    throw e;
  }
}

/** Replace a phase's entrypoint rules with the given array. */
export async function putPhaseEntrypoint(token, zoneId, phase, rules) {
  const data = await cfFetch(token, 'PUT', `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, {
    body: { rules },
  });
  return data.result;
}
