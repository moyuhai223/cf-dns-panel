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

export async function deleteRecord(token, zoneId, recordId) {
  const data = await cfFetch(token, 'DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
  return data.result;
}
