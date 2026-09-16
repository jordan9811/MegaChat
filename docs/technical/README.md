# Technical

For someone who would contribute to, integrate with, or audit MegaChat.

The system is one Node process: an Express server (`server.js`) that owns every HTTP route, the WebSocket seat lifecycle and the payment meters, and mounts a Next.js app (`web/`) as its fall-through handler for pages. State is JSON files under `DATA_DIR`. There is no database server, no queue, and no second service — the only external systems are a LiveKit SFU for media, the payment chain, and the streaming platforms' public APIs. Source: `server.js` (the `createNextApp({ dev: nextDev, dir: NEXT_DIR })` mount near the end of the file), `rooms-store.js`, `airings-store.js`.

Pages in this section:

- **Architecture** — the layers, the seams between them, what runs where.
- **Interfaces** — the contracts, embedded from source by `scripts/docs-sync.mjs` so they do not drift.
- **Data model** — every store, and the list of what is deliberately not stored.
- **Key flows** — a paid seat join, a bounty from pledge to release, a whitelisted guest, OBS one-click.
- **Testing methodology** — the gate scripts, what they proved, and why they exist.
- **Running it** — setup, environment variable names, ports, modes, and the OneDrive hazard.
