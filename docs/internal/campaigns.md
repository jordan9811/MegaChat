# Targeted reward campaigns

A creator posts on X: "if you have 10k followers / are someone I follow / … I'll pay you $X to send a Holler on my stream." A **campaign** turns that into an offer page at `/c/<slug>`, a check against the claimant's X profile, and a payout through the settlement door when the Holler (or Call in) counts.

Built 2026-10-23 on `feat/holler-brand`. Gate: `_gate-campaigns.mjs`. Hardened the same day after an adversarial review reproduced real-money defects against the engine and the real door; the "Hardening" section below lists each one, its fix and the gate case that covers it.

## The constraint everything obeys: X's Developer Policy

X forbids paying people to take actions **on X**. So:

- A campaign pays for exactly one thing on Holler: a **Holler** in the creator's room, or a **Call in** (a live camera seat) in the creator's room.
- Every rule only **reads** a fact that already exists about an X account. No rule requires or rewards a follow, reply, repost, quote or like.
- `followedByFromSet` counts list members who **already follow the applicant** (`connection_status: following`, seen from the member's token). It never counts accounts the applicant follows, because that would make a follow the price of a reward.
- Campaign copy that asks for an action on X is refused at create and edit time (`copyViolation` in `campaign-eligibility.js`), over HTTP as well (`_gate-campaigns.mjs` A and D6).

## Model

Four stores under `DATA_DIR`, written by `campaign-store.js` (atomic tmp + rename, synchronous so a check-then-write cannot interleave). Claims are also indexed in memory by campaign and by account, built once from the file and kept current by `putClaim`, so listing one campaign's claims reads only that campaign's rows. Each claim write still rewrites the whole claims file (OPEN-ISSUES, a scale item):

| File | Holds |
|---|---|
| `campaigns.json` | `{id, slug, title, blurb, creatorAccountId, action:{kind, roomHandle, require, minSeconds?}, rules, reward:{type, amount, atomic}, token:{address, decimals, symbol}, budget:{amount, atomic}, maxClaims, deadline, status, hidden, funding:{state, wallet, ref, token, atomic, txHash, receipt, approveTx, fundSigHash}, fundingAttempts, fundingFailures[], termsAt, xCostAtomic, xCheckAtomic, xHolds{}, xEstimates, refund}` |
| `reference-sets.json` | frozen `{id, name, source, sourceRef, snapshotAt, ids[], handles{}, count, root, version, supersedes, createdBy, costUsd}` |
| `campaign-claims.json` | `{id, campaignId, accountId, xUserId, xUsername, status, checks[], checkedAt, letterId?, seatId?, reservedAtomic, owedAtomic, payout?, followedBy?, playedUnauthed?, playedUnauthedAt?, history[]}` plus indexes by X id, account, letter and seat |
| `campaign-ledger.jsonl` | append-only: created, funding-started, funding-unconfirmed, funding-failed, funding-refused, funding-mismatch, funding-unknown, funded, opened, reserved, released, honoured, owed, intent, x-hold, x-cost, x-hold-released, x-cost-absorbed, x-hold-orphaned, refund, closed, forfeited |

Two more, outside the campaign files:

- `accounts.json` gains `payoutWallet` per account (`setAccountPayoutWallet`), where a claimant is paid.
- `x-tokens.json` holds X OAuth 2.0 user tokens, AES-256-GCM encrypted (`x-token-store.js`).

**Campaign status:** `draft → funding_pending → funded → live → closed`. A draft is editable. An account holds at most 20 drafts at once (`MAX_DRAFTS_PER_ACCOUNT` in `campaign-engine.js`, `too_many_drafts`); funding, opening or closing one makes room. `funding_pending` means the pull was sent and its receipt has not been seen; nothing about the campaign can change, open or close until the receipt decides (see Money). A funded campaign can still change its rules and build X lists, which are charged to its budget, until it opens. A live one can only change its copy and move its deadline later.

**Every campaign has a deadline**, in the future and at most 90 days out (`MAX_DEADLINE_DAYS`, `campaign-engine.js`). The budget must cover at least one reward. A budget above reward × maxClaims is allowed, and the creator view carries a warning: the extra can only come back in the refund.

**Claim status:** `ineligible | eligible → recorded → approved/joined → aired → owed → releasing → paid`, plus `failed` (the door's send failed), `rejected` (the room turned the Holler down) and `expired` (nothing was submitted before the close, the submitted action did not count within the grace window, or an owed claim had no wallet within the grace period).

**One claim per campaign per X user id and per account.** A second check returns the same claim. The same X account on a second Holler account is refused (`x_already_claimed`).

**Reference sets are frozen.** `insertSet` is the only write, and the store refuses to write over an id. A refresh creates a new set with `version + 1` and `supersedes`, and campaigns keep the id they chose. The fingerprint is a Merkle root (`campaign-merkle.js`):

- leaf: `keccak256(abi.encodePacked(uint256 id))`
- pairs: sorted
- odd node: carried up
- ids: de-duplicated and sorted numerically

That is OpenZeppelin's `MerkleProof` convention, so a contract can verify membership later. **Publishing the root on chain is not done** (`TODO(campaign-root-onchain)` in `campaign-merkle.js`). Any on-chain write must go through one of the two money doors and Gate H.

## Rules (the creator's menu)

All of these come from **one** X profile lookup, done at link time inside the OAuth round trip (`attestation/x-api.js`). Re-checks are free until the read is a day old.

| Rule | Reads |
|---|---|
| `minFollowers`, `minVerifiedFollowers`, `minTweetCount`, `minListedCount` | `public_metrics`, `verified_followers_count` |
| `verified`, `verifiedTypes` (blue / business / government), `identityVerified` | `verified`, `verified_type`, `is_identity_verified` |
| `minAccountAgeDays` | `created_at` |
| `hasProfileImage`, `hasDescription` | `profile_image_url` (the stock avatar counts as none), `description` |
| `referenceSetId` (inReferenceSet) | the claimant's X user id against the frozen ids |
| `followedByFromSet {min, perClaimCostCapUsd, referenceSetId}` | see below; **a rule that is present is enforced**. Only an explicit `enabled: false` turns it off, and then the rule is dropped so nothing displays it (`campaign-eligibility.js` `normaliseRules`) |
| always on, not a menu item | `parody` and `protected` are refused |

**Fail closed.** A missing or stale attribute fails its rule with a reason the person can act on. Stale means older than 24 hours. With `X_BEARER_TOKEN` set, a stale profile is refreshed by `GET /2/users/:id` ($0.01, paid by the platform). Without it, the page offers one click to reconnect X, which refreshes the attributes in the same round trip.

### followedByFromSet

The applicant is followed on X by at least N accounts from a frozen list. There are two ways to check:

1. **Token holders (cheap).** List members who signed in to Holler with X have a stored user token. The creator's own token is asked first, but only when the creator is on the list. Each holder looks up the applicant with `user.fields=connection_status`, which costs $0.01, and the check counts `following`. It stops at N, or when the next lookup would pass `perClaimCostCapUsd`.
2. **Fallback, only when no holder can answer.** With the app token, read the applicant's own followers list. That costs $0.01 per user returned, and the page size is capped at what the cost cap allows. The check counts members of the list.

If neither is available, the rule fails closed. Token refreshes are serialized per holder (`x-token-store.js`): X rotates refresh tokens, so two concurrent refreshes would spend the same one. The X cost of a check is **taken out of the campaign budget**: it is recorded at the door as a release to the platform's own address, which the door records as `RETAINED`. That is why `followedByFromSet` and creator-built X lists are USDC campaigns only: X bills in dollars. A result is cached on the claim for 24 hours, so repeated checks do not repeat the spend.

## What it costs (X API, pay-per-use, checked 2026-10-23)

| Read | Cost | Who pays |
|---|---|---|
| Profile lookup at link time | $0.01 | platform (same as before) |
| Stale-profile refresh on check | $0.01, at most once a day per account (a field X leaves out is stored as known-missing, not re-read); `/check` is limited to 6 a minute per campaign and 30 across campaigns per account | platform |
| `followedByFromSet`, holder path | $0.01 × holders asked (≤ cap) | the campaign budget |
| `followedByFromSet`, fallback | $0.01 × followers read (≤ cap) | the campaign budget |
| Reference set from a following list | $0.01 lookup + $0.01 × accounts, 1,000 a page, 300 requests / 15 min | the campaign budget (creator) or the platform (admin) |
| Reference set from an X List | $0.01 lookup + $0.01 × members, 100 a page | as above |
| Reference set pasted as ids | free | nobody |

An X build shows its estimate first, and runs only with `confirm: true` and `confirmCostUsd` at or above the estimate. It stops if the list grew past what was confirmed, and it never stores a partial list. A creator's X build needs a **funded** campaign to charge (`needs_funded`), so a draft cannot spend the platform's credits (`campaign-engine.js` `buildSet`).

**Every X spend charged to a campaign is held first.** Before the first X call, the engine holds the most it may cost (the confirmed cap plus $0.05 for the source lookup, or a check's `perClaimCostCapUsd`) against funded − (reserved + x-cost + held), synchronously. A spend that does not fit is refused before anything is called, so concurrent spends cannot each see the same remaining budget. Spends on one campaign also queue behind each other. After the calls the hold is settled: what X billed, never more than the hold, becomes an x-cost under a ref ending in a random UUID. Holds live on the campaign record (`xHolds`), so the refund waits for them. A hold written by an earlier process cannot settle, and the sweep drops it (the platform absorbs whatever it spent). X spend is refused on a closed or refunded campaign.

**Estimates.** `POST /api/reference-sets/estimate` is rate-limited to 10 a minute per account (`campaign-routes.js` `estimateAllowed`). A pasted list, or a server with no `X_BEARER_TOKEN`, makes no X call and is free. Otherwise the first 3 estimates for a campaign are on the platform (`FREE_ESTIMATES`) and each one after that is held and charged to the campaign.

## Money

The campaign engine holds no key and signs nothing. Everything moves through `settlement.js`, against a recorded intent:

| Step | Door call | Ref |
|---|---|---|
| Fund | `settlement.pull({signer: 'campaignPull'})`: creator → platform wallet (`SELLER_WALLET_ADDRESS`), by the ERC-20 allowance the creator approved in the browser to the **dedicated campaign spender** (`CAMPAIGN_SPENDER_KEY`'s address, never the seat spender) | `campaign:fund:<id>:<attempt>` |
| Pay | `settlement.release({signer: 'platform', bucket: 'campaign'})`: platform wallet → claimant's payout wallet, once the claim reaches `require`, in the token that was **pulled** | `campaign:pay:<claimId>` |
| X cost | `settlement.release` to the platform address (recorded `RETAINED`) | `campaign:xcost:<tag>:<id>:<uuid>` |
| Refund | `settlement.refund`: platform wallet → the funding wallet, in the pulled token, after close, after every owed and honoured claim and every X hold has settled; amount = funded − Σ releases | `campaign:refund:<id>` |

**What funded means.** `fund` snapshots the token and amount before its first await and writes them into `funding` (`{token, atomic, ref, wallet}`) when it marks the campaign `funding_pending`, just before the pull. Payouts and the refund use only `funding.token` (`moneyToken` in `campaign-engine.js`), never the draft's editable fields. A campaign is `funded` only when the pull's receipt is seen to succeed. With no receipt (a timeout, the RPC down) it stays `funding_pending` and the sweep asks again from the door's PULL row. A reverted receipt puts it back to `draft` with the attempt in `fundingFailures`. A pull that **throws** goes back to `draft` only when the error proves nothing was sent (`provablyPreSend`: the door says it signed nothing, or viem's error chain holds `EstimateGasExecutionError` or a `ContractFunctionRevertedError` with its reason). Any other throw (an RPC timeout, "already known") may have been broadcast: the campaign stays `funding_pending`, flagged `needsPerson`, and a retry is refused. The campaign spender's pulls are signed locally first and the door records `PULL_SENT {ref, txHash}` before the raw transaction is sent (`settlement.js` `SIGN_AHEAD_SLOTS`), so a lost send still leaves a hash whose receipt the sweep settles; a hash with no receipt after 30 minutes waits for a person and is never re-sent. A campaign still `pulling` with no PULL row means a process stopped mid-pull; it stays pending and is flagged `needsPerson` (`reconcileFunding`). After 30 minutes (`STUCK_FUNDING_MS`) with no transaction hash, the sweep asks the chain (`findFundingTransfer`, the token's Transfer logs since the attempt): no Transfer of exactly the budget from the funding wallet to the platform wallet means the pull never landed, and the campaign goes back to `draft` with the attempt in `fundingFailures`; a matching Transfer, or logs that cannot be read, means a person decides. The allowance is never consulted: the creator sets it, and re-approving after a landed pull made one look like it never happened (round 3). An admin can run the same rule on demand: `POST /api/campaigns/admin/c/:id/resolve-funding`. Nothing is ever marked funded on a guess.

**What the receipt has to show (round 4, the cold review).** A success receipt is not enough on its own (`settleFunding` in `campaign-engine.js`):

- It must be **this** transaction's receipt. `server.js` builds `confirmTx` from `receiptConfirmer`, which asks viem with `checkReplacement: false` and drops a receipt whose `transactionHash` is not the hash asked about. viem's default answers a hash whose nonce another transaction from the same sender used with that other transaction's receipt, which marked a campaign funded with nothing pulled. The engine checks the hash again (`funding-receipt-foreign` on its ledger).
- Its own logs must hold an ERC-20 `Transfer` of the pulled token from the funding wallet to the platform wallet (`transferredInReceipt`, decoded from the raw logs). None → `funding_pending`, `funding.state: 'unproven'`, a person decides (`funding_unproven`). Less than the budget, as with a fee-on-transfer token → `funding_pending`, `state: 'short'`, `receivedAtomic` and `shortfallAtomic` on the campaign and a `funding-short` ledger row, a person decides (`funding_short`). The budget → funded, credited exactly what moved; more than the budget falls to the terms-mismatch path (closed, and exactly what moved is refunded).
- The door records the hash **we signed**. A node or proxy that answers `sendRawTransaction` with another hash is logged and kept as `nodeHash` beside it (`settlement.js` `pullNow`); it never becomes the hash whose receipt decides.

**A stuck funding is written up once (audit fix round, 2026-10-24).** `funding-unconfirmed` is written once per transaction hash (`funding.unconfirmedHash`), and `funding-unknown` once per reason: each verdict carries a stable code (`funding.needsPersonCode`, compared by `askPerson` in `campaign-engine.js`), because the sentence can carry a nonce count or an RPC error that differ from one reconcile to the next. The stored reason names the attempt time (`funding.at`), never the elapsed minutes; a view renders the minutes. Before this, a stuck pull wrote both rows and rewrote `campaigns.json` on every reconcile, about 2,900 rows a day. Once a person has been asked and the attempt is past 30 minutes, the sweep re-asks the chain every 10 minutes (`PERSON_RECONCILE_MS`), not every 15 seconds; the admin resolve still asks at once.

**One campaign pull at a time.** `settlement.js` runs `campaignPull` pulls one at a time (`SERIAL_PULL_SLOTS`, a per-slot lock around prepare, `PULL_SENT` and the send), so two funds in one process can never sign the same nonce. After a send the node accepted with nonce n, the next pull signs with at least n + 1 for two minutes (`NONCE_FLOOR_TTL_MS`), even through a load-balanced RPC whose node has not seen n yet; past that the chain's pending count decides alone, so a dropped transaction cannot leave a lasting gap. The seat meter's `pull` slot is not serialized by this: its per-tick pulls keep `writeContract` as before. The lock is in-process, so the server must run as **one** replica while `CAMPAIGN_FUNDING=1`.

**A signed pull that can no longer land.** `PULL_SENT` records the nonce the pull was signed with (and Tempo's nonce key, if viem chose one). A hash with no receipt after 30 minutes goes back to `draft` only when all three are chain facts (`droppedPullVerdict`): the spender's mined transaction count is past that nonce (`readSpenderNonce`), no node knows the hash (`txKnown`), and no Transfer of the budget reached the platform wallet since the attempt (`findFundingTransfer`). Anything unknown, unreadable or unwired, or a Tempo nonce key, leaves it to a person. The sweep and the admin resolve use the same rule.

**Who holds and who signs.** The creator approves the campaign spender; the campaign spender's key pulls the budget **into** the platform wallet (`SELLER_WALLET_ADDRESS`), which holds every budget; rewards and refunds go out of that same wallet, signed by `PLATFORM_SETTLEMENT_KEY` (which `server.js` refuses unless it resolves to `SELLER_WALLET_ADDRESS`). So one platform wallet holds and pays; a second address only pulls. The fund route's `needsApproval` names both: `spender` (approve this) and `holder` (where the budget sits). The campaign spender pays its own fee in the token it moves, so it must hold a little USDC.

**Whose wallet.** The funding wallet must be proven twice. First by its approve transaction (`approveTx`), read on chain by `readApproval` in `server.js` and checked in `approvalProblem` (`campaign-engine.js`): sent **from** that wallet, **to** the reward token, succeeded, mined in or after the second the campaign's money terms were last set (`termsAt`: creation, or the last edit of its token or budget; block times are whole seconds), with an `Approval` log for exactly the budget from that wallet to the campaign spender. One approval funds one campaign. Second, by the wallet's **EIP-712 signature** over a `Fund` message (`fundSignatureProblem`): domain `{name: 'Holler Campaigns', version: '1', chainId}` (no `verifyingContract`: the spender is a plain wallet), message `{campaignId, wallet, token, amountAtomic, deadline}`, the deadline at most 10 minutes away (`FUND_SIGNATURE_MAX_SECS`). The server compares the message to the campaign field by field, then verifies the signature against the message **it rebuilds** from the campaign (`fundTypedData`), never against the client's domain or types; `server.js` verifies through the Tempo public client, which handles an EOA locally and a contract wallet through ERC-1271 / ERC-6492. One signed message funds at most one attempt (keyed by the message hash, `fundSigHash`, so a re-encoded signature is the same message). The approve proves only that some wallet approved the spender, which a stranger's approve for the same amount also does; the signature proves the wallet meant this campaign (OPEN-ISSUES N10, closed). A bare wallet is refused (`approve_required`), an approve without a signature too (`signature_required`). The UI signs right after the approve mines (`approve-step.tsx`, `eth_signTypedData_v4`, no gas).

Guards, each one in `_gate-campaigns.mjs` C:

- Funding is refused unless `CAMPAIGN_FUNDING=1`. The route checks it before answering "approve the budget", so nobody pays gas for an approve that would be refused, and the message does not name the variable ("Paid campaigns aren't open on this server yet").
- With no pull signer, funding is refused **before** `pull` is called, because a dry pull would record a budget nobody paid.
- An allowance below the budget is refused, and so is a second funding attempt.
- While a pull is in flight or awaiting its receipt, `updateCampaign` and `close` are refused (`funding_in_progress`): in-process by a lock, and across restarts by the `funding_pending` status.
- If the campaign's token or budget no longer matches what was pulled when the receipt lands, it does not open: it closes with the mismatch on the ledger and the refund returns what was pulled, in the pulled token.
- A payout happens only after the required state, only once (the door dedupes on the ref, and `tryPay` also refuses to exceed the funded amount), never for an ineligible claim, and never on a hidden campaign (`campaign-engine.js` `advance`, `tryPay`).
- Closing (by the creator, an admin, or the deadline) honours a claim whose Holler or seat was already submitted: it still counts if it reaches `require` within `CAMPAIGN_CLOSE_GRACE_HOURS` (default 48) of the close, and the refund waits for it. A slot reserved but not yet bound to a Holler or seat expires at close. Past the window the sweep expires it and the refund follows.
- An owed claim with no wallet waits up to `CAMPAIGN_WALLET_GRACE_DAYS` (default 14) and then is forfeited, so the refund cannot be held forever.
- A `FAILED` payout stays counted against the budget, so the refund does not return money a claimant is owed. It needs a person, and there is no manual "mark paid" because an off-door payment would unbalance the ledger.

What actually sends money is the door's flush, with `PLATFORM_SETTLEMENT_KEY`. Without that key, payout and refund intents wait as `PENDING`.

## Paid actions and when they count

`aired` is the default for both actions (`REQUIRE_OPTIONS` in `campaign-engine.js`; the first option is the default). The other option stays selectable, and the form labels what it means.

| Action | `require` | Counts when |
|---|---|---|
| Holler | `aired` (default) | the clip **played to the end** on the overlay (`letter_end`), not merely started, **while the room was on air** (Twitch says its channel is live: an open airing, so the play recorded a moment). A play to an off-air room never counts, and neither does one without the room's **keyed** overlay (`&k=` in its URL) connected at the play's start and end (OPEN-ISSUES N14, closed); such a play is recorded on the claim as `playedUnauthed` |
| Holler | `approved` | the clip clears the room's moderation. In an **auto-moderated** room that is the moment the upload passes the automatic check, with nobody looking; in an approve room it is the approve click |
| Call in | `aired` (default) | the seat's camera track stayed published for `minSeconds` (default 60) **continuously, while the room was on air and the seat was live** (the guest pressed GO LIVE), timed by the server from the LiveKit webhook |
| Call in | `joined` | a signed LiveKit webhook says the seat's own identity published a camera (video, not a screen share) track in that room, **while the room was on air and the seat was live** |

**A Call in counts only from a server-side signal.** The client's `camera_ready` WebSocket message is sent by whoever holds the seat id, so it no longer reaches the campaign engine (`activateSeatLive` in `server.js`). `/api/livekit/webhook` verifies the delivery's signature against `LIVEKIT_API_SECRET` and then calls `campaignSeatSignal` (`server.js`): `track_published` for identity `seat:<id>` (minted only for the seat the join route granted), in that seat's LiveKit room, with a video track that is not a screen share → `camera_on`; `track_unpublished` of that track or `participant_left` → `camera_off`. The engine times `aired` from `camera_on` and restarts the clock when the camera goes off. A Call in campaign needs a room on the LiveKit transport (`needs_livekit`) and a server with LiveKit configured (`callin_unverifiable` otherwise). If LiveKit is configured but its webhooks are not delivered to the server, Call in claims never count: they fail closed, and the refund follows after close.

**A Call in counts only on air (round 4).** The same source of truth the Holler `aired` hook reads: an open airing for the room (`airings-store.js` `openAiringFor`, opened when Twitch says the room's channel is live; `letters.js` records a Holler's moment only then). `server.js` passes it to the engine as `roomOnAir`, and an unwired engine treats every room as off air. A camera published off air starts nothing and the claim carries `offAir` / `offAirAt` (`claimView`), so the page can say why. The on-camera clock runs only on air: the sweep starts it if the room goes on air with the camera still up, and stops it if the room goes off air, after which the next minute starts from zero (`campaign-engine.js` `syncSeatClock`). The keyed-overlay condition is Holler-only; a Call in has no overlay key to present.

**A Call in across a restart (audit fix round, 2026-10-24).** `server.js` keeps seats in memory (`activeSeats`), so a deploy mid-call leaves the claim bound to a seat nobody holds, and that seat's camera webhook is dropped from then on. `server.js` passes `seatState` to the engine: `'gone'` when `activeSeats` no longer holds the seat, `'live'` once the guest pressed GO LIVE, `'preview'` before. A Call in claim in flight on a seat that is gone gives its slot back (`deadSeat` / `releaseDeadSeat` in `campaign-engine.js`) in three places: when the guest reserves again (so the rejoin works at once), in the sweep, and on that seat's `camera_off` (a `participant_left` after the restart). The clock starts again on the new seat. The server never credits the seconds before the restart: it had no seat across the restart and cannot prove the camera stayed up (DECISIONS.md). `ended` is exempt: `removeParticipant` drops the seat from `activeSeats` first and then sends it, and that one counts as before. An engine with no `seatState` wired behaves as it did. Like the funding lock, this needs **one** replica: a second process would see every seat of the first as gone.

**A Call in counts only from a live seat (audit fix round, web finding NEW-1).** In a LiveKit room the browser publishes its camera during the preview, before GO LIVE, so LiveKit's `track_published` arrives while the overlay shows nobody: the overlay draws the guest only on `seat_added`, which GO LIVE triggers (`activateSeatLive` in `server.js`). The on-camera clock therefore needs both halves: the signed webhook (the camera is published) and a live seat (`seatState` answers `'live'`). A camera published in the preview starts nothing; the claim keeps `cameraLive` and a history note. When the seat goes live the clock starts, on a `seat_live` engine event if `server.js` sends one from `activateSeatLive`, otherwise on the next sweep (at most 15 s later). The client's `camera_ready` can only make counting stricter: on its own it counts nothing (`_gate-campaigns.mjs` C11.7, D5c). Moving the client's publish to GO LIVE is the web lane's half.

**Slot reservation and release.** A slot is reserved when the Holler is submitted, or when the join route grants a seat. It happens synchronously and before any payment step. The slot is given back if:

- the payment step answers 402
- the upload never arrives
- a held clip expires
- the seat leaves early
- the join route answers anything but a seat
- `bind` refuses it (the campaign closed, passed its deadline or was hidden between the reserve and the bind; `bind` gives the slot back itself, since `letters.js` does not read its answer)
- it is still bound to nothing 10 minutes after it was reserved on a live campaign (`UNBOUND_RELEASE_MS`: a restart between the reserve and the bind), longer than any payment step or escrow deposit between the two
- its seat is one the server lost (above)

A rejected Holler ends the claim as `rejected`.

**Where the hooks are:**

- Holler: `letters.js`: `settleIntoQueue`, the approve, reject and refund paths, and play completion.
- Call in: `server.js`: `campaignSeatSignal` (called from the verified LiveKit webhook) and `removeParticipant`.
- The join routes are wrapped by `campaignJoinMiddleware` (`campaign-routes.js`), so none of them changed.

**The room's own Holler price still applies.** A campaign Holler in a paid room charges the claimant the room's price. Use a free room, or price it at 0, for a pure reward campaign. See `DECISIONS.md`.

## Routes (`campaign-routes.js`, one table with a tier per route)

| Path | Tier |
|---|---|
| `GET /api/campaigns/:slug` | public; for a `cmp_…` id: the creator only |
| `GET /api/campaigns/:slug/my-claim` | public |
| `POST /api/campaigns/:slug/check` | signed in |
| `GET /api/campaigns/mine`, `POST /api/campaigns`, `PATCH /api/campaigns/:id`, `POST /api/campaigns/:id/fund` (`{ok}` or `{needsApproval}`), `POST /api/campaigns/:id/open`, `POST /api/campaigns/:id/close`, `GET /api/campaigns/:id/claims` | signed in; the engine checks that the campaign is the caller's |
| `GET /api/reference-sets/mine`, `POST /api/reference-sets/estimate`, `POST /api/reference-sets`, `GET /api/reference-sets/:id`, `POST /api/reference-sets/:id/refresh` | signed in |
| `GET /api/tokens/:address`, `POST /api/account/payout-wallet`, `GET /api/campaign-config` | signed in |
| `GET /api/campaigns/admin/all`, `POST /api/campaigns/admin/c/:id/hide`, `POST /api/campaigns/admin/c/:id/close` | admin: the site owner's account or `BOUNTY_ADMIN_KEY` |

The gate calls every non-public route without credentials and expects 401, then calls the admin routes as a non-admin and expects 403.

`POST /api/account/payout-wallet` pays the caller's own owed claims (`payAccount`) and nothing else; it used to run the whole sweep on demand for any signed-in caller. It is limited to 6 a minute per account (`WALLET_PER_MIN`). The estimate, check and wallet limits share one sliding-window helper (`perMinute` in `campaign-routes.js`).

## The sweep

`sync()` runs every 15 seconds (`start`) and walks the campaign ids, one campaign at a time (`sweepCampaign` in `campaign-engine.js`). Each campaign is read fresh when its turn comes. A campaign past its deadline is closed in place (`closeNow`): the sweep and `close()` used to call each other, so K campaigns past a shared deadline recursed K deep, walked every campaign K times, and wrote a stale snapshot back over a closed campaign. A route `close()` now sweeps only its own campaign; the 15-second sweep reaches the others. Drafts are skipped (no claims and no X holds before funding), and so is a closed campaign that is refunded (or had nothing to refund), holds no X spend and whose every claim is final, from the sweep after the one that saw it so. At 1,000 campaigns × 50 claims the sweep took 11–13 s of the event loop; the claims index and these skips bring it to well under a second (`_gate-campaigns.mjs` C11.2 measures 100 × 50 in its log line).

## Pages

- `/c/[slug]` (`web/app/c/[slug]/page.tsx`, `web/components/campaign-offer/`) shows:
  - the offer
  - the rules in plain words
  - the frozen-list fingerprint
  - "Check if I qualify", which runs X sign-in through our own OAuth if X is not linked, then the check
  - the result rule by rule
  - "Record your Holler" or "Call in on the stream" for people who qualify
  - the claim status, and the payout-wallet ask

  It carries OG and Twitter metadata for sharing on X.
- `/dashboard/campaigns` is the creator dashboard, built separately against the same routes (`web/lib/campaigns-api.ts`, `web/components/campaigns/`).
- The join page carries `?campaign=` into every Holler send and seat join (`campaignField` in `web/lib/join-page.ts`).

## Environment (names only)

| Name | Effect |
|---|---|
| `CAMPAIGN_FUNDING` | `1` lets a campaign take a real budget; anything else refuses funding |
| `CAMPAIGN_WALLET_GRACE_DAYS` | days an owed claim waits for a payout wallet after close (default 14) |
| `CAMPAIGN_CLOSE_GRACE_HOURS` | hours after a close in which an already-submitted Holler or Call in can still count (default 48) |
| `CAMPAIGN_FEE_TOKENS` | comma-separated token addresses a campaign may use besides USDC; empty means USDC only |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit, whose signed webhooks are the only signal a Call in counts from |
| `X_BEARER_TOKEN` | the X app token: stale-profile refresh, X-built reference sets, the followers fallback |
| `X_TOKEN_KEY` | encrypts stored X user tokens; falls back to `AUTH_SECRET` |
| `SELLER_PRIVATE_KEY`, `SELLER_WALLET_ADDRESS` | the seat pull signer; `SELLER_WALLET_ADDRESS` is the platform wallet that holds campaign budgets |
| `CAMPAIGN_SPENDER_KEY` | the dedicated campaign spender a creator approves; it only pulls budgets into the platform wallet. Unset, or resolving to the same address as any other signer (`SELLER_WALLET_ADDRESS` / `SELLER_PRIVATE_KEY`, `PLATFORM_SETTLEMENT_KEY`, `REWARD_POOL_PRIVATE_KEY`, `ESCROW_OPERATOR_KEY`, `ESCROW_ATTEST_KEY`): campaigns refuse to fund, in plain words, and the boot log names the clashing variable |
| `PLATFORM_SETTLEMENT_KEY` | the door's payout signer; without it, intents stay `PENDING` |
| `AUTH_SECRET` (or `MPP_SECRET_KEY`) | also seals the overlay key (`overlay-key.js`). In production with neither set there is no overlay key, so no campaign Holler can count as aired; the boot log names the variables |

## Hardening (2026-10-23): each defect, its fix, its gate case

An adversarial review reproduced these against the engine and the real `settlement.js` with a mock chain. Every case below is in `_gate-campaigns.mjs`, and each was shown to **fail with its fix reverted**: a mutation runner reverts one fix at a time, runs `node _gate-campaigns.mjs --engine-only`, requires the named case to fail, and restores the file byte-for-byte (sha-256 checked). The D5/D6 cases were proven the same way against the server.

| Defect | Fix | Gate case |
|---|---|---|
| Token switched while the pull was in flight; 10,000 JUNK pulled, 10,000 USDC refunded | snapshot the pulled `{token, atomic}` into `funding`; pay and refund only in it; refuse update/close while funding; a post-pull mismatch closes and refunds the pulled token | C10.1 (×4) |
| An unconfirmed receipt counted as funded | `funding_pending` until a success receipt; the sweep reconciles from the door's PULL row; reverted → draft with `fundingFailures` | C10.2 (×7) |
| Five concurrent $9 X builds on a $10 budget recorded $45; estimates free and unbounded; X refs from `Date.now()` | X spend held before the first call and settled after; one spend at a time per campaign; estimates rate-limited and charged after 3; refs end in a UUID | C10.3 (×6) |
| A Call in paid on the client's `camera_ready` | counts only from a signed LiveKit `track_published`; `aired` default | C10.4 (×4), C5, D5 (×4) |
| A stale check overwrote an owed claim | re-read the claim after the awaits; write only over eligible/ineligible | C10.5 |
| Closing a draft during the pull was overwritten back to funded | the funding lock and `funding_pending` refuse close | C10.6 |
| Custom ERC-20 fees paid in the token moved | `CAMPAIGN_FEE_TOKENS` allowlist; USDC door behaviour unchanged | C10.7 (×2) |
| X cost after close/refund; hidden or past-deadline claims advancing; the creator vouching from off the list; concurrent X token refreshes | refund waits for X holds, X spend refused once refunded; hidden blocks advance, unsubmitted slots cannot advance past the end (`campaign-engine.js` `advance`); creator vouches only from the list; one refresh per holder | C10.8 (×7) |
| C4 asserted a constant (`5 + 7 === 12`) | Σ pay + Σ x-cost + refund = funded, read from the door, with the chain's transfers | C4, C9 invariants run on every engine |
| A FAILED payout path untested | FAILED once, claim `failed`, no re-send, refund = funded − the failed payout | C10.9 (×2) |
| Someone else's wallet could be pulled (leftover seat allowance) | the approve transaction proves the wallet; one approve per campaign | C10.A (×2), D6 |
| Close cancelled Hollers already in the queue | submitted claims honoured for 48 h; the refund waits | C10.B (×5) |
| followedByFromSet without `enabled` stored as off, displayed as on | a present rule is enforced | C10.C |
| The fund route asked for an approve with funding off, and named the env var | refuse first, plain words | C10.D, C1 |
| **Round 2 (2026-10-23)**, reproduced first in `scratchpad/judge-money-2/break-2.mjs` (9/9 attacks succeeded before, 0/9 after) and each case shown to fail with its fix reverted on a copy of the tree (`mutate.mjs`, 17/17, sha-256 restored) | | |
| N10: a stranger's approve to the spender, equal to the budget and mined after creation, could fund the creator's campaign | the funding wallet signs an EIP-712 `Fund` message naming the campaign, wallet, token, amount and a ≤ 10 min deadline; verified against the server-rebuilt message, ERC-1271-aware; one message per attempt | C10.F (×6), D6 |
| An old draft's budget edited to match someone's fresh approve; an honest approve in the creation second refused (seconds vs ms) | `termsAt` stamped on every token/budget edit, the approve must be mined in or after that second | C10.G (×2) |
| Campaign and seat approvals shared one spender (the seller key), so a seat could spend a creator's un-pulled budget allowance | a dedicated campaign spender (`CAMPAIGN_SPENDER_KEY`, door slot `campaignPull`); a seat's cited approve must be FROM the payer (`verifyPasskeyStreamAllowance`) | C10.H (×4), C1, D6 |
| `funding_pending` forever after a process stopped mid-pull | after 30 min with no tx and the whole budget still allowed → draft (sweep, or the admin resolve route); otherwise a person decides | C10.I (×4) |
| A hidden campaign still paid owed claims from the sweep | `tryPay` pays nothing while hidden | C10.J |
| Non-qualifying applicants could spend the budget on followedBy checks | a total ceiling, `rules.followedByFromSet.maxTotalUsd` (default 20% of the budget); past it, checks stop with a plain reason | C10.K (×2) |
| A slot reserved just before the deadline and bound after it was honoured for 48 h | `bind` refuses once the campaign has ended | C10.L |
| A LiveKit subscriber token (any visitor can get one, same secret, no `sha256`) passed as a signed webhook | a webhook token must carry `sha256` matching the body and an issue time (`iat`, or `nbf`) inside the window | C10.M (×2), D5 |
| A fake overlay socket made a clip "aired" in a room that was not broadcasting | `aired` counts only when the room is on air (the moment is non-null) | D4b |
| The claim view could not say "queued" vs "sent", or show the grace end; the form could not warn about a missing X app token | `claimView` carries `honourUntil` and `payoutsEnabled`; the creator view carries `xAppToken`, `payoutsEnabled`, `xCheck` and a warning | C10.B, C10.H |
| No deadline required; budget sanity | deadline required, future, ≤ 90 days; budget ≥ one reward; warning above reward × maxClaims | C10.E (×2) |
| **Round 3 (2026-10-23)**, reproduced first in `scratchpad/judge-money-3/break-3.mjs` (5 of 9 attacks succeeded before — A1, A2, A3b, A6, A8 — 0 of 9 after), each case shown to fail with its fix reverted on a copy of the tree (`scratchpad/fix-money-3/mutate.mjs`, 17/17 across 12 reverted fixes, 2 of them over HTTP, sha-256 restored) | | |
| A pull that threw after it was broadcast (RPC timeout, "already known") went back to draft; the creator's retry pulled the budget twice | a throw goes back to draft only when it is provably pre-send (`provablyPreSend`); otherwise `funding_pending` + `needsPerson`, retry refused. The campaign spender signs locally and the door writes `PULL_SENT {ref, txHash}` before the raw send, so the receipt can settle it | C10.N (×6) |
| The stuck-funding sweep decided "the pull never landed" from the allowance, which the creator controls (re-approve after a landed pull → draft → second pull) | decided from chain facts: the token's Transfer logs since the attempt (`findFundingTransfer`) or a `PULL_SENT` hash's receipt; draft only when no transfer and no hash exist | C10.O (×2), C10.I |
| X leaving one field out made every check by that account a platform-paid profile read, with no rate limit | a field X leaves out is stored as `null` (known missing, fails closed); a refresh only when the last read is over a day old or there has never been one; `/check` rate-limited per account | C10.P (×3), D2b |
| A used Fund signature (and its approve) became reusable after 10 later failures pushed it out of `fundingFailures` | reuse is checked against every `funding-started` row in the append-only campaign ledger (which now carries `approveTx`) | C10.Q (×2) |
| A live campaign's deadline could move to 2099 | a live deadline moves at most 90 days from now and at most 90 days past the deadline it opened with (`originalDeadline`) | C10.R (×2) |
| Spender separation only compared the campaign spender with the seller address | boot refuses a `CAMPAIGN_SPENDER_KEY` that resolves to any other configured signer, naming the variable, never the key | C10.S, D8 |
| A seat's cited approve was waved through when the hash was junk or unmined (the receipt error was swallowed) | a cited hash must be well-formed, mined, successful and the payer's (`token-utils.js` `citedApproveProblem`); none cited keeps the allowance-only behaviour, logged (OPEN-ISSUES N16) | C10.T |
| **N14 (2026-10-23)**: the overlay was self-declared (`role:'overlay'`), so during a real broadcast any socket could make a campaign Holler "play" and count. Each case below was shown to fail with its guard reverted (9 mutations, 14 case verdicts, on a copy of the tree, full HTTP runs; `scratchpad/judge-n14/mutate.mjs`) | | |
| An overlay socket with no key, or a wrong key, made an on-air play count as aired | a per-room overlay key, HMAC of the room id under the sign-in secret (`overlay-key.js`), rides the manager's overlay URL as `&k=`; `public/overlay.html` sends it in `subscribe_room`; the server marks `ws.__overlayAuthed` only on a constant-time match. A campaign `aired` needs the keyed overlay connected at the play's start **and** end (`letters.js` `hasAuthedOverlay`); unkeyed overlays still render everything | D4c NO KEY, WRONG KEY, TOO LATE; D4 (keyed → owed) |
| The key reaches only the room's manager, and survives the pretty link | `overlayUrl` with `&k=` only on create, unlock and the owner's room read (`dashboard-routes.js`); `/<handle>/overlay?k=` forwards it. Since round 4 only the **signed-in owner** gets `&k=` (see below) | D4c (dashboard URL, anon refused; redirect) |
| An unkeyed play left the claim `approved` forever with nothing said to either side | the claim records `playedUnauthed` / `playedUnauthedAt` (moves nothing); the creator view carries `overlay: 'keyed' \| 'unkeyed' \| 'none'` (last 10 min), `overlayKeyed`, `overlayLink` | D4c NONE, "not silent"; D4 (keyed) |
| **Round 4, the cold review (2026-10-23)**, reproduced first in `scratchpad/judge-cold/break-4.mjs` against a mock chain with a nonce per sender, a mempool, blocks and viem 2.54's replacement semantics (B1–B5 succeeded before, 0 of 9 after; the harness was adapted to the new receipt contract, its attacks unchanged, the original kept as `break-4.orig.mjs`). The gate's `nonceChain` is a port of that mock. Each case was shown to fail with its fix reverted on a copy of the tree (`scratchpad/fix-cold-4/mutate.mjs`, 24/24 case verdicts across 18 reverted fixes, 3 over HTTP, sha-256 restored) | | |
| B1: two concurrent funds signed the same spender nonce; viem answered the dropped one's receipt wait with the other's success receipt; the campaign was marked funded with nothing pulled and refunded from the pooled platform wallet | one `campaignPull` pull at a time (`settlement.js` `SERIAL_PULL_SLOTS`) with a two-minute nonce floor; `receiptConfirmer` with `checkReplacement: false` and the receipt's hash required to match; `settleFunding` requires the hash again and a Transfer(wallet → platform) of the pulled token in that receipt's logs | C10.U B1 (×4), (1c) |
| B1b: the same race where the node refuses the second send left that campaign `funding_pending` forever with a hash that never mines | `PULL_SENT` records the signing nonce; after 30 min a pull whose nonce was used elsewhere, whose hash no node knows and whose budget never arrived goes back to draft (sweep and admin resolve) | C10.U B1b (×4) |
| B2: a Call in counted as aired with the room off air | Call in `joined` / `aired` only while the room is on air (`roomOnAir`, the Holler's own source of truth); the clock runs only on air | C10.U B2 (×3), D5b |
| B3: the never-past-funded ceiling read the campaign record's x-cost, which a stop between `settleX`'s two writes can miss | `tryPay` (`campaign-engine.js`) reads the door's own `campaign:pay:` and `campaign:xcost:` releases for the campaign | C10.U B3 |
| B4: a fee-on-transfer token was credited and refunded at 100% | credited exactly the Transfer value; short of the budget → not funded, a person, the shortfall on record | C10.U B4 |
| B5: an RPC answering `sendRawTransaction` with a foreign hash made that transaction's receipt fund the campaign | the door records the signed hash; the node's answer is kept as `nodeHash` only | C10.U B5 |
| `/api/dashboard/unlock` handed out the keyed overlay URL on a room password alone, with no rate limit | 10 unlock attempts a minute per IP and per room (`unlockAllowed`), counted before the password check; the keyed URL only to the signed-in owner on create, unlock and the room read; a password gets the plain URL | C10.U (6), D9 (×3) |
| `overlay-key.js` derived keys from the public dev-secret fallback in any environment | in production with neither `AUTH_SECRET` nor `MPP_SECRET_KEY` set there is no key: the plain URL is handed out, no socket counts as keyed, and the log names the variables | C10.U (6) |
| **Audit fix round (2026-10-24)**, each finding reproduced first by the audit's verifier (`scratchpad/audit/verify-campaigns-identity/rerun/`), each case shown to fail with its fix reverted on a copy of the tree (`scratchpad/audit/fix-campaigns/mutate.mjs`) | | |
| A Call in across a restart was stranded at `joined` (the seat's clock lived only in a timer, `activeSeats` in memory); the guest's rejoin was refused `already_claimed`; a `participant_left` after the restart paid for minutes nobody saw | `seatState` (`activeSeats`): a claim on a seat the server lost gives its slot back on reserve, in the sweep and on `camera_off`; the clock starts again on the new seat | C11.1 (×3) |
| The sweep listed every claim of every campaign once per campaign (11–13 s at 1,000 × 50), drafts included; any signed-in caller could trigger a whole extra sweep through `POST /api/account/payout-wallet`; drafts were uncapped | an in-memory claims index by campaign and by account; drafts and settled campaigns skipped; the wallet route pays that account only, rate-limited; 20 drafts per account | C11.2 (×6) |
| A stuck funding wrote `funding-unconfirmed` and `funding-unknown` and rewrote `campaigns.json` on every reconcile (the reason embedded the elapsed minutes) | once per hash, once per reason code; no minutes in the stored reason; re-asked every 10 min once a person has been asked | C11.3 (×2), C10.I |
| A slot reserved and never bound (a restart mid-send, or `bind` refused) held its place until the campaign ended | the sweep gives it back after 10 min on a live campaign; `bind` gives back a slot it refuses | C11.4 (×3) |
| `close()` and `sync()` called each other: K expired campaigns recursed K deep, and a stale snapshot was written back over a closed campaign (duplicate `closed` / `refund` ledger rows; the door deduped the money) | one campaign per turn, read fresh, closed in place; a route close sweeps only its own campaign | C11.5 |
| The public offer page cloned the whole frozen list four times a view to read its name and count | `getSetMeta` (no ids, no handles) for every view | C11.6 |
| NEW-1 (web audit): the browser publishes its camera in the preview, so `track_published` started the clock before GO LIVE and a Call in could count time the overlay never showed | the clock needs a live seat too (`seatState`); a preview camera starts nothing; going live starts it (`seat_live`, or the sweep) | C11.7 (×2), D5c |
| `CAMPAIGN_CLOSE_GRACE_HOURS` / `CAMPAIGN_WALLET_GRACE_DAYS` set to a non-number read as NaN, and a NaN grace made every close throw | read through `envNum` (`env-num.js`): unset, empty or non-numeric is the default; the existing floors stay | C11.8 |

## Why Reclaim and Opacity stay stubs

Reclaim's zkTLS has no provider that proves "who follows me", and Opacity's documentation could not be read (`attestation/reclaim.js`, `attestation/opacity.js`). The inbound-follow signal comes from `connection_status` on stored tokens instead. Revisit when a zkTLS provider can prove an inbound follow.
