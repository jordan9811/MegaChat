/**
 * LiveKit transport service — token minting + room admin. FLAG-GATED: when
 * LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are absent this module
 * returns null and every livekit surface renders "not configured". The
 * vdo.ninja path is untouched and remains the default transport.
 *
 * Authorization model mirrors the meter: PUBLISHER tokens are only minted
 * for a seat the join flow already granted (same authorization the meter
 * ticks against); SUBSCRIBER tokens are view-only (parity with vdo view
 * links, which are public by stream-id today); HOST tokens (phase 2) demand
 * the room password.
 */
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

export function createLivekitService({ log = console } = {}) {
  const url = process.env.LIVEKIT_URL || '';
  const apiKey = process.env.LIVEKIT_API_KEY || '';
  const apiSecret = process.env.LIVEKIT_API_SECRET || '';
  if (!url || !apiKey || !apiSecret) {
    log.warn('[livekit] not configured (LIVEKIT_URL / API_KEY / API_SECRET) — vdo-only mode');
    return null;
  }
  const httpUrl = url.replace(/^ws/, 'http');
  const rooms = new RoomServiceClient(httpUrl, apiKey, apiSecret);

  const lkRoomName = (roomId) => `mc-${roomId}`;

  async function mint({ identity, name, roomId, canPublish, canSubscribe, ttl = '2h' }) {
    const at = new AccessToken(apiKey, apiSecret, { identity, name, ttl });
    at.addGrant({
      roomJoin: true,
      room: lkRoomName(roomId),
      canPublish,
      canSubscribe,
      canPublishData: false,
    });
    return at.toJwt();
  }

  return {
    url,
    lkRoomName,

    /** Joiner cam+mic — only for a seat the join flow granted. */
    publisherToken(roomId, seat) {
      return mint({
        identity: `seat:${seat.id}`,
        name: seat.username,
        roomId,
        canPublish: true,
        canSubscribe: true, // the live slot also watches the host feed
      });
    },

    /** Overlay / spectators — view-only (vdo view-link parity). */
    subscriberToken(roomId, identity) {
      return mint({ identity, roomId, canPublish: false, canSubscribe: true });
    },

    /** Streamer's own camera (phase 2) — password-gated at the route. */
    hostToken(roomId) {
      return mint({
        identity: `host:${roomId}`,
        name: 'HOST',
        roomId,
        canPublish: true,
        canSubscribe: true,
        ttl: '12h',
      });
    },

    /** Server-side teardown on kick/leave — the SFU drops the track NOW. */
    async kickParticipant(roomId, identity) {
      try {
        await rooms.removeParticipant(lkRoomName(roomId), identity);
        log.log(`[livekit] removed ${identity} from ${lkRoomName(roomId)}`);
      } catch (err) {
        // Participant may already be gone (client disconnected first).
        if (!/not found/i.test(err?.message || '')) {
          log.warn(`[livekit] remove ${identity}: ${err.message}`);
        }
      }
    },

    /** Gate/diagnostic helper. */
    async listParticipants(roomId) {
      try {
        return await rooms.listParticipants(lkRoomName(roomId));
      } catch {
        return [];
      }
    },

    /**
     * Everything LiveKit currently holds, keyed by its OWN room names rather
     * than our room ids. Boot reconciliation needs this shape because webhook
     * events carry the LiveKit name, and because a room may exist on their
     * side that we have no record of (a dashboard test fire, for instance —
     * exactly the phantom that once ate 37.5% of a day's budget).
     *
     * Throws rather than returning empty: an empty list and a failed call mean
     * opposite things to the caller. "Nobody is connected" would close every
     * resumed session; "we could not ask" must leave them open.
     */
    async liveParticipantKeys() {
      const keys = new Set();
      for (const room of await rooms.listRooms()) {
        for (const p of await rooms.listParticipants(room.name)) {
          keys.add(`${room.name}|${p.identity}`);
        }
      }
      return keys;
    },
  };
}
