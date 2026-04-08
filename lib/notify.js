// ====================================================================
// lib/notify.js — Slack alerts for bridge errors and dead-man's-switch
// ====================================================================

const { request } = require('./http');

async function alert(message, context = {}) {
  console.error('[bridge:alert]', message, context);
  const url = process.env.SLACK_ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await request(url, {
      method: 'POST',
      body: {
        text: `🚨 *Preppy Bridge Alert*\n${message}\n\`\`\`${JSON.stringify(context, null, 2).slice(0, 1500)}\`\`\``,
      },
    });
  } catch (err) {
    console.error('[bridge:alert] slack post failed', err.message);
  }
}

module.exports = { alert };
