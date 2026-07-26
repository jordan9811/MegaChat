# Daily briefs

Plain-English end-of-day summaries for the project owner catching up after a
day away. **Not written for engineers.** If a brief needs the reader to know
what a webhook is, it has failed.

Any agent can be asked to write one: *"write today's brief"*.

## Convention

- **One file per working day**, named `YYYY-MM-DD.md`.
- **Plain English, no jargon.** Readable by someone who has never opened the
  code. Name the thing that broke and what it cost, not the module it lived in.
- **Short.** The value is that it stays short. Resist adding detail — the
  detail already lives in `OPEN-ISSUES.md`, `DECISIONS.md`, and the
  `HANDOFF-*.md` files.

### Sections, in order
| Section | Contains |
|---|---|
| **Objectives** | What the day was for. One line each. |
| **What happened** | Outcomes, not activity. No commit logs, no gate counts. |
| **Problems and how we handled them** | Including problems still unresolved — a brief that only lists wins is not a brief. |
| **Outstanding** | Split by who acts: owner vs engineering. |
| **Outlook** | An actual call — **bearish / mid / bullish** — with reasoning, and what would move it. |

### Rules that matter
- **Say what is believed vs what is shown.** "Fixed and verified against a
  local test server" and "verified in production" are different claims and the
  brief must not blur them.
- **Keep bad news in.** A brief the owner can't trust to surface problems is
  worse than none.
- **Owner actions get a time estimate.** "Two minutes" is actionable;
  "configure webhooks" is not.

Where a day's brief was prompted by a specific request worth preserving, keep
it alongside as `YYYY-MM-DD.request.md`.

## Index
- [2026-07-25](2026-07-25.md) — LiveKit cost leak found and fixed; bounty
  mechanic built; Cloud verification still outstanding.
  ([request](2026-07-25.request.md))
