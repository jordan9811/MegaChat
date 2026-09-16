# MegaChat

MegaChat puts a viewer's camera on a streamer's live broadcast, for a price the streamer sets, for as long as the viewer stays. The streamer adds one browser source to OBS; the viewer opens a link, pays per second, and appears in a tile on the stream. When they leave, the tile goes and whatever they did not spend comes back to them. Source: the room config and seat lifecycle in `server.js` (`/api/config`, `/api/join`, `removeParticipant`) and the product description in `web/app/layout.tsx`.

There are two ways to be on the stream:

- **A live seat** — your camera, live, metered per second. (`server.js` `/api/join*`)
- **A MegaChat** — a short recorded clip that plays on the stream once. (`letters.js`)

And one way to get a streamer's attention before they have ever heard of you: a **bounty**, money pooled by fans that a streamer can claim by going live with the MegaChat program on. Bounties exist in the tree as a complete state machine over an append-only ledger; **settlement is a stub and no funds move through it.** Source: `bounty-escrow.js`, `bounty-settlement.js` (`StubSettlement`), and Gate H in `_gate-bounty-claim.mjs`.

{% hint style="warning" %}
**Pre-launch.** MegaChat is deployed but in stealth: there are no users, and every session so far has been a rehearsal or a test gate. Money paths have been verified against fixtures, local infrastructure and a small number of real broadcasts by the project's own operator — not production traffic. Nothing in these pages describes production history. Source: `docs/internal/launch-readiness.md`.
{% endhint %}

## Where to go

| If you want to… | Read |
|---|---|
| Understand the ideas the product is built on | [Concepts](concepts/README.md) |
| See what each feature does, how it works, and what it does **not** do | [Features](features/README.md) |
| Know how a bounty is verified, and what verification cannot prove | [Verification](verification/README.md) — the hard page |
| Run it, contribute, or audit it | [Technical](technical/README.md) |
| Know what is shipped versus specced versus an idea | [Internal](internal/README.md) — the owner's half |

## How these pages are written

Every claim about security, money, identity, data or correctness cites the file (and where useful the line) it comes from. Every feature carries exactly one status tag: `SHIPPED`, `SHIPPED-PARTIAL`, `SPECCED`, `IDEA`, `KNOWN-BROKEN`, `ASSUMPTION` or `UNCLEAR`. Tags are read from the repo, never invented; anything ambiguous is `UNCLEAR` and listed on [Needs a status call](internal/needs-a-status-call.md). The rules and the scripts that enforce them are in `CONTRIBUTING-DOCS.md` at the repo root.

The repo is the truth. These pages never assert more than it does.
