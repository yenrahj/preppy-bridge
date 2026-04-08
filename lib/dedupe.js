// ====================================================================
// lib/dedupe.js — open-event dedupe
//
// Apollo open events are noisy: ~40% open rate × hundreds of contacts
// means thousands of opens/day, many of them duplicates from image
// preloaders. We collapse opens to "at most one per contact per window."
//
// IMPORTANT CAVEAT: This is an in-process Map, which means it only
// dedupes within a warm Lambda. Cold starts reset state. That's
// acceptable here because:
//   1. Worst case is one extra Attio write per cold start, not a flood.
//   2. The "Last Engagement Date" field is overwrite-safe.
//   3. Adding a real KV store (Vercel KV / Upstash) is a 1-line swap if
//      the noise becomes a problem in production.
//
// If you want hard dedupe across invocations, swap the Map for Vercel KV:
//   const { kv } = require('@vercel/kv');
//   await kv.set(`open:${contactId}`, Date.now(), { ex: WINDOW_SECONDS });
// ====================================================================

const { OPEN_EVENT_DEDUPE_WINDOW_MINUTES } = require('../config');

const _seen = new Map(); // contactId → lastSeenMs

function shouldWriteOpenEvent(contactId) {
  const now = Date.now();
  const last = _seen.get(contactId);
  const windowMs = OPEN_EVENT_DEDUPE_WINDOW_MINUTES * 60 * 1000;
  if (last && now - last < windowMs) return false;
  _seen.set(contactId, now);
  // Trim if Map grows too large (keep last 5000)
  if (_seen.size > 5000) {
    const cutoff = now - windowMs;
    for (const [k, v] of _seen) if (v < cutoff) _seen.delete(k);
  }
  return true;
}

module.exports = { shouldWriteOpenEvent };
