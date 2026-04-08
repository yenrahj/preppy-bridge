// ====================================================================
// api/apollo-webhook.js
//
// Single endpoint handling all 5 Apollo workflow webhook payloads:
//
//   1. "Preppy Flywheel: Email Replied → Webhook"
//   2. "Preppy Flywheel: Email Bounced → Webhook"
//   3. "Preppy Flywheel: Contact Finished Sequence → Webhook"
//   4. "Preppy Flywheel: Email Opened → Webhook"
//   5. "Preppy Flywheel: Meeting Booked → Webhook"
//
// Routing strategy: same as the Attio handler — prefer a ?event= hint
// in the webhook URL, fall back to sniffing the payload shape. When you
// configure each Apollo workflow's webhook URL, add the hint:
//
//   https://your-bridge.vercel.app/api/apollo-webhook?event=replied&secret=...
//   https://your-bridge.vercel.app/api/apollo-webhook?event=opened&secret=...
//   https://your-bridge.vercel.app/api/apollo-webhook?event=bounced&secret=...
//   https://your-bridge.vercel.app/api/apollo-webhook?event=finished&secret=...
//   https://your-bridge.vercel.app/api/apollo-webhook?event=meeting&secret=...
// ====================================================================

const { ok, bad, fail, verifySecret } = require('../lib/respond');
const attio = require('../lib/attio');
const apollo = require('../lib/apollo');
const { shouldWriteOpenEvent } = require('../lib/dedupe');
const { alert } = require('../lib/notify');
const { ENABLE_REDUNDANT_APOLLO_REMOVAL } = require('../config');

const VALID_EVENTS = new Set(['replied', 'opened', 'bounced', 'finished', 'meeting']);

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') return bad(res, 'method not allowed', 405);
  if (!verifySecret(req)) return bad(res, 'unauthorized', 401);

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { return bad(res, 'invalid json'); }
  }
  if (!body) return bad(res, 'empty body');

  const event = (req.query?.event || '').toLowerCase();
  if (!VALID_EVENTS.has(event)) {
    await alert('Apollo webhook missing/invalid ?event= hint', { event, sample: body });
    return bad(res, `must specify ?event=replied|opened|bounced|finished|meeting`);
  }

  try {
    console.log('[apollo-webhook]', event, JSON.stringify(body).slice(0, 500));
    const result = await dispatch(event, body);
    return ok(res, { event, result });
  } catch (err) {
    await alert('apollo-webhook handler error', { event, error: err.message, body });
    return fail(res, err);
  }
};

// --------------------------------------------------------------------

async function dispatch(event, body) {
  const ctx = extractContext(body);
  if (!ctx.email && !ctx.apolloContactId) {
    throw new Error('apollo webhook payload missing both email and contact_id');
  }

  // Find the Attio person record. Prefer email lookup since Apollo Contact ID
  // is stored there but not always indexed.
  const attioPerson = ctx.email
    ? await attio.findPersonByEmail(ctx.email)
    : null;
  if (!attioPerson) {
    // Don't blow up — log and move on. The contact may exist in Apollo but
    // not yet in Attio (e.g., if Rebecca enrolled them via the search outbox
    // but they haven't synced yet).
    console.warn(`[apollo-webhook:${event}] no Attio person for email ${ctx.email}`);
    return { skipped: 'no_attio_person', email: ctx.email };
  }
  const attioPersonId = attioPerson?.id?.record_id;

  switch (event) {
    case 'replied':   return handleReplied(attioPersonId, ctx);
    case 'opened':    return handleOpened(attioPersonId, ctx);
    case 'bounced':   return handleBounced(attioPersonId, ctx);
    case 'finished':  return handleFinished(attioPersonId, ctx);
    case 'meeting':   return handleMeeting(attioPersonId, ctx);
  }
}

// --------------------------------------------------------------------
// Per-event handlers
// --------------------------------------------------------------------

async function handleReplied(personId, ctx) {
  const now = new Date().toISOString();
  await attio.setEngagement(personId, {
    outreachStage: 'Engaged',
    lastEngagementDate: now,
    lastEngagementType: 'Replied',
    apolloSequenceStatus: 'Paused',
  });

  // Critical: post the reply body as an Attio note so Rebecca has something
  // to read in "Needs Human Touch." This is the only way the reply content
  // gets into Attio since email sync isn't connected for Rebecca yet.
  if (ctx.replyBody || ctx.replySubject) {
    await attio.createNoteOnPerson(personId, {
      title: ctx.replySubject ? `Reply: ${ctx.replySubject}` : 'Reply received',
      content: ctx.replyBody || '(no body in webhook payload)',
    });
  }

  // Belt-and-suspenders: explicitly remove from sequences. Apollo's native
  // "auto-remove on reply" should already have done this, but we don't
  // trust it 100%.
  if (ctx.apolloContactId && ENABLE_REDUNDANT_APOLLO_REMOVAL) {
    try {
      await apollo.removeContactFromAllSequences(ctx.apolloContactId);
    } catch (err) {
      console.warn('[replied] redundant remove failed', err.message);
    }
  }

  return { stage: 'Engaged', notePosted: !!ctx.replyBody };
}

async function handleOpened(personId, ctx) {
  // Apply dedupe — opens are noisy
  if (ctx.apolloContactId && !shouldWriteOpenEvent(ctx.apolloContactId)) {
    return { skipped: 'deduped' };
  }
  // Only update last-engagement-date and -type. Do NOT change Outreach Stage.
  // Open events should NOT trigger Needs Human Touch.
  await attio.setEngagement(personId, {
    lastEngagementDate: new Date().toISOString(),
    lastEngagementType: 'Opened',
  });
  return { stage: 'unchanged' };
}

async function handleBounced(personId, ctx) {
  await attio.setEngagement(personId, {
    lastEngagementDate: new Date().toISOString(),
    lastEngagementType: 'Bounced',
    apolloSequenceStatus: 'Bounced',
    outreachStage: 'Do Not Contact', // dead address — stop everything
  });
  if (ctx.apolloContactId && ENABLE_REDUNDANT_APOLLO_REMOVAL) {
    try { await apollo.removeContactFromAllSequences(ctx.apolloContactId); }
    catch (_) {}
  }
  return { stage: 'Do Not Contact' };
}

async function handleFinished(personId, ctx) {
  // Sequence completed naturally (all steps sent, no reply). Mark as such
  // but DON'T escalate to human touch — they didn't engage.
  await attio.setEngagement(personId, {
    apolloSequenceStatus: 'Finished',
  });
  return { stage: 'unchanged', sequenceStatus: 'Finished' };
}

async function handleMeeting(personId, ctx) {
  const now = new Date().toISOString();
  await attio.setEngagement(personId, {
    outreachStage: 'Meeting Booked',
    lastEngagementDate: now,
    lastEngagementType: 'Meeting Booked',
    apolloSequenceStatus: 'Paused',
  });
  if (ctx.apolloContactId && ENABLE_REDUNDANT_APOLLO_REMOVAL) {
    try { await apollo.removeContactFromAllSequences(ctx.apolloContactId); }
    catch (_) {}
  }
  return { stage: 'Meeting Booked' };
}

// --------------------------------------------------------------------
// Payload extraction — adjust during Phase 3 testing once you see the
// real shapes Apollo posts.
// --------------------------------------------------------------------

function extractContext(body) {
  // Apollo workflow webhooks typically wrap the contact under `contact`
  // and the email/event details at the top level. Defensive against
  // multiple shapes.
  const contact = body?.contact || body?.data?.contact || body || {};
  const email =
    contact?.email ||
    body?.email ||
    body?.data?.email ||
    null;

  return {
    email: typeof email === 'string' ? email.toLowerCase() : null,
    apolloContactId: contact?.id || body?.contact_id || null,
    firstName: contact?.first_name,
    lastName: contact?.last_name,
    title: contact?.title,
    company: contact?.organization_name || contact?.account_name,
    sequenceId: body?.emailer_campaign_id || body?.sequence_id || null,
    replyBody:
      body?.reply_body ||
      body?.email_body ||
      body?.message?.body_text ||
      body?.data?.body_text ||
      null,
    replySubject:
      body?.reply_subject ||
      body?.subject ||
      body?.message?.subject ||
      null,
  };
}
