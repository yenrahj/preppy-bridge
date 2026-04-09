// ====================================================================
// api/attio-webhook.js
//
// Handles Attio workflow webhook payloads for the simplified
// architecture. The bridge supports three events:
//
//   - drip_added:    Person added to Attio "Drip" list.
//                    Bridge mirrors them to the Apollo Bridge Drip list,
//                    where an Apollo workflow enrolls in a drip sequence.
//
//   - stage_changed: Outreach Stage attribute updated on a Person.
//                    DNC path pauses Apollo activity (where possible),
//                    Engaged/Meeting Booked writes status, Escalated
//                    is a no-op (the "Needs Human Touch" view catches it).
//
//   - outbox_added:  Person added to the Attio "Apollo Search Outbox"
//                    list. Bridge upserts the contact in Apollo so
//                    enrichment works for Rebecca's rare Apollo searches.
//
// Routing: prefer ?event= hint in the webhook URL, fall back to sniffing
// list name or attribute slug in the payload.
//
// COLD SEQUENCE ENROLLMENT IS NOT HANDLED BY THIS BRIDGE. Jack runs all
// cold outbound directly in Apollo via the Flywheel email generator.
// ====================================================================

const { ok, bad, fail, verifySecret } = require('../lib/respond');
const attio = require('../lib/attio');
const apollo = require('../lib/apollo');
const { alert } = require('../lib/notify');
const {
  APOLLO_DRIP_LIST_ID,
  APOLLO_INBOX_LIST_ID,
  ENABLE_REDUNDANT_APOLLO_REMOVAL,
} = require('../config');

module.exports = async (req, res) => {
  // CRITICAL: set headers before any logic per the Outbound Flywheel pattern
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') return bad(res, 'method not allowed', 405);
  if (!verifySecret(req)) return bad(res, 'unauthorized', 401);

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { return bad(res, 'invalid json'); }
  }
  if (!body) return bad(res, 'empty body');

  // Hint from query string takes precedence; otherwise sniff the shape.
  const hint = (req.query?.event || '').toLowerCase();

  try {
    const event = hint || detectEvent(body);
    console.log('[attio-webhook]', event, JSON.stringify(body).slice(0, 500));

    let result;
    switch (event) {
      case 'drip_added':
        result = await handleDripAdded(body);
        break;
      case 'stage_changed':
        result = await handleStageChanged(body);
        break;
      case 'outbox_added':
        result = await handleOutboxAdded(body);
        break;
      default:
        await alert('Unrecognized Attio webhook event', { hint, sample: body });
        return bad(res, `unrecognized event: ${event || 'unknown'}`);
    }

    return ok(res, { event, result });
  } catch (err) {
    await alert('attio-webhook handler error', { error: err.message, body });
    return fail(res, err);
  }
};

// --------------------------------------------------------------------
// Event detection — fallback when no ?event= hint is provided
// --------------------------------------------------------------------

function detectEvent(body) {
  // Customize once you see the real Attio payload shapes during testing.
  // Defensive checks against several plausible shapes:
  const listName =
    body?.list_name ||
    body?.list?.name ||
    body?.trigger?.list_name ||
    body?.data?.list?.name ||
    null;
  const attrSlug =
    body?.attribute?.slug ||
    body?.trigger?.attribute_slug ||
    body?.data?.attribute?.api_slug ||
    null;

  if (listName && /drip/i.test(listName)) return 'drip_added';
  if (listName && /Apollo Search Outbox/i.test(listName)) return 'outbox_added';
  if (attrSlug && /outreach.?stage/i.test(attrSlug)) return 'stage_changed';
  return null;
}

// --------------------------------------------------------------------
// Helpers to extract person data from various Attio payload shapes
// --------------------------------------------------------------------

function extractPerson(body) {
  // Flat payload from Attio workflow "Send HTTP request" body templates
  if (body.email) {
    // Attio variable pills inject leading/trailing whitespace; trim all values.
    const t = (v) => (typeof v === 'string' ? v.trim() : v);
    return {
      id: t(body.record_id) || null,
      email: t(body.email),
      firstName: t(body.first_name) || null,
      lastName: t(body.last_name) || null,
      fullName: [t(body.first_name), t(body.last_name)].filter(Boolean).join(' ') || null,
      title: t(body.job_title) || null,
      company: t(body.company) || null,
      linkedinUrl: t(body.linkedin_url) || null,
    };
  }

  const record =
    body?.record ||
    body?.data?.record ||
    body?.parent_record ||
    body?.data?.parent_record ||
    null;

  if (!record) return null;

  const id = record?.id?.record_id || record?.record_id || record?.id || null;

  // Attio record values are arrays; grab .value or .email_address
  const values = record?.values || {};
  const firstValue = (slug) => {
    const v = values[slug];
    if (!v) return null;
    if (Array.isArray(v) && v.length) {
      const first = v[0];
      return first?.value ?? first?.email_address ?? first?.option?.title ?? first?.full_name ?? null;
    }
    return null;
  };

  return {
    id,
    email: firstValue('email_addresses') || firstValue('primary_email_address'),
    firstName: firstValue('first_name') || firstValue('name'),
    lastName: firstValue('last_name'),
    fullName: firstValue('name'),
    title: firstValue('job_title') || firstValue('title'),
    company: firstValue('company_name') || firstValue('current_company'),
    linkedinUrl: firstValue('linkedin'),
  };
}

function extractListName(body) {
  return (
    body?.list_name ||
    body?.list?.name ||
    body?.trigger?.list_name ||
    body?.data?.list?.name ||
    null
  );
}

// --------------------------------------------------------------------
// Handlers
// --------------------------------------------------------------------

async function handleDripAdded(body) {
  const person = extractPerson(body);
  if (!person || !person.email) throw new Error('drip_added: missing person email');

  const apolloDripListId = require('../config').APOLLO_DRIP_LIST_ID;
  if (!apolloDripListId || apolloDripListId.startsWith('REPLACE_')) {
    throw new Error('APOLLO_DRIP_LIST_ID not configured in config.js');
  }

  // 1. Upsert the contact in Apollo
  const { id: apolloContactId, created } = await apollo.upsertContactByEmail({
    email: person.email,
    firstName: person.firstName,
    lastName: person.lastName,
    title: person.title,
    organizationName: person.company,
    linkedinUrl: person.linkedinUrl,
  });

  // 2. Add to the Apollo Bridge Drip list. An Apollo workflow watches
  //    this list and enrolls the contact in the drip sequence.
  await apollo.addContactToList(apolloContactId, apolloDripListId);

  // 3. Write back to Attio — record the Apollo Contact ID for future
  //    lookups, and flip sequence status so we know they're in drip.
  await attio.setEngagement(person.id, {
    apolloContactId,
    apolloSequenceStatus: 'Active',
    assignedSequence: 'Drip Re-engagement',
  });

  return { apolloContactId, created, apolloDripListId };
}

async function handleStageChanged(body) {
  const person = extractPerson(body);
  if (!person) throw new Error('stage_changed: missing person');

  // Try to read the new stage value
  const newStage =
    body?.new_value ||
    body?.attribute?.new_value ||
    body?.data?.new_value ||
    extractCurrentStage(body) ||
    null;

  if (!newStage) throw new Error('stage_changed: could not determine new stage');

  console.log(`[stage_changed] ${person.email} — ${newStage}`);

  // Find the Apollo contact ID — prefer the one stored on the Attio record
  const apolloContactId = await getApolloContactIdForPerson(person);

  switch (newStage) {
    case 'Do Not Contact': {
      if (apolloContactId && ENABLE_REDUNDANT_APOLLO_REMOVAL) {
        await apollo.removeContactFromAllSequences(apolloContactId);
        await apollo.setContactStage(apolloContactId, 'Do Not Contact').catch(() => {});
      }
      await attio.setEngagement(person.id, {
        apolloSequenceStatus: 'Not In Sequence',
      });
      return { action: 'removed_from_all_sequences', apolloContactId };
    }
    case 'Engaged':
    case 'Meeting Booked': {
      // Belt-and-suspenders: pull them out of the cold sequence so the
      // automated cadence doesn't keep firing while Rebecca handles them.
      if (apolloContactId && ENABLE_REDUNDANT_APOLLO_REMOVAL) {
        await apollo.removeContactFromAllSequences(apolloContactId);
      }
      await attio.setEngagement(person.id, {
        apolloSequenceStatus: 'Not In Sequence',
      });
      return { action: 'paused_sequence', apolloContactId };
    }
    case 'Escalated': {
      // Just flag — the "Needs Human Touch" view filters on this stage,
      // so Rebecca will see them. No Apollo action needed beyond that.
      return { action: 'noted', apolloContactId };
    }
    default:
      return { action: 'noop', stage: newStage, apolloContactId };
  }
}

async function handleOutboxAdded(body) {
  const person = extractPerson(body);
  if (!person || !person.email) throw new Error('outbox_added: missing person email');

  // Upsert in Apollo so the contact exists in their DB for search/enrichment
  const { id: apolloContactId, created } = await apollo.upsertContactByEmail({
    email: person.email,
    firstName: person.firstName,
    lastName: person.lastName,
    title: person.title,
    organizationName: person.company,
    linkedinUrl: person.linkedinUrl,
  });

  // Stamp the Apollo Contact ID on the Attio record so future lookups
  // skip the email search.
  await attio.setEngagement(person.id, { apolloContactId });

  // Optional: clear them from the inbox_from_rebecca list now that they're
  // in Attio. This keeps the outbox empty as designed.
  // Skipped here because the outbox-added flow originates in Attio, not
  // Apollo. The reverse direction (Apollo outbox — Attio creation) belongs
  // in a separate scheduled poller if you decide to support it.

  return { apolloContactId, created };
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

async function getApolloContactIdForPerson(person) {
  // 1. Try the value already stored on the Attio record
  if (person.id) {
    try {
      const fresh = await attio.getPersonById(person.id);
      const stored = fresh?.values?.apollo_contact_id?.[0]?.value;
      if (stored) return stored;
    } catch (_) { /* fall through */ }
  }
  // 2. Fall back to email lookup in Apollo
  if (!person.email) return null;
  try {
    const { id } = await apollo.upsertContactByEmail({ email: person.email });
    return id;
  } catch (_) {
    return null;
  }
}

function extractCurrentStage(body) {
  const record = body?.record || body?.data?.record;
  const v = record?.values?.outreach_stage;
  if (Array.isArray(v) && v.length) return v[0]?.option?.title || v[0]?.value || null;
  return null;
}
