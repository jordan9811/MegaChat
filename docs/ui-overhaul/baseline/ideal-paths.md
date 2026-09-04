# Ideal paths — UX task-flow baseline for megachat.fun

Walked 2026-09-02 against the live site (`https://megachat.fun`, the `v0-ui-migration` deploy) with a headless Chromium driven by my own Playwright 1.62 script (fake camera/mic device, 1440x900, signed out, no cookies). Screenshots: `docs/ui-overhaul/baseline/ideal-paths-screens/` (names sort in walk order; `00-recon-*` are the raw page captures, `01-`..`47-` are the click-throughs).

Rules I held to: every step below was clicked, not inferred. Where a step needs a signed-in session it is a DEAD END: the only sign-in is the real Privy modal (email / Google / Twitter / Twitch / passkey) and there is no test login. "Per source" means I read it in `web/components/*` on the `feat/ui-overhaul` worktree and did NOT see it on the live site.

Side effects I left on production, all on my own throwaway data: seven unlisted, free, password-only rooms named `uxbench-tmp`..`uxbench-tmp7` (ids `3dc58fd1`, `90df2353`, `2830fd70`, one unrecorded, `7104eae7`, `2bca1038`, `e338cb10`) and one free test MegaChat queued into `3dc58fd1`. `server.js` prunes every un-owned room that is not `default`/`demo` at boot (`pruneOrphanRooms`, unless `KEEP_ORPHAN_ROOMS=true`), so they should vanish on the next deploy; worth a glance at `/api/dashboard/my-rooms` after. I did NOT press "Pay 5 USDC & send" on a bounty, did NOT "Claim this handle", and did NOT send anything into `/demo` or `/jordandotfun`.

## Summary

| Task | Ideal clicks | Target s | Walkable? | Stopped by |
|---|---|---|---|---|
| T1 Learn what MegaChat is | 1 | 45 | yes | — |
| T2 Send a MegaChat (record, pay, send) | 6 | 40 | up to Send | Privy sign-in modal on "Send" (paid rooms). Free rooms complete. |
| T3 Bounty guaranteed vs contested | 1 | 10 | yes | — |
| T4 Place a bounty pledge | 6 | 45 | up to final button | Not blocked by the site; I did not press "Pay 5 USDC & send" (public board). Unverified. |
| T5 Create a room, finish setup | 4 | 40 | yes, via /dashboard | The landing's own "Create a room" link (`/dashboard?new=1`) creates the room then resets to a blank form. |
| T6 Default settings x3 entry points | 12 | 90 | no (all three) | Privy sign-in modal at every entry. |
| T7 Change a setting, confirm it stuck | 6 | 60 | yes | Confirmed on the viewer page only; reloading the dashboard loses the room. |
| T8 Delete a room, create a new one | 7 | 60 | create only | No delete control exists (UI or API). |
| T9 End a stream, start a new one | 7 | 60 | no from /demo | /demo has no streamer controls or dashboard link; nearest equivalent is the "Accepting joins" switch on a room you own. |
| T10 Add the room to OBS | 5 | 45 | yes | — (overlay URL + copy + one-click "Add to OBS") |
| T11 Payment: USDC, per-second, onramp | 3 | 60 | 2 of 3 | Onramp is explained nowhere; "Fund wallet" opens the sign-in modal. |
| T12 Account page, sign out | 1 (observed) / 2 (per source) | 10 | no | Privy sign-in modal; /app has no link to /account when signed out. |

## T1 — Learn what MegaChat is and how it works, with zero context (start `/?stay=1`)

Ideal clicks: 1. Target: 45 s.

1. Read the hero: "SKIP THE CHAT. BE THE STREAM. Camera seats on live broadcasts, billed by the second." Scroll: "HOW A SEAT WORKS" (01 Pick a live room / 02 Take a seat / 03 Leave whenever) and four cards (SEATS, THE METER, BOUNTIES, NO WALL). Zero clicks gets the pitch. (`00-recon-01-_stay_1.png`)
2. Click "How it works" in the nav (or "Full walkthrough + FAQ →" under the 3 steps) → `/how-it-works`: viewer steps 01–06, streamer steps 01–06, "The clock", "Under the hood", 7-question FAQ. (`00-recon-11-_how_it_works.png`, `11-how-it-works-faq-open.png`)

Alternative: "Watch the film" (hero video, 0 navigations). Not blocked.

## T2 — Send a MegaChat to a streamer: record, pay, send (start `/?stay=1`)

Ideal clicks: 6 (+ sign-in + pay, unobserved). Target: 40 s.

1. Scroll to "ON THE BOARD" and click the "MegaChat Demo — try everything for pennies" row → `/demo` (0.01 USDC.e per MegaChat). (`00-recon-05-_demo.png`)
2. Type a Display name (required: pressing Send without one shows "Pick a username first — it labels your MegaChat on stream." `14-demo-send-click.png`).
3. Click "📼 Send a MegaChat — 0.01 USDC.e" → recorder unfolds inline with a live cam preview, "⏺ Record", "Cancel", "3–10s. Flat price 0.01 USDC.e". (`03-demo-send-megachat-click.png`)
4. Click "⏺ Record" (browser camera prompt) → button becomes "⏹ Stop (9s)" countdown. (`12-demo-recording.png`)
5. Click "⏹ Stop" → "↺ Re-record / 📮 Send / Cancel", "6s take — happy with it? Send for 0.01 USDC.e." (`13-demo-recorded.png`)
6. Click "📮 Send" → **DEAD END: Privy "Log in or sign up" modal** (email, Google, Twitter, Twitch, passkey). The pay step (embedded wallet, USDC.e on Tempo) and the actual send were not observable. (`22-demo-send-with-username.png`)

Same flow on a FREE room needs no account and completes: on `/jordandotfun` ("📼 Send a MegaChat — FREE", `07-`, `15-`, `16-`) and, sent for real on my own test room `/join?room=3dc58fd1`: "✅ Review passed — your MegaChat is queued. The stream overlay isn't online yet; it plays the moment it connects." (`30-`, `31-`, `32-uxbench-after-send.png`; POST `/api/letter/submit` 200, PUT `/api/letter/upload/...` 200). So record → send is proven; paying is the gate.

## T3 — Check a streamer's bounty, guaranteed vs contested (start `/?stay=1`)

Ideal clicks: 1. Target: 10 s.

1. Scroll to "HELD FOR STREAMERS" and click "01 threadguy TWITCH 200.00 USDC 2 backers" → `/bounty/s/twitch/threadguy`: "GUARANTEED TO THREADGUY 100 USDC — theirs alone the moment they claim" / "CONTESTED 100 USDC — offered to threadguy AND 4 others — first to claim takes it" / "BACKERS 2". (`00-recon-12-_bounty_s_twitch_threadguy.png`)

Also 1 click via "Bounties" in the nav → `/bounty`, where each row already carries the split ("100 USDC +100 contested against 4 others") plus board totals "IN ESCROW 600 USDC real, counted once" / "ACROSS POOLS 1,000 USDC contested money counted per name". (`00-recon-02-_bounty.png`) Note the landing row shows the combined "200.00 USDC" with no hint that half is contested.

## T4 — Place a bounty pledge (start `/bounty`)

Ideal clicks: 6 (+ 1 text field). Target: 45 s.

1. Click "Put money on it" on the threadguy row → `/bounty/s/twitch/threadguy`. (`10-bounty-put-money-click.png`)
2. Click "🎙 Record a MegaChat for threadguy" (a pledge is always a clip + money; there is no money-only pledge) → recorder card with cam preview and "Record". (`08-bounty-record-click.png`)
3. Click "Record" → "REC 1s…" + "Stop". (`17-bounty-recording.png`)
4. Click "Stop" → "Re-record" / "Looks good — set the bounty" / "6s take". (`18-bounty-recorded.png`)
5. Click "Looks good — set the bounty" → form: Bounty amount (USDC, default 5), Refund account (required, "0x… or your MegaChat account"), Offer expires after (3 days / 1 week / 2 weeks / 30 days), optional "Also offer this to…" rivals, the "Before you pay" rules, and "Pay 5 USDC & send". Copy on the form: "No real money moves in this preview build — the escrow is a ledger and payouts are recorded, not sent." (`23-bounty-set-the-bounty.png`)
6. Type a refund account, click "Pay 5 USDC & send".

I stopped at step 6 without pressing the button: it would have posted a test clip and a 5 USDC ledger pledge onto the public board. Per source (`web/components/bounty/record-flow.tsx` `paySubmit`) it requires only a non-empty refund account, no sign-in. Completion therefore unverified, but nothing on the site blocked it.

## T5 — Create a room and finish setup (start `/?stay=1`)

Ideal clicks: 4 (+ 2 text fields). Target: 40 s.

The obvious path fails. The landing's "Create a room" CTA (and `/app`'s "Open a room" tile) link to `/dashboard?new=1`. Filling the form there and clicking "Create room" does create the room (POST `/api/dashboard/create` → 201, id `3dc58fd1`), but the page immediately snaps back to an empty "New room" form: no confirmation, no links, no overlay URL. (`26-dash-create-form-ready.png` → `27-dash-after-create.png`.) Source: `dashboard-shell.tsx` calls `switchRoom()` whenever `?new=1` is in the URL and the mode is `managing`. Signed out there is no way back into that room afterwards: `/dashboard` shows only the create form and the live build has no "room ID + password" unlock UI (the disclosure in `megachat-settings.tsx` is not rendered on the live site).

The path that finishes:

1. Click "How it works" in the nav → `/how-it-works`.
2. Click "Start a room" (bottom CTA) → `/dashboard` (no query). (`00-recon-14-_dashboard.png`)
3. Click "Name your room", type a name. Optional: Paid/Free, the MegaChats / Open mic / Drops toggles, and the six "Advanced settings" tabs (MegaChats, Open mic, Drops, Who gets in, Money, Stream). (`19-dash-name-click.png`, `20-dash-tab-*.png`)
4. Type a Room password (≥ 4 chars; it is "the only way back into your room") and click "Create room" → managing dashboard: "Managing <name>", "Accepting joins" switch, MegaChat Settings, Rewards, Integrations, Share links (Viewer `https://megachat.fun/join?room=<id>`, OBS `https://megachat.fun/overlay?room=<id>`), overlay health, On camera, Co-host booth, MegaChats queue. (`33-managing-top.png`, `34-managing-full.png`)

Notes: the room name is not a slug (`/uxbench-tmp` → 404; the link is `/join?room=<id>` until a display name / claimed handle makes it permanent). "Save this setup as my defaults" on the create form only flips a toggle labelled "Sign in to keep defaults." (`21-dash-save-defaults-click.png`). The managing dashboard wears the older header ("MegaChat / SIMPLE ADV / Log in / Sign up") while the create page wears the new one ("MEGACHAT / Sign in").

## T6 — Set default channel settings from Account, Create Room, and a live room (start `/account`)

Ideal clicks: 12 across the three entries (1 + 4 + 7). Target: 90 s. All three are DEAD ENDS at the Privy modal.

Account (1 click): `/account` is a sign-in wall ("Sign in to see your account … your saved room defaults all live here"). Click "Sign in" → Privy modal. (`00-recon-03-_account.png`, `02-signin-modal-from-account.png`)

Create Room (4 clicks): click the MEGACHAT logo → `/app`; click the "Open a room" tile → `/dashboard?new=1`; click "Save this setup as my defaults" → the toggle flips, subtitle "Sign in to keep defaults.", nothing is stored and no prompt opens; click "Sign in" (header) → Privy modal. (`21-dash-save-defaults-click.png`)

Live room (7 clicks): logo → `/app`; "How it works"; "Start a room" → `/dashboard`; "Name your room" + name + password; "Create room" → managing dashboard; click the "Defaults" section tab → "Default room settings … Sign in (top right) to keep defaults — they follow your account, not this browser."; click "Log in / Sign up" → Privy modal. (`45-managing-defaults-section.png`, `46-managing-login-modal.png`)

## T7 — Change one setting and confirm it stuck (start `/app`)

Ideal clicks: 6 (+ 3 text fields). Target: 60 s. Walkable, with a caveat.

1. Click "How it works" (avoid the "Open a room" tile: it is the `?new=1` trap from T5).
2. Click "Start a room" → `/dashboard`.
3. Click "Name your room", type a name and a password.
4. Click "Create room" → managing dashboard ("Changes save automatically while you stream.").
5. Click "Advanced — fine-tuning (good defaults preset)", change "Longest clip" (`#letters-max`) 10 → 15 and tab out. PUT `/api/dashboard/rooms/<id>` returned 200 within ~1 s. There is no visible "Saved" state; the only feedback is the static autosave sentence. (`40-setting-changed-letters-max-15.png`)
6. Confirm: open the Viewer link from the Share links card in a new tab → the join card reads "per MegaChat · up to 15s · recorded, plays once". Stuck. (`41-confirm-on-join-page.png`)

Caveat: reloading the dashboard to re-check drops you on a blank create form (the password lives only in memory), so the setting cannot be re-read from the dashboard itself. (`42-dashboard-after-reload.png`) Account-level settings are sign-in gated (T6).

## T8 — Delete a room, then create a new one (start `/app`)

Ideal clicks: 7. Target: 60 s. Delete is a DEAD END; create works.

1–4. As T7 steps 1–4 to reach the managing dashboard of a room you own.
5. There is no delete/close/remove/archive control anywhere on the managing dashboard (scanned every button, link, summary and label), and `dashboard-routes.js` exposes only unlock / create / rooms / start / stop / kick / pin. The nearest control is "Start new room", which abandons the current room and returns to an empty create form; the room stays on the server (un-owned rooms are pruned at the next server boot). (`47-start-new-room-clicked.png`)
6. Click "Name your room", type a name and password.
7. Click "Create room" → a fresh managing dashboard.

## T9 — End a stream, start a new one (start `/demo`)

Ideal clicks: 7. Target: 60 s. DEAD END from `/demo`; nearest equivalent verified on a self-created room only.

`/demo` is the viewer join page (Display name, sign-in, Fund wallet, Send a MegaChat, Join Stream, stinger picker). It has no streamer control and no link to the dashboard (header: logo → `/app`, "Sign in"). Managing the demo room needs its password (unknown) or ownership, and the live build has no unlock UI anyway. "Join Stream" on `/demo` only shows "Heads up: this streamer's overlay isn't open right now…" (`05-demo-join-stream-click.png`).

What exists for a room you own (logo → `/app` (1), "How it works" (2), "Start a room" (3), name (4), "Create room" (5)):

6. Click the "Accepting joins" switch → it becomes "Paused" (POST `/api/dashboard/rooms/<id>/stop`); the viewer page now says "This room is not accepting new joins right now." (`43-accepting-joins-off.png`, `43b-join-page-while-paused.png`)
7. Click it again → "Accepting joins" (POST `/start`). (`44-accepting-joins-on.png`)

There is no other "stream" state: the overlay is a browser source you open in OBS, and the co-host booth is armed/disarmed. "Start new room" (T8) starts a new room, not a new stream.

## T10 — Add the room to OBS (start `/app`)

Ideal clicks: 5. Target: 45 s. Walkable.

1–4. As T7 steps 1–4 (`/app` → "How it works" → "Start a room" → name + password → "Create room").
5. On the managing dashboard, "Share links" card: "OBS https://megachat.fun/overlay?room=<id>" with a "Copy OBS link" button. (`36-share-links-card.png`, `39-copy-obs-link-clicked.png`) The same card has a one-click: expand "Add it to OBS for me — or just copy the link above" → "Connect OBS (one time)" instructions (Tools → WebSocket Server Settings), an "OBS WebSocket password" field, "Test connection", "Add to OBS" ("creates the overlay as a browser source sized exactly to your canvas"), a monitoring checkbox, and a "Manual setup (works everywhere)" block with the URL and a "Copy" button. (`37-obs-one-click-open.png`) "OBS setup guide" expands five numbered steps. (`38-obs-setup-guide-open.png`)

Also documented on `/how-it-works` (streamer step 03, "Drop the overlay into OBS"). The one-click itself needs a local OBS and was not exercised.

## T11 — Find how payment works: USDC, per-second, onramp (start `/?stay=1`)

Ideal clicks: 3. Target: 60 s. USDC and per-second: found. Onramp: DEAD END.

0. Landing already says "billed by the second", "THE METER — Streamers set a per-second rate. It runs while your camera is live and stops the instant you leave. No subscriptions, no minimums.", "Bounties settle in USDC", and every room row shows "0.001 USDC.e / 1s".
1. Click "How it works" → "Under the hood: The rails it runs on": one-tap embedded wallet on Tempo; "True per-second settlement" via TIP-1034 payment channels ("one on-chain escrow, then signed off-chain vouchers every second"); "Unused money is your money"; MetaMask as a secondary path; stat strip "Per-second USDC settlement / One tap / 0 risk / On-chain Tempo network".
2. Expand FAQ "Do I need a crypto wallet?" ("No… passkey spins up a smart account… MetaMask optional") and "How much does it cost to be on stream?" ("default 0.001 USDC per second, capped at 2 USDC per session"). (`11-how-it-works-faq-open.png`)
3. Onramp: nothing on the site explains getting money in. The join pages have "💧 Fund wallet", which opens the Privy sign-in modal (`04-demo-fund-wallet-click.png`). FAQ "Is this real money?" still says "MegaChat currently runs on Arc Testnet USDC. Grab free test USDC at faucet.circle.com" while the join pages and config say Tempo / USDC.e. `/roadmap` lists "Card top-ups, flipped on" under AMBITIOUS, i.e. not shipped. (`00-recon-16-_roadmap.png`)

## T12 — Find the account page and sign out (start `/app`)

Ideal clicks: 1 observed (to the wall); 2 per source when signed in. Target: 10 s. DEAD END.

Signed out, `/app`'s header offers only "Sign in" → Privy modal (`01-signin-modal-from-app.png`); there is no link to `/account` anywhere on `/app`, the landing, or the footer. `/account` exists only by URL and is itself a sign-in wall (`00-recon-03-_account.png`). Sign out requires a session, so it cannot be reached.

Per source, not observed: signed in, the header becomes a chip "<handle> ▼" whose menu lists "Your room link", "Balance", "Account" (→ `/account`), "Your room", "Open a new room", "Sign out" (`web/components/account-chip.tsx`); `/account` has a "Session" section with a "Sign out" button ("Signs out of both halves — the site cookie and the wallet session", `web/components/account/account-page.tsx`). So the signed-in ideal is chip → "Sign out" (2 clicks), or chip → "Account" → "Sign out" (3).

## Cross-cutting findings from the walk

- `/dashboard?new=1` (the landing's "Create a room", `/app`'s "Open a room", the chip's "Open a new room") creates the room and then discards the managing view. Anyone arriving from the main CTA loses their room with no feedback.
- Signed-out streamers have no way back into a password room on the live build: no unlock form on `/dashboard`, and the create page reloads blank. The password field's own copy promises "The only way back into your room".
- No delete/close room anywhere (UI or API).
- Two header skins coexist: create page / join pages / `/app` use "MEGACHAT … Sign in"; managing dashboard, bounty detail, roadmap, 404 use "MegaChat / SIMPLE ADV / Toggle theme / Log in / Sign up".
- Autosave has no visible confirmation.
- FAQ "Is this real money?" says Arc Testnet + Circle faucet; the product runs on Tempo / USDC.e. Onramp is undocumented and "Fund wallet" is just sign-in.
- Landing bounty rows show the combined figure (200.00) with no guaranteed/contested split; the board and detail page do split it.
- The demo room's price copy varies: `/demo` shows "0.001 USDC.e / 1s · cap 0.03 USDC.e" for seats and "0.01 USDC.e" per MegaChat; the landing shows "0.001 USDC.e / 1s".
- Every "Send"/"Join"/"Fund" gate on paid rooms is the same Privy modal; a free room needs nothing and works end to end.
