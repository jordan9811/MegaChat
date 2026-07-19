# UX REPORT — audit repair, 2026-07-19

Baseline: tag `pre-audit`. Audit: `UX_AUDIT.md` (committed separately).
Every fix landed as its own commit and is individually revertable.
Re-walk performed on the fixed build with the same instrumented walker
(screenshots + button inventories, real join→live→leave cycle on a free room).

## Click map — AFTER

Landing → LIVE on camera (free room):
`Browse rooms(1) → room card(2) → [type name] → Join Stream(3) → Go Live(4)`
= **4 clicks + one text field — unchanged (≤ before ✓)**. The map was already
tight; this pass removed *cognitive* friction (contradictions, dead buttons,
wrong-tier controls), not steps. Leaving went from 1 click to 1 click, but the
control is now findable (it IS the live button) instead of a ghost below a
dead one.

## Before → after, per fix (commit per line)

| Fix | Before | After |
|---|---|---|
| `fix: join/leave single-state button…` (P0-1/2, P1-1/2) | Live = disabled "YOU'RE LIVE" mega-button + separate ghost Leave; camera wait = disabled dead-end; stale "hit GO LIVE" message while live; sign-in cluster + editable username mid-session | ONE morphing control: Join → cancel-able wait → Go Live → "LIVE — tap to leave" (enabled). Sibling Leave deleted. Message clears on live (one status + one control). Setup UI collapses during a session; name locks; all restored on leave |
| `fix: free rooms render zero payment surfaces` (P0-3) | "No wallet needed" headline above two sign-in buttons, a "sign in to get started" line, Add funds, and balance copy | Free room shows: FREE badge, name field, MegaChat, Join Stream, Advanced. Nothing else. Paid rooms untouched |
| `fix: one sign-in button, secondary weight` (P0-4) | Two full-width primary-weight buttons opening the SAME Privy modal | One secondary-weight "Sign in — Google, email or passkey"; the page's only loud controls are the two product CTAs |
| `fix: dashboard hierarchy…` (P1-3/4/5) | Host camera (real control, big primary) rendered BELOW a coming-soon stub styled as a button; "Prefilled from your sign-in" hint over an empty field; "Room X is live" while merely open | Host cam beside the live tables; stub is a plain status row, last; managing hint tells the truth and points at the single Claim affordance; "is accepting joins" |

(One extra commit repairs a build break my own P0-4 patch caused — the branch
was red for exactly one commit, then green; noted for honesty.)

## Verification

- Headless state-machine walk on the fixed build: join → session-collapse →
  Go Live → tap-to-leave → restore, 8/0 assertions (incl. message-visibility,
  not just innerText).
- Full re-walk captured all 14 screens again; free-room idle screen now
  contains zero payment surfaces; managing dashboard shows the new card order.

## Deferred (P2, listed in UX_AUDIT.md)

- Landing's duplicate nav (hero strip + footer) — far apart on a long page;
  low harm, defer.
- MegaChat CTA keeps hero weight while live — arguable; sending a clip while
  on camera is legal, demoting it mid-session adds state complexity for
  polish-grade gain.
- Demo room's banner + FREE + price stack; autosave tick; ever-present Retry
  camera ghost.

## Left alone deliberately

- **Two loud CTAs (MegaChat hero + Join Stream dopamine)** — violates
  one-primary on paper; it is the product's stated identity. Everything else
  was demoted around them instead.
- **The Go Live consent click** — merging it would auto-broadcast a camera;
  the click is the user pulling their own trigger.
- **Header Log in / Sign up + in-card sign-in coexisting** — app-wide identity
  vs payment-path surfaces; in-card version demoted to secondary instead of
  removed.
