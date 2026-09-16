# Connecting this repo to GitBook

Everything on the repo side is done: `.gitbook.yaml` at the root points GitBook at `docs/`, `docs/SUMMARY.md` lists every page, assets live in `docs/.gitbook/assets`, and `npm run docs:gitbook-check` is green. Connecting is the owner's action because it needs the GitBook account. It is one integration, then one setting.

## Before you start

```bash
npm run docs:gitbook-check
```

It must print `0 errors`. Then decide **which branch to sync**: `v0-ui-migration` is what production deploys from and is the branch these docs describe, so sync that. (If you ever want a docs-only branch, `npm run docs:summary -- --public-only --out /tmp/SUMMARY.md` is the seed for it — see call option C in `REPORT-DOCS.md`.)

## Steps, in GitBook

1. **Create a space.** GitBook → your organisation → *New space*. Name it (e.g. *MegaChat handbook*). Leave it empty.
2. **Open the space's Git Sync settings.** In the space: *Configure* (the gear / "…" menu) → **Integrations** → **GitHub**, or *Configure* → **Git Sync** depending on the plan's UI. Choose **GitHub**.
3. **Install the GitBook GitHub app** on the account or organisation that owns this repository when prompted, and grant it access to **this repository only**. (GitHub → Settings → Applications afterwards shows what it can see.)
4. **Pick the repository and the branch.** Repository: this one. Branch: `v0-ui-migration`. Root directory: leave blank — `.gitbook.yaml` sets `root: ./docs/` and GitBook reads it.
5. **Choose the first sync direction: GitHub → GitBook.** The repo is the source of truth today. GitBook offers to import from the repo or export the (empty) space to it; import.
6. **Save.** GitBook performs the first sync. Open the space: the landing page is `docs/README.md`, the sidebar is `docs/SUMMARY.md` in order — Concepts, Features, Technical, Verification, Notes, Internal.
7. **Copy the space URL** (or set a custom domain under the space's *Domain* settings once DNS points at it) into `NEXT_PUBLIC_DOCS_URL` in Railway, then trigger a build — Next inlines `NEXT_PUBLIC_*` at build time, so a restart alone does nothing. The app starts rendering *Docs* links only after that build (`web/lib/docs-url.mjs`).
8. **Confirm one deep link.** Open the app's account page, click *Docs*, then try `<space>/features/obs-setup`. If GitBook has given the page a different URL, either set the page's slug in GitBook's editor to match, or add a redirect under `redirects:` in `.gitbook.yaml`. `web/lib/docs-url.mjs` documents the assumption it makes about URLs following file paths.

## What `.gitbook.yaml` is doing

```yaml
root: ./docs/          # the space IS this directory; nothing outside it is a page
structure:
  readme: README.md    # the landing page
  summary: SUMMARY.md  # the sidebar — a page not listed here does not exist to GitBook
redirects: {}          # old path → new path, when a page moves
```

## Two warnings

**GitBook normalises markdown on the first sync.** Bullet characters, indentation and some block syntax are rewritten to GitBook's own flavour and pushed back to the branch as a commit from GitBook. Expect a large diff that changes no meaning. The scripts in `scripts/docs-*.mjs` compare normalised text for exactly this reason. Review that commit once; do not fight it.

**Do not create `README.md` files from the GitBook editor while Git Sync is on.** GitBook treats a group's README as the group page and creating one from the UI collides with the file the repo already has; the result is a sync conflict. Create ordinary pages from the editor freely — under *Notes* is the intended place — and run `npm run docs:summary` afterwards if the sidebar and the file tree disagree.

## Bi-directional sync, and what it means for the scripts

Once connected, an edit in GitBook's editor becomes a commit on `v0-ui-migration`. That is fine: the scripts never delete, reorder or reformat a page they did not author; `docs:summary` merges; `docs:check` treats a page the pass did not write as advisory; `docs/notes/` is never read. The one thing that would break is a hand edit inside a `<!-- source: … -->` region, which the next `npm run docs:sync -- --write` replaces from source — edit the prose around the region instead.

## If something goes wrong

- The space shows nothing after sync → `.gitbook.yaml` root or the branch is wrong; GitBook's Git Sync panel shows the last sync's log.
- A page is missing → it is not in `docs/SUMMARY.md`; run `npm run docs:summary` and push.
- An image is broken → it is not under `docs/.gitbook/assets`; `npm run docs:gitbook-check` names it.
- The app shows no *Docs* link → `NEXT_PUBLIC_DOCS_URL` was set after the build, or not set; rebuild.
