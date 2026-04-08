// ====================================================================
// api/attio-webhook.js
//
// Single endpoint handling ALL Attio workflow payloads:
//
//   1. "Person added to Sequence: Automated Sequence" â Vercel
//   2. "Person added to Sequence: Preppy â Dept Heads â Referral Engine"
//   3. "Person added to Sequence: Preppy â Education Director â Rural"
//   4. "Person added to Sequence: Preppy â CNO â Rural Staffing"
//   5. "Person added to Sequence: High-Touch Sequence"
//   6. "Outreach Stage changed â Vercel"
//   7. "Apollo Search Outbox entry created â Vercel"
//   8. "[ARCHIVED] Person removed from Sequence list" â disabled, ignored
//
// Routing strategy: each Attio workflow's "Send HTTP request" action posts
// the trigger payload as-is. We sniff the shape to figure out which event
// it is. To make this rock-solid, you can also configure each Attio
// workflow to add a query string like ?event=sequence_added&list=automated
// to the webhook URL â in which case we use that hint instead.
//
// PAYLOAD SHAPES (approximate; verify against actual Attio webhook output
// during Phase 3 testing â print req.body and adjust the parsers below):
//
// "Record added to list" payloads include the list name and the parent
// person record. "Attribute updated" payloads include old/new values and
// the person record.
// ====================================================================

const { ok, bad, fail, verifySecret } = require('../lib/respond');
const attio = require('../lib/attio');
const apollo = require('../lib/apollo');
const { alert } = require('../lib/notify');
const {
  SEQUENCE_MAP,
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
      case 'sequence_added':
        result = await handleSequenceAdded(body);
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
// Event detection â fallback when no ?event= hint is provided
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

  if (listName && /^Sequence:/i.test(listName)) return 'sequence_added';
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
    return {
      id: body.record_id || null,
      email: body.email,
      firstName: body.first_name || null,
      lastName: body.last_name || null,
      fullName: [body.first_name, body.last_name].filter(Boolean).join(' ') || null,
      title: body.job_title || null,
      company: body.company || null,
      linkedinUrl: body.linkedin_url || null,
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

async function handleSequenceAdded(body) {
  const person = extractPerson(body);
  const listName = extractListName(body);
  if (!person || !person.email) throw new Error('sequence_added: missing person email');
  if (!listName) throw new Error('sequence_added: missing list name');

  // Strip "Sequence: " prefix to look up in SEQUENCE_MAP
  const sequenceName = listName.replace(/^Sequence:\s*/i, '').trim();
  const apolloSequenceId = SEQUENCE_MAP[sequenceName];
  if (!apolloSequenceId || apolloSequenceId.startsWith('REPLACE_')) {
    throw new Error(`No Apollo sequence ID mapped for list: "${sequenceName}". Update config.js.`);
  }

  // 1. Upsert in Apollo
  const { id: apolloContactId, created } = await apollo.upsertContactByEmail({
    email: person.email,
    firstName: person.firstName,
    lastName: person.lastName,
    title: person.title,
    organizationName: person.company,
    linkedinUrl: person.linkedinUrl,
  });

  // 2. Enroll in sequence
  await apollo.addContactToSequence({
    contactId: apolloContactId,
    sequenceId: apolloSequenceId,
  });

  // 3. Write back to Attio
  await attio.setEngagement(person.id, {
    outreachStage: 'In Sequence',
    apolloSequenceStatus: 'Active',
    apolloContactId,
    assignedSequence: sequenceName,
  });

  return { apolloContactId, created, sequenceName, apolloSequenceId };
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

  console.log(`[stage_changed] ${person.email} â ${newStage}`);

  // Find the Apollo contact ID â prefer the one stored on the Attio record
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
      // Just flag â the "Needs Human Touch" view filters on this stage,
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
  // Apollo. The reverse direction (Apollo outbox â Attio creation) belongs
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
