// ====================================================================
// api/cron/dead-mans-switch.js
//
// Daily consistency check. Runs at 13:00 UTC (8am CT) per vercel.json.
//
// Finds Attio People whose Outreach Stage indicates they should NOT be
// in any active Apollo sequence, but who actually still are. This catches
// sync failures, race conditions, and any case where the bridge silently
// dropped an event.
//
// "Should not be in a sequence" stages:
//   - Engaged
//   - Meeting Booked
//   - Do Not Contact
//   - Escalated
//
// On finding a discrepancy:
//   1. Always log + Slack alert
//   2. If DEAD_MANS_SWITCH_AUTO_HEAL is true, also remove from Apollo
// ====================================================================

const { ok, fail } = require('../../lib/respond');
const attio = require('../../lib/attio');
const apollo = require('../../lib/apollo');
const { alert } = require('../../lib/notify');
const { DEAD_MANS_SWITCH_AUTO_HEAL } = require('../../config');

const SHOULD_NOT_BE_SEQUENCED = ['Engaged', 'Meeting Booked', 'Do Not Contact', 'Escalated'];

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // Vercel cron sends a header for verification (when configured).
  // For now, accept any caller — tighten with WEBHOOK_SHARED_SECRET if needed.

  try {
    const startedAt = Date.now();
    const people = await attio.findPeopleByStage(SHOULD_NOT_BE_SEQUENCED);
    console.log(`[dead-mans-switch] checking ${people.length} people`);

    const discrepancies = [];
    let healed = 0;

    for (const person of people) {
      const personId = person?.id?.record_id;
      const apolloContactId = person?.values?.apollo_contact_id?.[0]?.value;
      const stage = person?.values?.outreach_stage?.[0]?.option?.title;
      const email = person?.values?.email_addresses?.[0]?.email_address;
      if (!apolloContactId) continue;

      let activeIds = [];
      try {
        activeIds = await apollo.getActiveSequenceIds(apolloContactId);
      } catch (err) {
        console.warn(`[dead-mans-switch] apollo lookup failed for ${apolloContactId}`, err.message);
        continue;
      }
      if (activeIds.length === 0) continue;

      discrepancies.push({ personId, email, stage, apolloContactId, activeIds });

      if (DEAD_MANS_SWITCH_AUTO_HEAL) {
        try {
          await apollo.removeContactFromAllSequences(apolloContactId);
          await attio.setEngagement(personId, { apolloSequenceStatus: 'Not In Sequence' });
          healed++;
        } catch (err) {
          console.error(`[dead-mans-switch] heal failed for ${apolloContactId}`, err.message);
        }
      }
    }

    const took = Date.now() - startedAt;
    const summary = {
      checked: people.length,
      discrepancies: discrepancies.length,
      healed,
      durationMs: took,
    };
    console.log('[dead-mans-switch]', summary);

    if (discrepancies.length > 0) {
      await alert(
        `Dead-man's-switch found ${discrepancies.length} sync discrepancies (healed ${healed})`,
        { sample: discrepancies.slice(0, 10) }
      );
    }

    return ok(res, summary);
  } catch (err) {
    await alert('dead-mans-switch crashed', { error: err.message });
    return fail(res, err);
  }
};
