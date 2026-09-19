# The account model

One person is one **account**. An account has its own stable id, a canonical handle, and a list of **links** — the platform logins that reach it. Everything that used to key on a platform login now keys on the account id.

This page describes the schema, what a link stores, where attributes come from and how much each source is trusted, and the classifier's tiers and their thresholds. It is internal because the thresholds are arguable and should be argued with.

## What changed, and why

Before this layer an identity **was** `provider:platformId`: one row per platform login, its own handle registry, and that string carried in the room owner key, the whitelist pin and the sealed cookie. Linking a second platform would have minted a second person. Since the app has zero users this was a code change, not a data migration — but `_migrate-accounts.mjs` exists anyway, reports by default and writes with `--write`, because the shape has to exist before the day somebody needs it.

Two things were already true and are worth stating, because the shape follows from them:

- **Privy is the front door.** A sign-in is a Privy DID, and Privy already reports the socials someone has linked there. Those names arrive **without platform ids**, so they cannot carry attributes and cannot be proven to be this person. They are stored as `platformLogins` and shown on the account page; connecting the same platform through our own OAuth upgrades one into a real link with an id and attributes.
- **Our own Twitch/X OAuth still exists** (`/auth/:provider`) and is what the account page's Connect buttons use. It is the only path that yields a platform id and an access token, which is why it is the only path that can capture attributes.

## The schema

`accounts.json`, under `DATA_DIR`, written by `accounts.js`.

```
accounts: { <accountId>: {
  id, handle, primary, createdAt,
  links: [ { provider, platformId, username, handle, linkedAt, attributes, attributesFetchedAt } ],
  reservedHandles: [],
  platformLogins?: { twitch, x },   // names an aggregator reported; no ids
  roomDefaults?: {}
} }
handles: { <handle>: <accountId> }   // canonical AND reserved
links:   { "<provider>:<platformId>": <accountId> }
```

- **One link per provider per account**, and **one account per platform login**. A login already linked elsewhere is refused (`link_taken`) — never moved, never merged. There is nobody to merge, and a merge flow nobody needs is a security surface nobody reviewed.
- **`primary`** decides which link supplies the display name. It does **not** decide the handle.
- **The canonical handle is the account's own.** Adding a link or switching primary changes the display name only, so the room slug, the `/username` link and the OBS overlay URL stay exactly where they were. Asserted by `_gate-identity-account.mjs` section D.

## The handle is owned by the account, and never auto-freed

The old store released a handle the moment its owner claimed a different one (`identity-store.js:101`, and `OPEN-ISSUES.md`, "A HANDLE IS NOT AN AUTHORIZATION TOKEN"). A name somebody had used — and that a whitelist entry or a room link might still refer to — could then be taken by a stranger.

Now:

- `claimHandle` moves the canonical name and leaves the old one **reserved to the same account**.
- `isHandleFree` treats a reserved name as taken, so nobody else can claim it.
- `releaseHandle` is the only way out, it is an explicit act by that account, and the **current** handle cannot be released.

`_gate-identity-account.mjs` section E proves this and runs the old rule beside it to show the two disagree.

## Attributes, and where they come from

At link time, in the same OAuth round trip, the platform's own profile is read and stored. **Nothing is shown to the person and nothing extra is asked of them** — the constraint that overrides everything here is that an important person connecting one account should experience nothing beyond the round trip they are already in. If the fetch fails the link still succeeds with `attributes: null`; a metrics call never stands between someone and their account (`_gate-identity-account.mjs` section F).

Every attribute has one shape, whatever produced it:

```
{ attribute, value, source, trust, fetchedAt, proof? }
```

`attribute` is a name from `ATTRIBUTES` in `attestation/index.js`. `value` is a number, string or boolean — **never a list of people**. `proof` is opaque and set only by zkTLS sources.

| Source | Trust | What it covers | Status |
|---|---|---|---|
| `x-api` | 100 | followers, following, posts, listed, account age, verified | live — one `GET /2/users/me` per link |
| `twitch-helix` | 100 | account age, broadcaster type, view count, follower total *when the token has the scope* | live — one `GET /helix/users` per link |
| `opacity` | 60 | — | **not integrated**; `attestation/opacity.js` is the whole boundary |
| `reclaim` | 60 | — | **not integrated**; `attestation/reclaim.js` is the whole boundary |
| `manual` | 10 | anything an operator types | shape only |

**Why that ordering.** A platform's own API is the highest authority on its own data: X is definitionally correct about an X follower count, over a channel we opened ourselves. A zkTLS proof is next — it says a real session returned this value, which is strong, but it arrives through a third party and a verifier we did not write. `manual` is last: an operator typing a number is useful for seeding and worthless as evidence. Equal trust is a real tie, and the fresher record wins.

**Cost.** The X API is pay-per-use against prepaid credits — no subscription tier and no free tier (docs.x.com). One profile lookup per link is the entire spend; follower and following **lists** are never read, at any price, because this layer stores no graph.

**Freshness.** `attributesFetchedAt` is stored per link. Refresh is a re-authorisation: the account page's Refresh button sends the person through that platform's sign-in once more, which an app they have already authorised does not question. No access token is stored, so there is nothing to refresh with in the background — and no background polling exists.

### The two zkTLS adapters

Both are stubs returning `not-configured`, and each file marks the exact SDK boundary. What was actually true when they were written (2026-09-19) contradicts the assumption they were specced against:

- **Reclaim** publishes SDKs for a NodeJS webapp, **Flutter, React Native, Kotlin and Swift** — mobile *and* web. Its documentation was reachable.
- **Opacity** ships native/mobile-first wrappers around a Rust core — `opacity-ios`, `opacity-android`, `react-native-opacity`, `flutter-opacity-core`, `capacitor-opacity` — with no first-party browser-JS SDK among them. Its documentation site was returning a Cloudflare DNS error, so its integration contract could not be read from the source of truth.

So "Opacity is the mobile one and Reclaim is the web one" is wrong: **both cover mobile**, Reclaim additionally covers web, and Reclaim is the only one of the two whose docs could be read.

## The classifier

`classify(account, { allowlist, now })` in `classifier.js` is **pure**: no disk, no network, no clock of its own. It returns `{ tier, reasons[] }`, and **no feature consumes it** — it is built, tested against fixtures spanning every tier, and shown to the account holder on their own account page. Nothing else reads it.

| Tier | Meaning | Friction a later feature may add |
|---|---|---|
| `recognized` | on the seeded allowlist, or past a bar a bought account does not clear | never |
| `plausible` | looks like a real person | never |
| `ambiguous` | cannot tell | **the only tier where more may be asked** |
| `suspect` | carries the mass-follow signature | may be refused |
| `unknown` | no attributes were ever fetched | — |

**The thresholds, and why they are these numbers.** Every one is a judgement call with no user data behind it, set where a false `recognized` is cheap and a false `suspect` is expensive. When a signal is missing the answer is `ambiguous`, never `suspect`: absence of evidence is not evidence of a bot.

| Rule | Tier | Reasoning |
|---|---|---|
| on the allowlist | `recognized` | checked first, unconditionally |
| `verified` **and** ≥ 100,000 followers | `recognized` | an X checkmark is purchasable, so `verified` alone means "pays for X". 100,000 followers is not purchasable in the same sense, and the pair is a combination a bought checkmark does not confer |
| Twitch `partner` | `recognized` | an application Twitch reviews; there is no way to buy it |
| ≥ 730 days old | `plausible` | two years of continuous existence is itself evidence, and it rescues the real person with nine followers |
| ≥ 180 days old **and** ≥ 50 followers | `plausible` | follow-farms are churned faster than six months and rarely accumulate genuine followers; 50 is low enough to include a lurker who only knows their own friends |
| Twitch `affiliate` | `plausible` | reviewed, but a much lower bar than partner |
| `verified` | `plausible` | costs real money even when it proves nothing else |
| following ≥ 1,000 **and** < 30 days old | `suspect` | the mass-follow farm: brand new, following everyone, followed by nobody |
| following ≥ 500 **and** followers/following < 0.02 | `suspect` | the same signature without the age tell — following 500 and followed by under 10 |

`THRESHOLDS` is exported so the numbers can be read and argued with rather than hunted for.

**The seeded allowlist** is `recognized-accounts.json` at the repo root, empty by default, holding **platform ids** — never handles, because handles change hands and ids do not. A copy in `DATA_DIR` overrides it, so production can be edited without a deploy. The classifier checks it first and returns `recognized` with zero friction, forever.

## What this layer deliberately does not store

No follower lists, no following lists, no mutuals, no graph data of any kind. Counts only. See the data-model page's "deliberately absent" list.

## Where it is

| | |
|---|---|
| Store | `accounts.js` → `accounts.json` |
| Legacy shape | `identity-store.js` — the old identity view over the new store; every caller reads unchanged |
| Owner key | `roomOwnerKey()` in `auth.js` — now the account id |
| Linking | `/auth/:provider` and its callback; `GET /api/account`, `POST /api/account/primary`, `DELETE /api/account/links/:provider` |
| Attributes | `attestation/` — `index.js` (shape, trust, adapters), `x-api.js`, `twitch-helix.js`, `opacity.js`, `reclaim.js` |
| Classifier | `classifier.js`, `recognized-accounts.json` |
| Migration | `_migrate-accounts.mjs` — reports by default, `--write` to act |
| Gate | `_gate-identity-account.mjs` — 46 assertions against a mock IdP through the real OAuth routes |
