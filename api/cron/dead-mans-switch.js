// ====================================================================
// api/cron/dead-mans-switch.js
//
// Daily consistency check for the drip re-engagement path. Runs at
// 13:00 UTC (8am CT) per vercel.json.
//
// In the simplified architecture, Attio does NOT manage cold sequence
// membership — Jack handles that directly in Apollo. The only cross-
// system state the bridge owns is the drip re-engagement path:
//
//   Attio "Drip" list → bridge → Apollo "Bridge Drip" list → Apollo
//   workflow → drip sequence
//
// This cron catches inconsistencies in that path:
//
//   1. People in the Attio Drip list whose Attio record does NOT have
//      an Apollo Contact ID yet (drip_added handler probably failed)
//
//   2. Optional future check: people whose apollo_sequence_status is
//      "Active" and assignedSequence is "Drip Re-engagement" but who
//      aren't actually in the Apollo Bridge Drip list.
//
// On finding issues, logs + Slack alerts. Does NOT auto-heal because
// the underlying endpoints are plan-gated on our current Apollo plan.
// ====================================================================

const { ok, fail } = require('../../lib/respond');
const attio = require('../../lib/attio');
const { alert } = require('../../lib/notify');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    const startedAt = Date.now();
    const issues = [];

    // Find people in the Attio "Drip" list. We'll look up the list by
    // name and then page through its entries. If the Drip list doesn't
    // exist yet, this will return null and we just exit cleanly.
    const dripListId = await attio.findListIdByName('Drip Re-engagement');
    if (!dripListId) {
      console.log('[dead-mans-switch] no Drip Re-engagement list found, skipping');
      return ok(res, { skipped: 'no_drip_list' });
    }

    // Get everyone in the Drip list and verify each has an Apollo
    // Contact ID set on their record. Missing ID = drip_added webhook
    // failed to write back.
    const entries = await attio.getListEntries(dripListId, 200);
    let missingApolloId = 0;
    for (const entry of entries) {
      const personId = entry?.parent_record_id || entry?.record_id;
      if (!personId) continue;
      try {
        const person = await attio.getPersonById(personId);
        const apolloId = person?.values?.apollo_contact_id?.[0]?.value;
        if (!apolloId) {
          missingApolloId++;
          issues.push({
            personId,
            email: person?.values?.email_addresses?.[0]?.email_address,
            reason: 'in_drip_list_but_no_apollo_contact_id',
          });
        }
      } catch (err) {
        console.warn('[dead-mans-switch] lookup failed', personId, err.message);
      }
    }

    const took = Date.now() - startedAt;
    const summary = {
      checkedDripEntries: entries.length,
      issues: issues.length,
      missingApolloId,
      durationMs: took,
    };
    console.log('[dead-mans-switch]', summary);

    if (issues.length > 0) {
      await alert(
        `Dead-man's-switch found ${issues.length} drip path issue(s)`,
        { sample: issues.slice(0, 10) }
      );
    }

    return ok(res, summary);
  } catch (err) {
    await alert('dead-mans-switch crashed', { error: err.message });
    return fail(res, err);
  }
};
