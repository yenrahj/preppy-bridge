// ====================================================================
// config.js — bridge configuration
//
// ARCHITECTURE (final):
//
// - Jack runs all cold outbound directly in Apollo (via Flywheel).
//   The bridge does NOT enroll contacts in cold sequences.
//
// - Apollo engagement events (opens/clicks/replies/bounces/meetings)
//   flow into Attio as writeback. The bridge tracks opens on a rolling
//   7-day window; once a contact hits ENGAGEMENT_OPEN_THRESHOLD opens,
//   it sets Flagged for Review = true so Rebecca sees them in her
//   "Needs Human Touch" view. Clicks flag immediately.
//
// - The ONLY Attio-originated Apollo path is the drip re-engagement
//   list: Rebecca drops a gone-cold lead in the Attio "Drip" list,
//   the bridge mirrors to Apollo's "Bridge Drip" list, and an Apollo
//   workflow picks it up and enrolls in a drip sequence.
// ====================================================================

// Apollo list ID for the Bridge Drip re-engagement list.
// Fill in after creating the Apollo list (see Chrome agent brief).
const APOLLO_DRIP_LIST_ID = '69d7b41ba031ed000d1125e5';

// Apollo list ID for the "Bridge Inbox" search outbox (existing).
const APOLLO_INBOX_LIST_ID = '69d65c6b00b0d30015c0eafa';

// Retained for reference — no longer used by the bridge directly. Apollo
// sequence enrollment is handled by Jack in Apollo's UI.
const APOLLO_SEQUENCE_IDS_REFERENCE = {
  'Automated Sequence':                    '69a5f9c5175aaa0011a52b6d',
  'Preppy – Dept Heads – Referral Engine': '69d40c29e16fa90011eec03a',
  'Preppy – Education Director – Rural':   '69d408c9160b4a00215cabef',
  'Preppy – CNO – Rural Staffing':         '69d4052e6344f40019af033c',
  'High-Touch Sequence':                   '69c6abc9b1641e0011c514d7',
};

// Rebecca's mailbox and user IDs — retained for reference.
const APOLLO_DEFAULT_MAILBOX_ID = '6998baa2e1a5e90011234290';
const APOLLO_REBECCA_USER_ID    = '69a0649787ea9b00217d9cb9';

// ====================================================================
// Engagement threshold settings
// ====================================================================

// How many opens within the rolling window before a contact gets flagged.
const ENGAGEMENT_OPEN_THRESHOLD = 3;

// Rolling window in days for the open counter. If a contact hasn't hit
// the threshold within this window, the counter resets on the next open.
const ENGAGEMENT_OPEN_WINDOW_DAYS = 7;

// Noise dedupe: the SAME open event may fire multiple times from image
// preloaders. This window prevents rapid-fire duplicates from being
// double-counted. Set shorter than a normal user revisit gap.
const OPEN_EVENT_DEDUPE_WINDOW_MINUTES = 60;

// ====================================================================
// Behavior knobs
// ====================================================================

// Direct API removal hits the plan-gated endpoint. Rely on Apollo's
// native "auto-remove on reply" instead.
const ENABLE_REDUNDANT_APOLLO_REMOVAL = false;

// Dead-man's-switch auto-heal: same gating issue. Alert only.
const DEAD_MANS_SWITCH_AUTO_HEAL = false;

module.exports = {
  APOLLO_DRIP_LIST_ID,
  APOLLO_INBOX_LIST_ID,
  APOLLO_SEQUENCE_IDS_REFERENCE,
  APOLLO_DEFAULT_MAILBOX_ID,
  APOLLO_REBECCA_USER_ID,
  ENGAGEMENT_OPEN_THRESHOLD,
  ENGAGEMENT_OPEN_WINDOW_DAYS,
  OPEN_EVENT_DEDUPE_WINDOW_MINUTES,
  ENABLE_REDUNDANT_APOLLO_REMOVAL,
  DEAD_MANS_SWITCH_AUTO_HEAL,
};
