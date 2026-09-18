# MegaChat

## Reporting

Lead with the verdict in one sentence, then what is at risk, then the detail. Never
cite a raw number (conflict lines, commits behind, file counts) without saying what it
means in practice. Before reporting a blocker, check what it does NOT affect and say so
in the same breath. Report the one thing that matters before the inventory of things
that do not.

## Standing rules

Each of these was stated by the owner in a run prompt or after a defect, and each cost
something to learn. They are listed here because three consecutive prompts have said
"follow the reporting standard in `CLAUDE.md`" while this file lived only as an
untracked scratch file in a side worktree.

- **Commit ≠ ship.** Railway auto-deploys from `v0-ui-migration`. A change is not live
  until the deployed URL serves it — push, then poll for a marker only the new build
  carries.
- **Never `git add -A`.** Stage files explicitly. It once swept 3,368 files, most of
  them a stale copy of the repo, into a single commit.
- **A browser gate is only as fresh as the last build.** `server.js --prod` serves
  whatever `web/.next` is on disk, so a green reported before a rebuild is a claim
  about the previous tree. Use `assertFreshBuild()` from `_gate-helpers.mjs`.
- **Gates authenticate; they never bypass.** Mint real credentials with
  `mintBountyAuth`. A test-only escape hatch in the auth path is the thing that turns
  out to be reachable in production.
- **Spawn servers through `startGateServer`.** Port precheck, readiness poll, stderr
  kept, identity nonce. A bare spawn plus a fixed sleep has twice reported a product
  failure that was really a slow boot.
- **Prove a test discriminates.** Run the old behaviour alongside the new and show they
  disagree, or the test proves nothing.
- **If a git operation fails on a locked file, stop and report.** OneDrive holds files
  open; do not retry blindly and do not force.
- **If you resolve a merge conflict toward one side by recency, check whether the other
  side held a fix with a matching signature.** Recency is not correctness.
- **Env vars: names only, never values, in anything written down.**
- **Do not resolve anything in `docs/internal/needs-a-status-call.md`.** Those are the
  owner's calls.
- **Bounty settlement is stub-only unless a prompt explicitly permits otherwise.** The
  app's own money moves only through `settlement.js`, against a recorded intent (E38,
  2026-09-18), and Gate H — `_gate-money.mjs`, three tiers plus the legacy bounty scan —
  stays green either way.

## Where the record lives

| File | Contents |
|---|---|
| `OPEN-ISSUES.md` | Stubs, deferrals, known gaps, findings. Append, don't rewrite. |
| `DECISIONS.md` | Judgment calls: what / why / how to undo. |
| `docs/` | The handbook, generated from the repo. `npm run docs:verify` before a merge. |
| `docs/internal/outstanding.md` | Every open item, reconciled against `OPEN-ISSUES.md`. |
| `docs/internal/launch-readiness.md` | The retest checklist that gates public launch. |
| `AGENTS.md` | Conventions for anyone, human or agent, picking the repo up. |
