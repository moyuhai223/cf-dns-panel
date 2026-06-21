// Tiny fetch wrapper. Paths are given WITHOUT a leading slash, e.g. 'api/auth/status';
// the Vite base (import.meta.env.BASE_URL, always ends with '/') is prepended so the
// client works both at the domain root and under a reverse-proxy sub-path.
const BASE = import.meta.env.BASE_URL;

function buildUrl(path, query) {
  const url = new URL(BASE + path, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }
  return url;
}

async function request(method, path, { body, query } = {}) {
  const res = await fetch(buildUrl(path, query), {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty / non-JSON body */
  }

  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `请求失败 (HTTP ${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (path, query) => request('GET', path, { query }),
  post: (path, body) => request('POST', path, { body }),
  put: (path, body) => request('PUT', path, { body }),
  del: (path, query) => request('DELETE', path, { query }),
};
