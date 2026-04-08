// ====================================================================
// lib/respond.js — Vercel response helpers.
//
// Uses res.send(JSON.stringify(...)) instead of res.json() because the
// latter has been unreliable for early-return paths in our prior Vercel
// projects (Outbound Flywheel). Always set Content-Type explicitly
// BEFORE any logic runs.
// ====================================================================

function setJsonHeaders(res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
}

function ok(res, payload = { ok: true }) {
  setJsonHeaders(res);
  res.statusCode = 200;
  res.send(JSON.stringify(payload));
}

function bad(res, msg, status = 400) {
  setJsonHeaders(res);
  res.statusCode = status;
  res.send(JSON.stringify({ ok: false, error: msg }));
}

function fail(res, err) {
  setJsonHeaders(res);
  res.statusCode = 500;
  const msg = err?.message || String(err);
  console.error('[bridge:fail]', msg, err?.stack);
  res.send(JSON.stringify({ ok: false, error: msg }));
}

function verifySecret(req) {
  const required = process.env.WEBHOOK_SHARED_SECRET;
  if (!required) return true; // disabled
  const provided = req.query?.secret || req.headers['x-bridge-secret'];
  return provided === required;
}

module.exports = { setJsonHeaders, ok, bad, fail, verifySecret };
