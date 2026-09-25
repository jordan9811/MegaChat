# Interfaces

The contracts a contributor or integrator meets, embedded **from source** by `npm run docs:sync --write` (`scripts/docs-sync.mjs`). Each block below is the current text of the named symbol; the prose around it is the only thing written by hand. If a block and the prose disagree, the block is right and the prose is stale — run `npm run docs:sync` to see which pages have drifted.

## The room, as the client sees it

`Room` is what `/api/dashboard/*` returns and what the create/manage page edits. Server-side it is produced by `resolveRoomConfig()` in `rooms-store.js`, which normalises the stored record against environment defaults on every read.

<!-- source:web/lib/api.ts#Room -->
```typescript
// web/lib/api.ts — Room (lines 99–130), embedded by docs:sync
export type Room = {
  id: string
  name: string
  active: boolean
  unlisted: boolean
  tickSeconds: number
  tickPrice: string
  passkeyTickSeconds: number
  passkeyTickPrice: string
  maxSession: string
  maxSeats: number
  paymentTokenAddress: string
  paymentTokenSymbol: string
  paymentTokenDecimals: number
  /** Streamer payout wallet — session settlements pay here (null = platform). */
  payoutAddress: string | null
  /** Twitch login embedded on the join page as the delayed spectate surface. */
  twitchChannel: string | null
  /** Auto-adopt the owner's linked Twitch account. Default true. */
  twitchAuto: boolean
  letters: LettersConfig
  joinStream: JoinStreamConfig
  rewards: RewardsConfig
  /** Permanent /<handle> room link (null until claimed). */
  handle: string | null
  isDemo?: boolean
  /** Camera transport: vdo.ninja iframes (default) or LiveKit (env-gated). */
  transport: 'vdo' | 'livekit' | string
  /** Overlay stinger SFX master toggle (default on). */
  stingerSounds: boolean
  layout: RoomLayout
}
```
<!-- /source -->

`RoomLayout` is the overlay grid on the room record; `version` is what the overlay compares to decide whether to re-place tiles (`applyLayout`, `public/overlay.html`).

<!-- source:web/lib/api.ts#RoomLayout -->
```typescript
// web/lib/api.ts — RoomLayout (lines 90–97), embedded by docs:sync
export type RoomLayout = {
  version: number
  origin: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  direction: 'down' | 'up' | 'right' | 'left'
  margin: number
  tile: { w: number; h: number; gap: number }
  clip: { follow: boolean; w: number; h: number; origin: RoomLayout['origin']; margin: number }
}
```
<!-- /source -->

## A seat

What `/api/seats` and the dashboard's session view carry per seat. `paymentMode` is the string `tickAllMeters()` switches on (`server.js`); `quality` is the link-quality read the booth shows.

<!-- source:web/lib/api.ts#Seat -->
```typescript
// web/lib/api.ts — Seat (lines 132–147), embedded by docs:sync
export type Seat = {
  id: string
  username: string
  live: boolean
  pinned?: boolean
  paymentMode: string
  remaining: string
  spent: string
  viewerAddress: string | null
  joinedAt: number
  liveAt: number | null
  /** Control-WS currently open for this seat. */
  connected?: boolean
  /** good | unstable (WS blip) | poor (LiveKit link quality); null while queued. */
  quality?: 'good' | 'unstable' | 'poor' | null
}
```
<!-- /source -->

`RoomSession` is the manage page's one read: the room, its seats, whether the followed Twitch channel is verifiably live, and the two links a streamer shares.

<!-- source:web/lib/api.ts#RoomSession -->
```typescript
// web/lib/api.ts — RoomSession (lines 149–158), embedded by docs:sync
export type RoomSession = {
  room: Room
  seats: Seat[]
  /** True only when room.twitchChannel is actually live (server-verified).
   *  Twitch answers for an offline channel with a gray placeholder frame at
   *  HTTP 200, so an <img> can never tell — render the preview only on this. */
  twitchLive: boolean
  joinUrl: string
  overlayUrl: string
}
```
<!-- /source -->

## Recent rooms

`RoomPoster` is a discriminated union on `kind`; the rail draws a photograph for `frame` and a typographic card for `card`, and never infers which (`web/components/booth/recent-rail.tsx`). `RecentAiring` is one row of `/api/rooms/recent`.

<!-- source:web/lib/api.ts#RoomPoster -->
```typescript
// web/lib/api.ts — RoomPoster (lines 60–67), embedded by docs:sync
export type RoomPoster =
  | {
      kind: 'frame'
      at: number
      source: 'capture' | 'twitch-vod' | 'twitch-preview' | 'twitch-vod-thumbnail'
      url: string
    }
  | { kind: 'card'; at: number; source: null; title: string | null; guests: string[]; momentCount: number; durationMs: number | null }
```
<!-- /source -->

<!-- source:web/lib/api.ts#RecentAiring -->
```typescript
// web/lib/api.ts — RecentAiring (lines 69–83), embedded by docs:sync
export type RecentAiring = {
  airingId: string
  roomId: string
  name: string
  handle: string | null
  platform: string
  channel: string | null
  startedAt: number
  endedAt: number
  durationMs: number
  vodUrl: string | null
  captureRef: string | null
  moments: { kind: string; label: string | null; offsetMs: number }[]
  poster: RoomPoster | null
}
```
<!-- /source -->

## The guest list

<!-- source:web/lib/api.ts#GuestEntry -->
```typescript
// web/lib/api.ts — GuestEntry (lines 495–500), embedded by docs:sync
export type GuestEntry = {
  handle: string
  addedAt: string
  lastJoinedAt: string | null
  joinCount: number
}
```
<!-- /source -->

<!-- source:web/lib/api.ts#GuestList -->
```typescript
// web/lib/api.ts — GuestList (lines 503–508), embedded by docs:sync
export type GuestList = {
  enabled: boolean
  explicit: boolean | null
  entries: GuestEntry[]
  max: number
}
```
<!-- /source -->

## The bounty escrow, server-side

The states and the transition table are the whole contract for money movement: a move not in the table throws and writes nothing (`bounty-escrow.js`).

<!-- source:bounty-escrow.js#STATES -->
```javascript
// bounty-escrow.js — STATES (lines 24–38), embedded by docs:sync
export const STATES = [
  'ACCUMULATING',
  'RESERVED',
  'CLAIM_PENDING',
  'CLAIM_VERIFIED',
  'AWAITING_AIRTIME',
  'VERIFYING',
  'PARTIALLY_RELEASED',
  'RELEASED',
  // terminals
  'EXPIRED',
  'REFUNDED',
  'DISPUTED',
  'VOID',
];
```
<!-- /source -->

<!-- source:bounty-escrow.js#ALLOWED_TRANSITIONS -->
```javascript
// bounty-escrow.js — ALLOWED_TRANSITIONS (lines 40–58), embedded by docs:sync
/**
 * The single source of truth for legal movement. Read this table before
 * changing any flow — if a transition isn't listed, it cannot happen.
 */
export const ALLOWED_TRANSITIONS = {
  ACCUMULATING:       ['RESERVED', 'EXPIRED', 'VOID'],
  RESERVED:           ['CLAIM_PENDING', 'EXPIRED', 'VOID'],
  CLAIM_PENDING:      ['CLAIM_VERIFIED', 'RESERVED', 'EXPIRED', 'VOID'],
  CLAIM_VERIFIED:     ['AWAITING_AIRTIME', 'DISPUTED', 'VOID'],
  AWAITING_AIRTIME:   ['VERIFYING', 'EXPIRED', 'DISPUTED', 'VOID'],
  VERIFYING:          ['PARTIALLY_RELEASED', 'AWAITING_AIRTIME', 'DISPUTED', 'VOID'],
  PARTIALLY_RELEASED: ['VERIFYING', 'RELEASED', 'DISPUTED', 'VOID'],
  RELEASED:           ['DISPUTED'],           // only a dispute reopens a release
  // terminals
  EXPIRED:            ['REFUNDED', 'VOID'],
  REFUNDED:           [],
  DISPUTED:           ['VERIFYING', 'REFUNDED', 'VOID'],
  VOID:               [],
};
```
<!-- /source -->

The settlement interface, and the only implementation that exists:

<!-- source:bounty-settlement.js#SettlementInterface -->
```javascript
// bounty-settlement.js — SettlementInterface (lines 27–38), embedded by docs:sync
/**
 * The contract Run B must satisfy.
 * TODO(run-b): implement RealSettlement — needs a funded operator wallet,
 * the escrow contract address, and an idempotent on-chain submit path keyed
 * off the ledger row id so a retry cannot double-pay.
 */
export class SettlementInterface {
  /** @param {{to:string|null, amount:string, bucket:string, ref:string}} _ */
  release(_) { throw new Error('not implemented'); }
  /** @param {{to:string, amount:string, ref:string}} _ */
  refund(_) { throw new Error('not implemented'); }
}
```
<!-- /source -->

<!-- source:bounty-settlement.js#StubSettlement -->
```javascript
// bounty-settlement.js — StubSettlement (lines 40–72), embedded by docs:sync
/**
 * Records intent, moves nothing, always succeeds. This is the ONLY
 * implementation that exists in Run A.
 */
export class StubSettlement extends SettlementInterface {
  constructor({ log = console } = {}) {
    super();
    /** @type {SettlementIntent[]} */
    this.intents = [];
    this.log = log;
  }

  release({ to, amount, bucket, ref }) {
    // TODO(run-b): real transfer. Intentionally does nothing on chain.
    const intent = { kind: 'release', to: to || null, amount: String(amount), bucket, ref, at: Date.now() };
    this.intents.push(intent);
    this.log.log(`[bounty-settlement] STUB release intent — ${amount} (${bucket}) → ${to || 'unassigned'} [ref ${ref}] — NO FUNDS MOVED`);
    return { ok: true, stubbed: true, intent };
  }

  refund({ to, amount, ref }) {
    // TODO(run-b): real refund. Intentionally does nothing on chain.
    const intent = { kind: 'refund', to, amount: String(amount), bucket: 'contributor', ref, at: Date.now() };
    this.intents.push(intent);
    this.log.log(`[bounty-settlement] STUB refund intent — ${amount} → ${to} [ref ${ref}] — NO FUNDS MOVED`);
    return { ok: true, stubbed: true, intent };
  }

  /** Everything that would have been paid, for the admin view and Run B. */
  pending() {
    return [...this.intents];
  }
}
```
<!-- /source -->

## Verification confidence tiers

<!-- source:bounty-confidence.js#TIER -->
```javascript
// bounty-confidence.js — TIER (lines 50–55), embedded by docs:sync
export const TIER = {
  EXTERNAL: 1,       // platform's own copy carried the code
  OBS_CORROBORATED: 2, // self-capture carried it AND OBS said the source was live on screen
  SELF_CAPTURE: 3,   // self-capture carried it, nothing corroborating
  WARNED: 4,         // carried it, but a signal disagrees — a person looks
};
```
<!-- /source -->

## Per-platform verification profiles

The one source for both the verifier's sampling density and the sentence a streamer reads before going live.

<!-- source:bounty-claim.config.js#PLATFORM_PROFILES -->
```javascript
// bounty-claim.config.js — PLATFORM_PROFILES (lines 537–611), embedded by docs:sync
/**
 * How verification actually behaves per platform — ONE source of truth for
 * the verifier's sampling density and for the words a streamer reads before
 * they rely on it.
 *
 * Twitch keeps VODs, so a live read that fails can be retried against the
 * archive: a missed frame costs nothing. Kick publishes no VOD listing API,
 * so the live pass is the ONLY pass. That is a materially different bargain
 * and a Kick streamer is entitled to know it BEFORE they go live, not after
 * an unpaid bounty. We compensate with double the sampling density; we do not
 * pretend the difference away.
 */
export const PLATFORM_PROFILES = {
  twitch: {
    platform: 'twitch',
    vodRetry: true,
    samplingMultiplier: 1,
    notice: 'Twitch keeps a VOD, so if a live check misses a code we re-check '
      + 'the archive afterwards. A dropped frame during the stream costs you nothing.',
  },
  youtube: {
    platform: 'youtube',
    // The SAME watch URL is the live stream while it airs and the archive
    // after — no discovery step, so a missed live read retries against the
    // replay exactly like Twitch.
    vodRetry: true,
    samplingMultiplier: 1,
    notice: 'YouTube keeps the replay at the same link, so if a live check '
      + 'misses a code we re-check the replay afterwards. A dropped frame '
      + 'during the stream costs you nothing.',
  },
  rumble: {
    platform: 'rumble',
    // No sanctioned VOD discovery — live-first, same bargain as Kick, and
    // the streamer is told the same way.
    vodRetry: false,
    samplingMultiplier: 2,
    notice: 'Rumble gives us no replay we can read, so the live check is the '
      + 'only check — we sample twice as often to make up for it, and our own '
      + 'recording of the public stream is the primary evidence. If a check '
      + 'is inconclusive it goes to a person, never to a denial.',
  },
  x: {
    platform: 'x',
    // No pullable stream AT ALL: no VOD retry, and the live pass reads our
    // own rolling capture rather than anything X serves us.
    vodRetry: false,
    samplingMultiplier: 2,
    notice: 'X gives us no stream we can read, so verification runs entirely '
      + 'on our own recording of your broadcast plus your OBS confirming the '
      + 'overlay was on screen. Keep the badge unobstructed while a MegaChat '
      + 'plays. If a check is inconclusive it goes to a person, never to a denial.',
  },
  pumpfun: {
    platform: 'pumpfun',
    // The append-only playlist keeps the whole broadcast addressable while
    // pump.fun serves it — a re-check reads the same public URL. Retention
    // after the stream is UNPROVEN, so our own recording is still kept.
    vodRetry: true,
    samplingMultiplier: 1,
    notice: 'pump.fun serves a public replay of your stream while it stays up, '
      + 'and every moment of it is timestamped — checks land exactly where your '
      + 'MegaChats played. We keep our own recording too, in case the replay '
      + 'disappears. If a check is inconclusive it goes to a person, never to a denial.',
  },
  kick: {
    platform: 'kick',
    vodRetry: false,
    samplingMultiplier: 2,
    notice: 'Kick has no VOD we can read, so the live check is the only check — '
      + 'there is no second look after the stream. We sample twice as often to '
      + 'make up for it, but keep the badge unobstructed the whole time a MegaChat '
      + 'is playing. If a check is inconclusive it goes to a person, never to a denial.',
  },
};
```
<!-- /source -->

## Airings

<!-- source:airings-store.js#addMoment -->
```javascript
// airings-store.js — addMoment (lines 138–153), embedded by docs:sync
/**
 * Record something worth seeking to. Silently does nothing when the room is
 * not on air — a seat taken in a room whose owner never streams is a normal
 * thing that happens, not an error, and this must never be in a position to
 * throw inside a seat or letter path.
 */
export function addMoment(roomId, { kind, label = null, at = Date.now() }) {
  load();
  const a = openAiringFor(roomId);
  if (!a) return null;
  if (a.moments.length >= MAX_MOMENTS) return null;
  const moment = { at, kind, label, offsetMs: Math.max(0, at - a.startedAt) };
  a.moments.push(moment);
  persist();
  return moment;
}
```
<!-- /source -->

<!-- source:airings-store.js#attachRecording -->
```javascript
// airings-store.js — attachRecording (lines 156–165), embedded by docs:sync
export function attachRecording(airingId, { vodId = null, vodUrl = null, captureRef = null }) {
  load();
  const a = state.airings.find((x) => x.id === airingId);
  if (!a) return null;
  if (vodId !== null) a.vodId = vodId;
  if (vodUrl !== null) a.vodUrl = vodUrl;
  if (captureRef !== null) a.captureRef = captureRef;
  persist();
  return a;
}
```
<!-- /source -->

## HTTP surface

The routes `server.js` registers directly, in source order: `GET /r/:handle`, `GET /r/:handle/overlay`, `GET /api/health/platforms`, `GET /api/health`, `GET /api/config`, `GET /api/balance/:address`, `POST /api/livekit/webhook`, `GET /api/livekit/burn`, `POST /api/livekit/burn/purge-foreign`, `POST /api/livekit/burn/test-alert`, `POST|DELETE /api/livekit/burn/override`, `POST /api/livekit/prewarm[/progress|/cancel]`, `POST /api/livekit/overlay/beat`, `GET /api/livekit/overlay/health`, `GET /api/livekit/sessions`, `POST /api/livekit/token`, `POST /api/seat/quality`, `GET /`, `GET /overlay`, `POST /api/join/passkey`, `POST /api/join/mpp`, `ALL /api/meter/tick`, `POST /api/join` (501, retired), `POST /api/leave/:seatId`, `GET /api/seats`, `GET /api/rooms/:roomId/poster.jpg`, `GET /api/airings/:airingId/poster.jpg`, `GET /api/rooms/recent`, `GET /api/rooms/public`, `GET /favicon.ico`, `GET /:handle`, `GET /:handle/overlay`.

Attached modules add their own: `/auth/*` (`auth.js`), `/api/letter/*` (`letters.js`), `/api/dashboard/*` (`dashboard-routes.js`), `/api/whitelist/*` (`whitelist-routes.js`), and — only with `BOUNTY_CLAIM=1` — the `/api/bounty/*` set listed by path in `bounty-routes.js` (`guarded.get`/`guarded.post`), every one of which is looked up in `bounty-auth.js`'s policy table at registration.
