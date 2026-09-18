# Contributing to the docs

The handbook under `docs/` is generated from the repo and kept current by construction. This file says what to touch when work closes, and which commands keep the handbook honest. It is short on purpose; the rules that matter are enforced by scripts, not by memory.

## The three commands

```bash
npm run docs:check           # a claim keyword with no citation nearby fails on a page the handbook authored
npm run docs:sync            # reports pages whose cited source sections changed since the last sync
npm run docs:sync -- --write # refreshes source-embedded regions and snippets, records the new hashes
npm run docs:summary         # merges the docs/ tree into SUMMARY.md (never drops or reorders an entry)
npm run docs:gitbook-check   # SUMMARY, links, assets, the public/internal boundary, the deep-link slugs
npm run docs:verify          # check + sync + gitbook-check, the chain that runs with the gates
```

`docs:verify` is part of the standard verification chain: run it before a merge alongside the gates, exactly as `docs/technical/testing-methodology.md` describes. A red `docs:sync` means the code moved under a page — read the page, fix the prose, then `--write`.

## When work closes, touch these

| If you changed… | Update |
|---|---|
| Behaviour a feature page describes | that page under `docs/features/` (and its `SHIPPED` / `SHIPPED-PARTIAL` tag); run `docs:sync` to see which pages cite the file you edited |
| A contract (`web/lib/api.ts`, the escrow tables, the settlement interface, `PLATFORM_PROFILES`, the airing calls) | nothing by hand — `npm run docs:sync -- --write` refreshes `docs/technical/interfaces.md` from source |
| A store, a file under `DATA_DIR`, or what is deliberately not stored | `docs/technical/data-model.md` |
| A gate, a harness, or a testing rule | `docs/technical/testing-methodology.md` |
| An env var name, a port, a mode, a deploy step | `docs/technical/running-it.md` |
| `OPEN-ISSUES.md` | `docs/internal/outstanding.md` (add or close the row) and, for an assumption, `docs/internal/limitations-register.md` (ids are stable; close a row, do not delete it) |
| `DECISIONS.md` or a run's closeout | a page under `docs/internal/work-history/` and the index there |
| Anything whose status was `UNCLEAR` | change the tag on the page named in `docs/internal/needs-a-status-call.md` and remove the row |
| Any money path | `docs/internal/launch-readiness.md`: the retest checklist row, and the pre-launch state if it changed |
| A page added anywhere under `docs/` | `npm run docs:summary` — SUMMARY.md must list it or GitBook will not show it |
| A page you want the app to deep-link | `web/lib/docs-slugs.json` (checked against SUMMARY by `docs:gitbook-check`) |

Every claim about security, money, identity, data or correctness cites its source in backticks (`server.js`, `rooms-store.js:485`, a commit `6386a2c`). No unqualified absolutes: "secure", "private", "guaranteed", "always", "never", "cannot", "fully", "complete" need a citation within two lines or `<!-- uncited-ok -->`. Every feature page keeps its status tag and its "What this does NOT do" section.

## What the scripts never touch

`docs/notes/` is the owner's free-form space. No script reads or writes it. Pages the handbook pass did not author (the briefs, decisions, design and UI-overhaul records) produce advisory warnings from `docs:check`, never failures, and `docs:summary` preserves their entries verbatim.

## When the app leaves stealth

1. Empty `docs/_snippets/pre-launch.md` (leave the file).
2. `npm run docs:sync -- --write` — every page's `<!-- snippet:pre-launch -->` region empties.
3. Record the retest results in the table on `docs/internal/launch-readiness.md` and rewrite its first paragraph.
4. `npm run docs:verify`, commit.

## GitBook

The repo is the source; GitBook syncs it (`gitbook-docs.yaml` at the root maps the site's one space to `docs/`; `docs/.gitbook.yaml` configures that space; `CONNECTING-GITBOOK.md` explains both). GitBook may rewrite bullet characters and indentation on sync — the scripts tolerate that. It also lets the owner create pages from its editor; those land here as ordinary files, get listed by `docs:summary`, and are treated as not-authored (advisory only). Two things to avoid with Git Sync on: creating `README.md` files from the GitBook UI (conflicts), and editing a source-embedded region by hand (the next `--write` replaces it).
