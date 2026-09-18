# Connecting this repo to GitBook

Everything on the repo side is done. Connecting is the owner's action because it needs the GitBook account.

This is **site-level** Git Sync — GitBook's current model, where one site syncs one repository and maps each of its spaces to a directory. An earlier version of this file described **space-level** sync, where a single space synced the repo and `.gitbook.yaml` at the repo root was the only config. That setup fails on a site with `gitbook-docs.yaml does not exist on this branch`, which is what prompted the rewrite (2026-09-18).

## The two config files, and which one does what

| File | Scope | Lives in | Sets |
|---|---|---|---|
| `gitbook-docs.yaml` | the **site** | the Git Sync **project directory** — `./`, so the repo root | the site title, and which directory each space maps to |
| `docs/.gitbook.yaml` | the **`docs` space** | that space's **mapped directory** | content root, landing page, sidebar, redirects |

The distinction that bites: **paths inside `docs/.gitbook.yaml` resolve from the mapped directory, not the repo root.** That is why its `root` is `./` and not `./docs/` — the file already sits in `docs/`, so `./docs/` would mean `docs/docs/` and the space would sync empty. Every key in it is GitBook's default; it is kept only because `redirects` has nowhere else to live.

`npm run docs:gitbook-check` validates both files and fails on each of those mistakes by name.

## Before you start

```bash
npm run docs:gitbook-check
```

It must print `0 errors`. Then decide **which branch to sync**: `v0-ui-migration` is what production deploys from and is the branch these docs describe, so sync that. (If you ever want a docs-only branch, `npm run docs:summary -- --public-only --out /tmp/SUMMARY.md` is the seed for it — see call option C in `REPORT-DOCS.md`.)

## Steps, in GitBook

1. **Create a site**, or open the existing one. Git Sync is configured on the **site**, not on a space.
2. **Open Git Sync** from the site's sidebar.
3. **Connect the GitHub account** that can see this repository, installing the GitBook GitHub app on the account or organisation that owns it and granting access to **this repository only**. (If GitBook reports *potential duplicated accounts*, your GitHub account is already linked to another GitBook user — GitBook's troubleshooting page covers it.)
4. **Select the repository and branch.** Repository: this one. Branch: `v0-ui-migration`. If the branch list is empty, the GitHub app is installed in the wrong scope or lacks access to this repo.
5. **Choose the initial sync direction: GitHub → GitBook.** The repo is the source of truth. *This replaces the site's content with the repository's*, so confirm the repo, branch and direction before starting.
6. **Leave the project directory blank** (`./`). `gitbook-docs.yaml` is at the repo root, which is where GitBook looks when no project directory is set. Setting one here means GitBook looks for `gitbook-docs.yaml` inside it and the sync fails — that is the exact error this rewrite fixed.
7. **Check the content mapping.** `gitbook-docs.yaml` already declares one space, key `docs`, mapped to `./docs`. The panel should show that mapping rather than ask you to build it. If GitBook instead writes its own entry — a generated key like `space-1` — let it commit, then run `npm run docs:gitbook-check`: it fails on a changed key, and the fix is to decide which key is real before anyone links to a page (see the warning below).
8. **Sync.** The landing page is `docs/README.md` and the sidebar is `docs/SUMMARY.md` in order — Concepts, Features, Technical, Verification, Notes, Internal.
9. **Set `NEXT_PUBLIC_DOCS_URL`.** Open any page in the synced space, copy its URL, strip the page's own path, and put what remains in Railway — that is the base the app appends page paths to, so it is correct whether the space serves at the site root or under `/docs`. Then **trigger a build**: Next inlines `NEXT_PUBLIC_*` at build time, so a restart alone does nothing. The app renders *Docs* links only after that build (`web/lib/docs-url.mjs`).
10. **Confirm one deep link.** Open the app's account page, click *Docs*, then try the *OBS setup* link. If GitBook has given that page a different URL, either set the page's slug in GitBook's editor to match, or add a redirect under `redirects:` in `docs/.gitbook.yaml`. `web/lib/docs-url.mjs` documents the assumption it makes: page URLs follow file paths.

## Three warnings

**A space's `key` is permanent.** GitBook matches an entry in `gitbook-docs.yaml` to an existing space by key — never by title, path or directory. Changing `docs` to something else does not rename the space: it creates a **new** space with a new space ID, imports the content into it, and leaves the old one in the organisation, detached from the site. Every link and API call using the old ID stops resolving, and putting the old key back makes a third space rather than undoing it. Rename with `title`, re-path with `path`, move with `content.directory`; never touch the key. `docs:gitbook-check` asserts it is still `docs` for exactly this reason.

**GitBook normalises markdown on the first sync.** Bullet characters, indentation and some block syntax are rewritten to GitBook's own flavour and pushed back to the branch as a commit from GitBook. Expect a large diff that changes no meaning. The scripts in `scripts/docs-*.mjs` compare normalised text for exactly this reason. Review that commit once; do not fight it.

**Do not create or edit `README.md` files from the GitBook editor while Git Sync is on.** GitBook's own guidance is to manage them in the repository: editing them in the app creates conflicts or duplicate pages. Create ordinary pages from the editor freely — under *Notes* is the intended place — and run `npm run docs:summary` afterwards if the sidebar and the file tree disagree.

## Bi-directional sync, and what it means for the scripts

Once connected, an edit in GitBook's editor becomes a commit on `v0-ui-migration`. That is fine: the scripts never delete, reorder or reformat a page they did not author; `docs:summary` merges; `docs:check` treats a page the pass did not write as advisory; `docs/notes/` is never read. The one thing that would break is a hand edit inside a `<!-- source: … -->` region, which the next `npm run docs:sync -- --write` replaces from source — edit the prose around the region instead.

GitBook also writes to `gitbook-docs.yaml` when the content mapping changes in the app. Treat a commit from GitBook that touches it as a change to review, not noise: it is the one file where an app-side edit can detach a space.

## If something goes wrong

- **`gitbook-docs.yaml does not exist on this branch`** → the file is missing at the project directory, or a project directory is set that does not contain it. Leave the project directory blank; the file is at the repo root.
- The space shows nothing after sync → `content.directory` in `gitbook-docs.yaml`, or `root` in `docs/.gitbook.yaml`, is wrong; `root: ./docs/` is the classic one, because it resolves to `docs/docs/`. `npm run docs:gitbook-check` catches both.
- A page is missing → it is not in `docs/SUMMARY.md`; run `npm run docs:summary` and push.
- An image is broken → it is not under `docs/.gitbook/assets`. Each space syncs only its own directory, so assets must live inside `docs/`; `npm run docs:gitbook-check` names any that do not.
- The app shows no *Docs* link → `NEXT_PUBLIC_DOCS_URL` was set after the build, or not set; rebuild.
