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
 * Same pattern as the other stores (bounty-store.js, guest-whitelist.js):
 * loaded once into a module cache, written on mutation, atomically (tmp +
 * rename) so a torn write cannot lose a claim. Everything is synchronous, so
 * a read-check-write inside one function cannot interleave with another
 * request — that is what makes the budget and one-claim rules atomic.
 *
 * FROZEN MEANS IMMUTABLE. A reference set is written once by `insertSet` and
 * there is no function that edits one. A refresh inserts a NEW set that names
 * the one it supersedes; campaigns keep pointing at whichever id they chose.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createCampaignStore({ dataDir = process.env.DATA_DIR || path.join(__dirname, 'data') } = {}) {
  const files = {
    campaigns: path.join(dataDir, 'campaigns.json'),
    sets: path.join(dataDir, 'reference-sets.json'),
    claims: path.join(dataDir, 'campaign-claims.json'),
    ledger: path.join(dataDir, 'campaign-ledger.jsonl'),
  };
  const cache = {};
  const ensure = () => { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true }); };
  const read = (k, empty) => {
    if (cache[k]) return cache[k];
    try { cache[k] = JSON.parse(fs.readFileSync(files[k], 'utf8')); } catch { cache[k] = empty(); }
    return cache[k];
  };
  const write = (k) => {
    ensure();
    const tmp = `${files[k]}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache[k], null, 2));
    fs.renameSync(tmp, files[k]);
  };
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

  const C = () => { const s = read('campaigns', () => ({ campaigns: {}, slugs: {} })); s.campaigns ||= {}; s.slugs ||= {}; return s; };
  const S = () => { const s = read('sets', () => ({ sets: {} })); s.sets ||= {}; return s; };
  const K = () => {
    const s = read('claims', () => ({ claims: {} }));
    s.claims ||= {}; s.byX ||= {}; s.byAccount ||= {}; s.byLetter ||= {}; s.bySeat ||= {};
    return s;
  };

  return {
    files,
    // ── campaigns ──
    getCampaign: (id) => clone(C().campaigns[id] || null),
    campaignBySlug: (slug) => { const s = C(); const id = s.slugs[String(slug || '').toLowerCase()]; return id ? clone(s.campaigns[id]) : null; },
    slugTaken: (slug) => !!C().slugs[String(slug || '').toLowerCase()],
    listCampaigns: () => Object.values(C().campaigns).map(clone),
    putCampaign(c) {
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
    listSets: () => Object.values(S().sets).map((x) => { const { ids, handles, ...rest } = x; return clone(rest); }),
    insertSet(set) {
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
    listClaims: (campaignId = null) => Object.values(K().claims).filter((c) => !campaignId || c.campaignId === campaignId).map(clone),
    putClaim(claim) {
      const s = K();
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
    _reset() { for (const k of Object.keys(cache)) delete cache[k]; },
  };
}
