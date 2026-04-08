// ====================================================================
// lib/apollo.js — Apollo.io REST API helpers
//
// Docs: https://docs.apollo.io/reference
//
// Notes from prior Outbound Flywheel work:
// - Apollo distinguishes Contact ID (the ID within YOUR workspace's CRM)
//   from Person ID (Apollo's global database ID). Sequence enrollment uses
//   CONTACT IDs. Confusing these is the #1 source of 422s.
// - Custom field writes use `typed_custom_fields` with the field IDs, not
//   the field names. Example:
//     { typed_custom_fields: { "<field_id>": "value" } }
// - The API key auth header is `X-Api-Key`, NOT Bearer.
// ====================================================================

const { request } = require('./http');
const { APOLLO_DEFAULT_MAILBOX_ID, APOLLO_REBECCA_USER_ID } = require('../config');

const APOLLO_BASE = 'https://api.apollo.io/v1';

function authHeaders() {
  const key = process.env.APOLLO_API_KEY;
  if (!key) throw new Error('APOLLO_API_KEY not set');
  return {
    'X-Api-Key': key,
    'Cache-Control': 'no-cache',
  };
}

// --- Contacts ---

/**
 * Find or create a contact in Apollo by email. Returns the Apollo
 * CONTACT ID (not the global person_id).
 */
async function upsertContactByEmail({ email, firstName, lastName, title, organizationName, linkedinUrl }) {
  // 1. Try to find existing contact
  const search = await request(`${APOLLO_BASE}/contacts/search`, {
    method: 'POST',
    headers: authHeaders(),
    body: {
      q_keywords: email,
      page: 1,
      per_page: 5,
    },
  });
  const existing = (search?.contacts || []).find(c =>
    (c.email || '').toLowerCase() === email.toLowerCase()
  );
  if (existing) return { id: existing.id, created: false, contact: existing };

  // 2. Create
  const created = await request(`${APOLLO_BASE}/contacts`, {
    method: 'POST',
    headers: authHeaders(),
    body: {
      first_name: firstName,
      last_name: lastName,
      email,
      title,
      organization_name: organizationName,
      linkedin_url: linkedinUrl,
    },
  });
  const newContact = created?.contact;
  if (!newContact?.id) throw new Error(`Apollo contact create failed: ${JSON.stringify(created)}`);
  return { id: newContact.id, created: true, contact: newContact };
}

async function getContact(contactId) {
  const res = await request(`${APOLLO_BASE}/contacts/${contactId}`, {
    headers: authHeaders(),
  });
  return res?.contact || null;
}

/**
 * Update an Apollo contact. To write a custom field, pass it under
 * typed_custom_fields keyed by FIELD ID.
 */
async function updateContact(contactId, fields) {
  return request(`${APOLLO_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: fields,
  });
}

async function setContactStage(contactId, stageName) {
  // stageName must match an existing contact stage in your Apollo workspace.
  // Common stages: "Cold", "Warm", "Replied", "Do Not Contact", etc.
  return updateContact(contactId, { contact_stage_name: stageName });
}

// --- Sequences ---

async function addContactToSequence({ contactId, sequenceId, mailboxId, sendUserId }) {
  return request(`${APOLLO_BASE}/emailer_campaigns/${sequenceId}/add_contact_ids`, {
    method: 'POST',
    headers: authHeaders(),
    body: {
      contact_ids: [contactId],
      emailer_campaign_id: sequenceId,
      send_email_from_email_account_id: mailboxId || APOLLO_DEFAULT_MAILBOX_ID,
      userId: sendUserId || APOLLO_REBECCA_USER_ID,
    },
  });
}

async function removeContactFromSequence({ contactId, sequenceId }) {
  return request(`${APOLLO_BASE}/emailer_campaigns/remove_contact_ids`, {
    method: 'POST',
    headers: authHeaders(),
    body: {
      contact_ids: [contactId],
      emailer_campaign_ids: [sequenceId],
    },
  });
}

/**
 * Remove a contact from ALL sequences they're currently active in.
 * Used when a contact is marked Do Not Contact in Attio.
 */
async function removeContactFromAllSequences(contactId) {
  // Apollo's contact_sequence_states endpoint returns active sequences
  const res = await request(`${APOLLO_BASE}/contact_sequence_states/search`, {
    method: 'POST',
    headers: authHeaders(),
    body: { contact_id: contactId, page: 1, per_page: 100 },
  });
  const states = res?.contact_sequence_states || [];
  const activeSequenceIds = states
    .filter(s => s.status === 'active' || s.is_active)
    .map(s => s.emailer_campaign_id || s.sequence_id)
    .filter(Boolean);
  if (activeSequenceIds.length === 0) return { removed: 0 };

  await request(`${APOLLO_BASE}/emailer_campaigns/remove_contact_ids`, {
    method: 'POST',
    headers: authHeaders(),
    body: {
      contact_ids: [contactId],
      emailer_campaign_ids: activeSequenceIds,
    },
  });
  return { removed: activeSequenceIds.length, sequenceIds: activeSequenceIds };
}

/**
 * Check if a contact is currently active in any sequence.
 * Used by the dead-man's-switch.
 */
async function getActiveSequenceIds(contactId) {
  const res = await request(`${APOLLO_BASE}/contact_sequence_states/search`, {
    method: 'POST',
    headers: authHeaders(),
    body: { contact_id: contactId, page: 1, per_page: 100 },
  });
  const states = res?.contact_sequence_states || [];
  return states
    .filter(s => s.status === 'active' || s.is_active)
    .map(s => s.emailer_campaign_id || s.sequence_id)
    .filter(Boolean);
}

// --- Lists (for the inbox_from_rebecca outbox pattern) ---

async function removeContactFromList(contactId, listId) {
  return request(`${APOLLO_BASE}/labels/${listId}/remove_contacts`, {
    method: 'POST',
    headers: authHeaders(),
    body: { contact_ids: [contactId] },
  });
}

async function getContactsInList(listId, perPage = 100) {
  const res = await request(`${APOLLO_BASE}/contacts/search`, {
    method: 'POST',
    headers: authHeaders(),
    body: {
      label_ids: [listId],
      page: 1,
      per_page: perPage,
    },
  });
  return res?.contacts || [];
}

module.exports = {
  upsertContactByEmail,
  getContact,
  updateContact,
  setContactStage,
  addContactToSequence,
  removeContactFromSequence,
  removeContactFromAllSequences,
  getActiveSequenceIds,
  removeContactFromList,
  getContactsInList,
};
