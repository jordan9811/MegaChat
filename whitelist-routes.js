/**
 * Guest whitelist management API — per STREAMER, so these routes are scoped to
 * the signed-in account rather than to a room id. There is deliberately no
 * room-password path here (unlike the dashboard routes): the room password is
 * shared with mods to run one room, and a list that silently applies to every
 * room the streamer owns is not theirs to edit.
 */
import {
  getList,
  addGuest,
  removeGuest,
  setEnabled,
  whitelistMax,
} from './guest-whitelist.js';
import { getIdentityByHandle } from './identity-store.js';
import { readIdentityFromRequest, roomOwnerKey } from './auth.js';
import { sanitizeHandle } from './rooms-store.js';

export function attachWhitelistRoutes(app, { log = console } = {}) {
  /** Every route here is "me, the streamer" — identity cookie or nothing. */
  function requireStreamer(req, res, next) {
    const identity = readIdentityFromRequest(req);
    const ownerKey = roomOwnerKey(identity);
    if (!ownerKey) {
      return res.status(401).json({
        error: 'Sign in to manage your guest list.',
        reason: 'signed_out',
      });
    }
    req.streamer = identity;
    req.ownerKey = ownerKey;
    next();
  }

  app.get('/api/whitelist', requireStreamer, (req, res) => {
    res.json(getList(req.ownerKey));
  });

  app.post('/api/whitelist', requireStreamer, (req, res) => {
    const raw = req.body?.handle;
    const clean = sanitizeHandle(raw);
    if (!clean) {
      return res.status(400).json({
        error: 'Handles are 3-20 characters: letters, numbers and underscores.',
        reason: 'invalid_handle',
      });
    }

    // Whitelisting yourself is meaningless — you are the host, you were never
    // going to be charged to run your own room. Say so and move on: this is a
    // no-op, not a failure, so it never lights up red in the UI.
    if (req.streamer?.handle && clean === req.streamer.handle) {
      return res.json({
        ...getList(req.ownerKey),
        added: false,
        skipped: 'self',
        message: "That's you — the host never pays to join their own room.",
      });
    }

    // A handle that resolves to nobody would sit on the list looking correct
    // and never match anyone, so it is rejected at the door rather than stored.
    const target = getIdentityByHandle(clean);
    if (!target) {
      return res.status(404).json({
        error: `No MegaChat account uses @${clean}. Check the spelling — they need to have signed in and claimed their handle at least once.`,
        reason: 'unknown_handle',
      });
    }

    let result;
    try {
      result = addGuest(req.ownerKey, clean, roomOwnerKey(target));
    } catch (err) {
      const status = err.code === 'list_full' ? 409 : 400;
      return res.status(status).json({ error: err.message, reason: err.code });
    }
    if (result.added) log.log(`[whitelist] ${req.ownerKey} added @${clean}`);
    res.json({ ...getList(req.ownerKey), added: result.added, entry: result.entry });
  });

  app.delete('/api/whitelist/:handle', requireStreamer, (req, res) => {
    const clean = sanitizeHandle(req.params.handle);
    if (!clean) {
      return res.status(400).json({ error: 'Invalid handle', reason: 'invalid_handle' });
    }
    const removed = removeGuest(req.ownerKey, clean);
    if (removed) log.log(`[whitelist] ${req.ownerKey} removed @${clean}`);
    // Removing someone who is live does NOT kick them — the check only runs at
    // join time, so their current session finishes and the change applies the
    // next time they come in.
    res.json({ ...getList(req.ownerKey), removed });
  });

  app.post('/api/whitelist/enabled', requireStreamer, (req, res) => {
    // STRICT BOOLEAN, and the strictness is the point. `!== false` fails OPEN:
    // a missing body, {}, {enabled:'false'} and {enabled:0} all turned the list
    // ON, and ON is the direction that hands out free seats. A switch whose
    // failure mode is "give the room away" has to refuse anything it does not
    // positively understand, so an ambiguous request is a 400 rather than a
    // silent grant.
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be true or false' });
    }
    const enabled = req.body.enabled;
    const list = setEnabled(req.ownerKey, enabled);
    log.log(`[whitelist] ${req.ownerKey} master switch ${enabled ? 'ON' : 'OFF'} (${list.entries.length} guest(s) kept)`);
    res.json(list);
  });

  log.log(`[whitelist] guest list routes ready (max ${whitelistMax()} per streamer)`);
}
