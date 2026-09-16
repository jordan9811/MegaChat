# Design docs

Working design references for the front-end overhaul (`feat/ui-overhaul`).

| Doc | What it is | Live link |
|---|---|---|
| [`room-control-panel.html`](room-control-panel.html) | Every streamer-editable room parameter, an audit of why the current create-room page fails, and the proposed create/manage split. Built from a browser audit of the running dashboard plus a source trace through `rooms-store.js`, `dashboard-routes.js`, `letters.js`, `rewards.js`. | [Artifact](https://claude.ai/code/artifact/4cd4298e-45c9-415a-bdc5-45656d02dbe2) |

Open the HTML files directly in a browser — they are self-contained, no build step.

## Related

- **Landing / app direction canvas** — the Round 1 → Round 2 design decision record
  (landing directions, the picked Landing V1, and Booth as the app page):
  https://claude.ai/code/artifact/33a1b197-8bdb-4bcc-8e59-d5aed118f3c6
- **Create-room mocks** — three interactive directions (Stack, Ribbon, Split preview):
  https://claude.ai/code/artifact/70b4e2d6-296b-42a1-8389-2668f2c8e0b0
- **Design rules** — [`../../DESIGN.md`](../../DESIGN.md) (lifecycle gating, spacing,
  uppercase budget, glow budget). Still authoritative for behavior; its neon-noir
  visual language was retired in the overhaul.
- **Backlog** — [`../../OPEN-ISSUES.md`](../../OPEN-ISSUES.md), including the bounty
  price-floor spec.
