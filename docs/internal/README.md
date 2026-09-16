# Internal

The owner's half of the handbook: what is shipped versus specced versus an idea, what is outstanding, what each work period did, and where the debt is. Nothing here is written for a stranger, and none of it is meant to be published — `npm run docs:summary --public-only` drops this whole group from the table of contents.

## Pages this pass maintains

| Page | What it holds |
|---|---|
| [Launch readiness](launch-readiness.md) | Deployed, stealth, no users, no real money moved — and the retest checklist that must be green before that changes. |
| [Work history](work-history/README.md) | One page per significant work period, from the decision and issue records and the git log. |
| [Roadmap](roadmap.md) | Every item status-tagged, with dependencies. |
| [Outstanding](outstanding.md) | Every known-broken item, open decision and deferred thing, reconciled against `OPEN-ISSUES.md`. |
| [Limitations register](limitations-register.md) | Every assumption and unverified claim by id: source, mitigation, residual risk, what closes it. |
| [Needs a status call](needs-a-status-call.md) | Everything marked `UNCLEAR`. Each is a decision only the owner can make. |

## The engineering record lives beside this directory

Seven sibling directories under `docs/` predate this handbook and are part of the internal half even though they are not under `internal/`: `briefs/` (owner-facing day summaries), `decisions/` (design decisions), `design/` (copy bank, design references), `legacy/` (the pre-overhaul front-end map), `reference/`, `ui-overhaul/` (audits, principles, tokens), plus four root-level files (`obs-oneclick-checklist.md`, `pass-b-handoff.md`, `platform-feasibility.md`, `run-b-verification.md`). They stay where they are because `OPEN-ISSUES.md`, `AGENTS.md`, `DECISIONS.md` and the pages themselves link to those paths, and this pass does not edit pages it did not write. The table of contents groups them under Internal, `--public-only` drops them, and `docs:gitbook-check` treats a public page that links into them as an error. The list of what counts as internal is one set in `scripts/docs-summary.mjs` (`INTERNAL_DIRS`); moving the record under `internal/` later is a `git mv` plus editing that set.

The two files that matter most are not in `docs/` at all: `OPEN-ISSUES.md` and `DECISIONS.md` at the repo root. The pages here are built from them and cite them; they are not replaced by them.
