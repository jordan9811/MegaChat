# UX AUDIT — 2026-07-18 (baseline tag: `pre-audit`)

Method: full prod build walked headless as a first-time user — landing, docs,
roadmap, join (Simple+Advanced × light+dark), sign-in states, a REAL
join→camera→live→leave cycle on a free room, MegaChat surface, dashboard
(signed-out / signed-in / managing an owned room), overlay, demo. Screenshots +
per-screen button inventories captured (filled-vs-ghost classified from
computed styles). Principles applied: (1) one primary per screen, (2) state
morphing not button pairs, (3) click budget, (4) progressive disclosure,
(5) redundancy, (6) state feedback.

## Click map (BEFORE)

Landing → LIVE on camera, free room:
`Browse rooms(1) → room card(2) → [type name] → Join Stream(3) → camera
auto-detect → Go Live(4)` = **4 clicks + one text field**. Paid adds one
sign-in click + the Privy modal + funding (external, unavoidable).
The camera→Go Live consent click is DELIBERATE ("you pull the trigger") and
stays.

---

## P0 — breaks comprehension or flow

### P0-1 · Join page, LIVE state: dead button + button pair (principles 2, 6)
When live, the giant dopamine button renders **disabled** as `🔴 YOU'RE LIVE`
while a separate ghost `Leave stream` sits under it. A non-actionable control
styled as the page's loudest button, next to its opposite — the exact
anti-pattern. Same family: during `awaiting-camera` the button is disabled
with no escape hatch — if the camera hangs, the flow DEAD-ENDS (no cancel).
**Fix:** one state-morphing control: idle `Join Stream` → busy → awaiting
`Waiting for camera — tap to cancel` (enabled) → `Go Live` → live
`🔴 LIVE — tap to leave` (enabled). Delete the sibling Leave button.

### P0-2 · Join page, LIVE state: three live-badges + a stale instruction (6)
While live, the page shows `YOU'RE LIVE ON STREAM` pill + `🔴 YOU'RE LIVE`
button + the bottom message still reading “Allow camera access above, then hit
GO LIVE” — an instruction for a state that already passed, contradicting the
two badges above it. **Fix:** clear the message on entering live; keep exactly
one status surface (the pill) + one control (the button).

### P0-3 · FREE room contradicts itself (4, 5, 6)
Price block says “this room is free — hop on camera, **no wallet needed**”,
and directly below it: two wallet sign-in buttons, the line “Sign in with
email or passkey above **to get started**”, an `➕ Add funds` button, and (once
live) “Unspent balance stays in your wallet” copy. Four payment surfaces in a
room with no payments. **Fix:** free room → the wallet cluster, fund button
and balance copy don't render. Identity lives in the header pill.

### P0-4 · Join page: two primary-weight buttons that do the SAME thing (1, 5)
`✨ Google, email or passkey` and `🔐 Sign in` are both full-width,
primary-weight, and **both open the same Privy modal** (sign-up vs sign-in is
resolved inside it). Inventory for the paid join page counts THREE
primary-weight controls before the CTAs. **Fix:** one secondary-weight sign-in
button; MegaChat (hero) and Join Stream (dopamine) stay the only loud things.

## P1 — friction

### P1-1 · Wallet/identity cluster persists during a session (4)
Once seated/live (paid or free), the sign-in buttons, fund row and wallet info
stay fully visible — setup controls rendered mid-session. **Fix:** collapse
the cluster while a seat is held; restore on leave.

### P1-2 · Username stays editable while live (6)
Editing it does nothing once seated — an input that lies. **Fix:** readonly +
dimmed during a session.

### P1-3 · Dashboard managing: card order buries the streamer's camera (1, 4)
`Host camera` (with the page's second big primary, GO ON AIR) renders BELOW
`Integrations` — a **coming-soon stub** styled as a primary-width button.
A stub outranks a real control. **Fix:** Host camera moves up next to
On-camera; Integrations drops to the bottom and its stub stops being
button-shaped.

### P1-4 · Managing: claim affordance duplicated + lying hint (5, 6)
The `Display name` field hint says “Prefilled from your sign-in” while the
field is EMPTY (managing view doesn't prefill), and the links panel below
carries the real `CLAIM /handle` button — two surfaces for one action, one of
them wrong. **Fix:** managing hint describes reality; the claim banner stays
the single affordance.

### P1-5 · “Room \<id\> is live” when it's merely accepting joins (5)
“live” is overloaded (room active ≠ viewers live). **Fix:** “accepting joins”.

## P2 — polish (deferred unless time)

- **P2-1** Landing renders the same nav twice (hero strip + footer).
- **P2-2** MegaChat CTA keeps full hero weight while you're live on camera.
- **P2-3** Demo room stacks banner + FREE/price + MegaChat price (3 price-ish
  surfaces).
- **P2-4** Autosave has no visible confirmation tick (text promise only).
- **P2-5** `Retry camera` ghost is always present inside the camera stage even
  pre-error.

## Deliberate exceptions (left alone, with reasoning)

- **MegaChat hero + Join Stream dopamine both loud** — violates “one primary”
  on paper; explicit product direction (“hero feature” vs “XXL dopamine
  mode”). The two are the page's point. Everything else gets demoted around
  them instead.
- **Camera consent click** (`Go Live` as a separate step) — a real trigger the
  user must own; merging it would auto-broadcast someone's face.
- **Header Log in / Sign up while signed-out on the join page** — duplicate
  of the in-card sign-in path, but the header pill is the app-wide identity
  surface; the in-card one is the payment path. Kept both, in-card demoted
  (P0-4 fix).
