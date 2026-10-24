/**
 * campaign-store.js — the three JSON stores behind targeted reward campaigns,
 * plus the campaign ledger. Persistence only: every decision is made in
 * campaign-engine.js, and every money movement in settlement.js.
 *
 *   campaigns.json       { campaigns: { <id>: Campaign }, slugs: { <slug>: <id> } }
 *   reference-sets.json  { sets: { <id>: ReferenceSet } }      — FROZEN rows
 *   campaign-claims.json { claims: { <id>: Claim }, byX: {}, byAccount: {}, byLetter: {}, bySeat: {} }
 *   campaign-ledger.jsonl  append-only: one row per state change that involves
 *                          an amount (reserved, released, owed, intent, refund,
 *                          x-cost). The settlement door keeps its own ledger of
 *                          what actually moved; this one says why.
 *
 * Each file is loaded once into this store's in-memory cache and written on
 * every mutation, atomically (json-store.js: tmp + fsync + rename) so a torn
 * write cannot lose a claim; a file that cannot be read REFUSES writes rather
 * than reading as empty. Everything is synchronous, so a read-check-write
 * inside one function cannot interleave with another request — that is what
 * makes the budget and one-claim rules atomic.
 *
 * Claims are also indexed IN MEMORY by campaign and by account (built once
 * from the file, kept current by putClaim). The sweep lists one campaign's
 * claims at a time, every 15 s; before the index each listing walked every
 * claim of every campaign (11 s a sweep at 1,000 campaigns × 50 claims).
 * Each putClaim still rewrites the whole claims file (OPEN-ISSUES).
 *
 * FROZEN MEANS IMMUTABLE. A reference set is written once by `insertSet` and
 * there is no function that edits one. A refresh inserts a NEW set that names
 * the one it supersedes; campaigns keep pointing at whichever id they chose.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createJsonStore } from './json-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createCampaignStore({ dataDir = process.env.DATA_DIR || path.join(__dirname, 'data') } = {}) {
  const files = {
    campaigns: path.join(dataDir, 'campaigns.json'),
    sets: path.join(dataDir, 'reference-sets.json'),
    claims: path.join(dataDir, 'campaign-claims.json'),
    ledger: path.join(dataDir, 'campaign-ledger.jsonl'),
  };
  const ensure = () => { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true }); };
  // Each document is written atomically and, if it cannot be read, REFUSES
  // writes instead of reading as empty (json-store.js, D3): a torn campaigns.json
  // used to read as "no campaigns" and the next save erased every funded one.
  const doc = (k, empty, normalize) => createJsonStore({ file: files[k], name: `campaign-${k}`, pretty: true, empty, normalize });
  const docs = {
    campaigns: doc('campaigns', () => ({ campaigns: {}, slugs: {} }), (s) => { s.campaigns ||= {}; s.slugs ||= {}; return s; }),
    sets: doc('sets', () => ({ sets: {} }), (s) => { s.sets ||= {}; return s; }),
    claims: doc('claims', () => ({ claims: {} }), (s) => { s.claims ||= {}; s.byX ||= {}; s.byAccount ||= {}; s.byLetter ||= {}; s.bySeat ||= {}; return s; }),
  };
  const C = () => docs.campaigns.data();
  const S = () => docs.sets.data();
  const K = () => docs.claims.data();
  const write = (k) => docs[k].save();
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  // campaignId → claim ids, accountId → claim ids. A claim's campaign and
  // account never change and no claim is ever deleted, so an id only ever
  // joins a set.
  let index = null;
  const addTo = (m, key, id) => { let ids = m.get(key); if (!ids) m.set(key, (ids = new Set())); ids.add(id); };
  const claimIndex = () => {
    if (index) return index;
    index = { byCampaign: new Map(), byAccount: new Map() };
    for (const k of Object.values(K().claims)) { addTo(index.byCampaign, k.campaignId, k.id); addTo(index.byAccount, k.accountId, k.id); }
    return index;
  };
  const claimsAt = (ids) => { const s = K(); return [...(ids || [])].map((id) => clone(s.claims[id])); };
  /** A set without its ids and handles: what every view needs, at a fraction of the clone. */
  const setMeta = (x) => { const { ids, handles, ...rest } = x; return clone(rest); };

  return {
    files,
    // ── campaigns ──
    getCampaign: (id) => clone(C().campaigns[id] || null),
    campaignBySlug: (slug) => { const s = C(); const id = s.slugs[String(slug || '').toLowerCase()]; return id ? clone(s.campaigns[id]) : null; },
    slugTaken: (slug) => !!C().slugs[String(slug || '').toLowerCase()],
    listCampaigns: () => Object.values(C().campaigns).map(clone),
    /** Every campaign id, cloning nothing: the sweep reads each campaign fresh as it reaches it. */
    campaignIds: () => Object.keys(C().campaigns),
    putCampaign(c) {
      docs.campaigns.assertWritable(); // before any change: a refused write leaves memory as it was
      const s = C();
      const prev = s.campaigns[c.id];
      if (prev && prev.slug !== c.slug) throw new Error('a campaign slug never changes');
      s.campaigns[c.id] = clone(c);
      s.slugs[c.slug] = c.id;
      write('campaigns');
      return clone(c);
    },
    // ── reference sets (insert-only) ──
    getSet: (id) => clone(S().sets[id] || null),
    getSetMeta: (id) => { const x = S().sets[id]; return x ? setMeta(x) : null; },
    listSets: () => Object.values(S().sets).map(setMeta),
    insertSet(set) {
      docs.sets.assertWritable();
      const s = S();
      if (s.sets[set.id]) throw new Error(`reference set ${set.id} exists and is frozen`);
      s.sets[set.id] = Object.freeze(clone(set));
      write('sets');
      return clone(set);
    },
    // ── claims ──
    getClaim: (id) => clone(K().claims[id] || null),
    claimFor({ campaignId, accountId, xUserId }) {
      const s = K();
      const byA = accountId ? s.byAccount[`${campaignId}:${accountId}`] : null;
      const byX = xUserId ? s.byX[`${campaignId}:${xUserId}`] : null;
      return { byAccount: byA ? clone(s.claims[byA]) : null, byX: byX ? clone(s.claims[byX]) : null };
    },
    claimByLetter: (letterId) => { const s = K(); const id = s.byLetter[letterId]; return id ? clone(s.claims[id]) : null; },
    claimBySeat: (seatId) => { const s = K(); const id = s.bySeat[seatId]; return id ? clone(s.claims[id]) : null; },
    listClaims: (campaignId = null) => (campaignId ? claimsAt(claimIndex().byCampaign.get(campaignId)) : Object.values(K().claims).map(clone)),
    claimsOfAccount: (accountId) => claimsAt(claimIndex().byAccount.get(accountId)),
    putClaim(claim) {
      docs.claims.assertWritable(); // before the index learns the claim, too
      const s = K();
      const idx = claimIndex();
      addTo(idx.byCampaign, claim.campaignId, claim.id);
      addTo(idx.byAccount, claim.accountId, claim.id);
      s.claims[claim.id] = clone(claim);
      s.byAccount[`${claim.campaignId}:${claim.accountId}`] = claim.id;
      if (claim.xUserId) s.byX[`${claim.campaignId}:${claim.xUserId}`] = claim.id;
      if (claim.letterId) s.byLetter[claim.letterId] = claim.id;
      if (claim.seatId) s.bySeat[claim.seatId] = claim.id;
      write('claims');
      return clone(claim);
    },
    // ── ledger ──
    appendLedger(row) {
      ensure();
      fs.appendFileSync(files.ledger, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
    },
    ledger() {
      try { return fs.readFileSync(files.ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
    },
    _reset() { for (const d of Object.values(docs)) d.reset(); index = null; },
  };
}
