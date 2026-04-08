# preppy-bridge

Webhook bridge between **Attio** (source of truth, where Rebecca lives) and **Apollo** (headless sequence execution + contact search). Plain Node serverless functions on Vercel. No Next.js, no framework.

## Architecture

```
        ┌──────────────────────────────────┐
        │  ATTIO — Rebecca's only UI       │
        │  • Needs Human Touch view         │
        │  • Records, notes, stage changes  │
        └───────────┬──────────────────────┘
                    │ 8 webhooks
                    ▼
        ┌───────────────────────────────────┐
        │  preppy-bridge (this project)     │
        │  /api/attio-webhook               │
        │  /api/apollo-webhook              │
        │  /api/cron/dead-mans-switch       │
        └───────────┬───────────────────────┘
                    │ 5 webhooks
                    ▲
        ┌──────────────────────────────────┐
        │  APOLLO — headless                │
        │  • Sequences run silently         │
        │  • Contact search DB only         │
        └──────────────────────────────────┘
```

## File map

```
preppy-bridge/
├── api/
│   ├── attio-webhook.js        # all 8 Attio workflow payloads
│   ├── apollo-webhook.js       # all 5 Apollo workflow payloads
│   ├── health.js               # GET for sanity check
│   └── cron/
│       └── dead-mans-switch.js # daily consistency check
├── lib/
│   ├── attio.js                # Attio REST API helpers
│   ├── apollo.js               # Apollo REST API helpers
│   ├── http.js                 # fetch wrapper with retries
│   ├── respond.js              # res.send(JSON.stringify(...)) pattern
│   ├── dedupe.js               # open-event dedupe
│   └── notify.js               # Slack alerts
├── config.js                   # ⚠️ FILL IN sequence IDs before deploying
├── vercel.json                 # cron config
├── package.json
├── .env.example                # copy to .env.local
└── README.md
```

## Pre-deploy checklist

**1. Fill in `config.js`:**
- Replace each `REPLACE_WITH_APOLLO_SEQUENCE_ID` with the real Apollo sequence ID. Grab from the URL when viewing each sequence in Apollo: `https://app.apollo.io/#/sequences/<ID>/overview`
- Replace `APOLLO_INBOX_LIST_ID` with the `inbox_from_rebecca` Apollo list ID (recorded in Phase 2.5)
- Replace `APOLLO_DEFAULT_MAILBOX_ID` with Rebecca's mailbox ID. Get it via `curl -H "X-Api-Key: $APOLLO_API_KEY" https://api.apollo.io/v1/email_accounts`
- Replace `APOLLO_REBECCA_USER_ID` with Rebecca's Apollo user ID. Get it via `curl -X POST -H "X-Api-Key: $APOLLO_API_KEY" -H "Content-Type: application/json" -d '{"q_keywords":"Rebecca"}' https://api.apollo.io/v1/users/search`

**2. Set up env vars locally:**
```bash
cp .env.example .env.local
# Then edit .env.local with the real values
```
You need:
- `ATTIO_API_KEY` — the `vercel-bridge` token from Attio (created in Phase 1.6)
- `APOLLO_API_KEY` — the `preppy_flywheel` API key
- `WEBHOOK_SHARED_SECRET` — generate any random string: `openssl rand -hex 32`
- `SLACK_ALERT_WEBHOOK_URL` — optional but strongly recommended

**3. Install + local test:**
```bash
npm install
npx vercel dev
# In another terminal:
curl http://localhost:3000/api/health
# Should return {"ok":true,"service":"preppy-bridge",...}
```

## Deploy

```bash
npx vercel link        # link to a new Vercel project
npx vercel env add ATTIO_API_KEY production
npx vercel env add APOLLO_API_KEY production
npx vercel env add WEBHOOK_SHARED_SECRET production
npx vercel env add SLACK_ALERT_WEBHOOK_URL production   # optional
npx vercel --prod
```

After deploy, your endpoints will be:
- `https://preppy-bridge-xxxx.vercel.app/api/health`
- `https://preppy-bridge-xxxx.vercel.app/api/attio-webhook`
- `https://preppy-bridge-xxxx.vercel.app/api/apollo-webhook`

## Webhook URLs to paste into Attio and Apollo

For Attio, add a `?event=` hint to each URL so the bridge knows what to do without sniffing the payload. The 7 active Attio workflows (the removal one stays archived) become:

| Attio workflow | Webhook URL |
|---|---|
| Person added to Sequence: Automated Sequence | `.../api/attio-webhook?event=sequence_added&secret=...` |
| Person added to Dept Heads Referral list | `.../api/attio-webhook?event=sequence_added&secret=...` |
| Person added to Education Director Rural list | `.../api/attio-webhook?event=sequence_added&secret=...` |
| Person added to CNO Rural Staffing list | `.../api/attio-webhook?event=sequence_added&secret=...` |
| Person added to High-Touch Sequence list | `.../api/attio-webhook?event=sequence_added&secret=...` |
| Outreach Stage changed | `.../api/attio-webhook?event=stage_changed&secret=...` |
| Apollo Search Outbox entry created | `.../api/attio-webhook?event=outbox_added&secret=...` |

(All 5 sequence workflows hit the same endpoint with the same hint — the bridge reads the list name from the payload to pick the right Apollo sequence ID.)

For Apollo, the 5 webhook workflows:

| Apollo workflow | Webhook URL |
|---|---|
| Email Replied | `.../api/apollo-webhook?event=replied&secret=...` |
| Email Opened | `.../api/apollo-webhook?event=opened&secret=...` |
| Email Bounced | `.../api/apollo-webhook?event=bounced&secret=...` |
| Contact Finished Sequence | `.../api/apollo-webhook?event=finished&secret=...` |
| Meeting Booked | `.../api/apollo-webhook?event=meeting&secret=...` |

## Testing order (Phase 3 from main brief)

Enable **one workflow at a time** and verify each before moving to the next:

1. **Apollo Search Outbox** — add a dummy contact to the outbox list, verify it lands in Apollo's contact DB.
2. **Outreach Stage changed → Do Not Contact** — change a test person's stage, verify Apollo removes them from any active sequences.
3. **Apollo Email Opened** — wait for or simulate an open, verify `Last Engagement Date` updates in Attio (and that opens DON'T cause appearance in Needs Human Touch).
4. **Apollo Email Replied** — verify Outreach Stage flips to Engaged, a note gets posted with the reply body, and they appear in Needs Human Touch.
5. **Person added to a Sequence list** — add a test person, verify Apollo enrolls them.
6. **The escalation workflow** (Automated → High-Touch on Engagement) — verify the cascade fires correctly through the bridge.

## Known things to verify after first real payload

The payload extractors in `api/attio-webhook.js` (`extractPerson`, `extractListName`, `extractCurrentStage`) and `api/apollo-webhook.js` (`extractContext`) are **defensive but speculative** — they handle multiple plausible shapes because we haven't seen the actual webhook bodies yet.

During Phase 3 testing:
1. Tail logs with `npx vercel logs --follow` (or check the Vercel dashboard)
2. The first line of every handler logs the event + a 500-char body slice
3. If a handler fails or extracts wrong values, copy the logged payload and adjust the extractor

This is a 5-minute fix per handler once you see the real shape.

## Operational notes

- **Open events are deduped** — at most one per contact per 24 hours (configurable in `config.js`). Current dedupe is in-memory per warm Lambda; swap to Vercel KV if it gets noisy.
- **Open events do NOT change Outreach Stage** — they only update last-engagement fields. Otherwise Rebecca's queue would fill with image-preloader noise.
- **Replied/Bounced/Meeting events all redundantly call Apollo's remove-from-sequence** even though Apollo's native auto-remove should handle it. Belt and suspenders. Disable via `ENABLE_REDUNDANT_APOLLO_REMOVAL` in `config.js` if it causes 422s.
- **The dead-man's-switch runs daily at 8am CT (13:00 UTC)**. It finds Attio people who should not be in any sequence but are, alerts via Slack, and auto-heals if `DEAD_MANS_SWITCH_AUTO_HEAL` is true.
- **No polling fallback** — the bridge is event-driven only. If Apollo workflows stop firing for any reason, the dead-man's-switch is your safety net.

## When something breaks

1. Check Vercel logs first
2. Check Slack for alerts (if `SLACK_ALERT_WEBHOOK_URL` is set)
3. Hit `/api/health` to verify env vars are still set
4. Most likely culprit: payload shape changed, extractors need updating
