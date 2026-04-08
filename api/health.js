// ====================================================================
// api/health.js — simple health check for verifying deployment
// Hit https://your-bridge.vercel.app/api/health
// ====================================================================

module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 200;
  res.send(JSON.stringify({
    ok: true,
    service: 'preppy-bridge',
    time: new Date().toISOString(),
    env: {
      attio: !!process.env.ATTIO_API_KEY,
      apollo: !!process.env.APOLLO_API_KEY,
      secret: !!process.env.WEBHOOK_SHARED_SECRET,
      slack: !!process.env.SLACK_ALERT_WEBHOOK_URL,
    },
  }));
};
