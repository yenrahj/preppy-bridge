// ====================================================================
// lib/http.js — minimal fetch wrapper with retries and JSON helpers
// ====================================================================

const fetch = require('node-fetch');

async function request(url, opts = {}, retries = 2) {
  const { method = 'GET', headers = {}, body, timeoutMs = 20000 } = opts;

  const fetchOpts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };
  if (body !== undefined) {
    fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      fetchOpts.signal = ctrl.signal;

      const res = await fetch(url, fetchOpts);
      clearTimeout(timer);

      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }

      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${res.statusText} — ${text.slice(0, 500)}`);
        err.status = res.status;
        err.body = json || text;
        // 429 / 5xx → retry; 4xx → fail fast
        if (res.status === 429 || res.status >= 500) {
          lastErr = err;
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }
      return json;
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      await sleep(500 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { request, sleep };
