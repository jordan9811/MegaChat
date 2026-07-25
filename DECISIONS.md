# DECISIONS — lazy-connect branch

One line each: what / why / how to undo. Newest at the bottom.

> Note: `v0-ui-migration` carries a longer DECISIONS.md (browse deck + bounty).
> This branch predates it; the two will need merging when the branches meet.

## LiveKit Cloud validation run (2026-07-25)

- **Reported the quota contradiction instead of proceeding** — the run was premised on "quota is restored", but 6 of 12 fresh `/rtc/validate` probes returned 429. Running the Cloud measurement at ~50% rejection would have produced a green result for the wrong reason and retired an open question on bad evidence. Undo: n/a.
- **Abandon cap gets its own sweeper, not lazy evaluation** — an abandoned hold is otherwise only noticed when something else happens to ask, and for a room whose only visitor just closed their tab, nobody asks. The cap has to fire with no further input from the person who left. Undo: remove the `abandonSweeper` interval in livekit-activity.js.
- **Two clocks per prewarm (abandon + TTL) rather than replacing the TTL** — the TTL stays as an absolute backstop for a client that vanished so completely it stopped heartbeating, and now logs a warning when it fires, because the cap should have caught it first. Undo: drop `abandonAt` from the hold record.
- **Backgrounding a tab does NOT release the hold** — people tab away mid-wallet-dialog; treating that as abandonment would clip legitimate slow joins, which is a worse outcome than the burn. The cap still covers someone who backgrounds and never returns. Undo: add a `visibilitychange` release in join-page.ts.
- **`sendBeacon` for the bail path, not `fetch`** — fetch does not survive page teardown, which is precisely why the old code had no tab-close release at all. Undo: n/a.
- **Breaker reads WEBHOOK data, never our own ledger** — a breaker fed by the same self-report that hid the last leak would fail in exactly the case it exists for. Consequence, stated loudly in code and docs: the breaker is inert until Cloud webhooks are configured. Undo: point `getUsage` at `lkActivity.ledgerStats`.
- **Breaker blocks at 95%, not 100%** — stopping before the provider does keeps the failure ours to explain to a streamer, instead of arriving as an opaque LiveKit error. Undo: `LK_BREAKER_BLOCK_AT=1`.
- **Blocking refuses new TOKENS; live sessions are never killed** — cutting a paying guest off air to save minutes is worse than the overage. The token endpoint is the chokepoint because a token *is* a new connection. Undo: n/a.
- **Webhook receiver rejects unsigned deliveries outright** — an unauthenticated writer to the authoritative session ledger would be worse than having no ledger at all. Undo: n/a.
- **Did NOT merge, and did NOT resolve the rebase conflicts** — the merge was explicitly gated on items 1–4 passing, and item 1 cannot pass. The bounty rebase then turned out to genuinely conflict (3 adjacent-addition hunks across overlay.html and server.js), and the instruction was to stop and report rather than resolve creatively. Trial branches deleted, no residue. Undo: n/a — this is a handoff to a human decision.
