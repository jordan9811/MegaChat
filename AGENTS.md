# Agent notes — MegaChat

Pointers for anyone (human or agent) picking this repo up.

## Daily briefs — `docs/briefs/`
Plain-English end-of-day summaries **for the project owner**, one per working
day (`YYYY-MM-DD.md`). Written for someone who has not looked at the code.

**You can be asked to write one** — *"write today's brief"*. Follow the
convention in [`docs/briefs/README.md`](docs/briefs/README.md): Objectives,
What happened, Problems and how we handled them, Outstanding, Outlook
(bearish / mid / bullish, with reasoning).

Two rules that matter most: keep it **short**, and never blur *believed to
work* with *shown to work*.

## Where the real detail lives
| File | Contents |
|---|---|
| `OPEN-ISSUES.md` | Stubs, deferrals, known gaps. Append, don't rewrite. |
| `DECISIONS.md` | Judgment calls: what / why / how to undo. |
| `HANDOFF-LAZY-CONNECT.md` | LiveKit cost-control work + the Cloud validation runbook. |
| `HANDOFF-BOUNTY.md` | Creator bounty: what's real, what's stubbed, design critique. |
| `LIVEKIT-AUDIT.md` | The original connection-leak investigation. |
| `docs/briefs/` | Owner-facing daily summaries. |

## Conventions worth knowing
- **Gates over claims.** Behaviour is proven by a `_gate-*.mjs` script that
  runs against real infrastructure, not asserted in a commit message. If you
  change behaviour, extend the gate.
- **Flags default to the safe side.** `LAZY_CONNECT` defaults ON (it fixes a
  live cost bug); `BOUNTY_CLAIM` defaults OFF (money-adjacent, mainnet app).
- **Never strip `.env` keys** — it holds the only copy of live secrets.
  Append-only; verify via the boot log.
- **Commit ≠ ship.** Railway auto-deploys from `v0-ui-migration`; a change
  isn't live until the deployed URL says so.
