// ====================================================================
// config.js — bridge configuration
//
// FILL IN the Apollo sequence IDs before deploying. You can grab each
// sequence ID from the URL when viewing the sequence in Apollo:
//   https://app.apollo.io/#/sequences/<SEQUENCE_ID>/overview
//
// The KEY on the left is the EXACT name of the Attio list (without the
// "Sequence: " prefix). The VALUE on the right is the Apollo sequence ID.
// ====================================================================

const SEQUENCE_MAP = {
  'Automated Sequence':                    'REPLACE_WITH_APOLLO_SEQUENCE_ID',
  'Preppy – Dept Heads – Referral Engine': 'REPLACE_WITH_APOLLO_SEQUENCE_ID',
  'Preppy – Education Director – Rural':   'REPLACE_WITH_APOLLO_SEQUENCE_ID',
  'Preppy – CNO – Rural Staffing':         'REPLACE_WITH_APOLLO_SEQUENCE_ID',
  'High-Touch Sequence':                   'REPLACE_WITH_APOLLO_SEQUENCE_ID',
};

// Apollo list ID for the "inbox_from_rebecca" search outbox.
// Grab from URL: https://app.apollo.io/#/contacts?finderViewId=...&listId=<LIST_ID>
const APOLLO_INBOX_LIST_ID = 'REPLACE_WITH_APOLLO_LIST_ID';

// Default email mailbox ID for sequence enrollment (Rebecca's mailbox).
// Find via Apollo API GET /v1/email_accounts or grab from a sequence enrollment URL.
const APOLLO_DEFAULT_MAILBOX_ID = 'REPLACE_WITH_APOLLO_MAILBOX_ID';

// Apollo user ID for Rebecca (used as send_email_from_email_account_id fallback
// and as the assignee for any tasks the bridge creates). Find via Apollo API
// GET /v1/users/search.
const APOLLO_REBECCA_USER_ID = 'REPLACE_WITH_APOLLO_USER_ID';

// ====================================================================
// Behavior knobs — sane defaults, tweak if needed
// ====================================================================

// Open events are noisy (40%+ open rate × hundreds of contacts). The bridge
// only writes an "Opened" engagement to Attio at most once per contact per
// this many minutes. Replies, bounces, meetings, and finishes always write.
const OPEN_EVENT_DEDUPE_WINDOW_MINUTES = 1440; // 24 hours

// When a contact is removed from a sequence due to reply/meeting/DNC, the
// bridge calls Apollo's remove-from-sequence endpoint. Set false to rely
// solely on Apollo's native "auto-remove on reply" setting (belt only,
// no suspenders).
const ENABLE_REDUNDANT_APOLLO_REMOVAL = true;

// Dead-man's-switch tolerance: if the cron finds a contact whose Attio
// Outreach Stage is "Engaged" or "Do Not Contact" but who is still active
// in an Apollo sequence, alert immediately. Set true to also auto-remove
// them from Apollo as a self-healing measure.
const DEAD_MANS_SWITCH_AUTO_HEAL = true;

module.exports = {
  SEQUENCE_MAP,
  APOLLO_INBOX_LIST_ID,
  APOLLO_DEFAULT_MAILBOX_ID,
  APOLLO_REBECCA_USER_ID,
  OPEN_EVENT_DEDUPE_WINDOW_MINUTES,
  ENABLE_REDUNDANT_APOLLO_REMOVAL,
  DEAD_MANS_SWITCH_AUTO_HEAL,
};
