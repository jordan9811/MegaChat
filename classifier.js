/**
 * classifier.js — what an account looks like, on sight. Not a gate.
 *
 * `classify(account, { allowlist, now })` is PURE: no disk, no network, no
 * clock of its own (pass `now` to pin it). It returns `{ tier, reasons[] }`
 * and decides nothing — no feature in this pass consumes it. It exists so that
 * a later feature can tell a recognisable person from an obvious bot WITHOUT
 * ever showing anyone a verification step.
 *
 * THE DESIGN CONSTRAINT THAT PICKED THE NUMBERS: friction is for the ambiguous
 * middle, never the top. So every threshold below is set where a FALSE
 * `recognized` is cheap (a nobody skips a step that was not going to catch
 * them anyway) and a false `suspect` is expensive (a real person gets
 * insulted). When a signal is missing the answer is `ambiguous`, never
 * `suspect`: absence of evidence is not evidence of a bot.
 *
 * TIERS
 *   recognized  on the seeded allowlist, or a bar a bought account does not clear.
 *   plausible   looks like a real person. Zero friction.
 *   ambiguous   cannot tell. The ONLY tier a later feature may add friction to.
 *   suspect     carries the mass-follow signature. A later feature may refuse.
 *   unknown     no attributes were ever fetched.
 *
 * THE NUMBERS, AND WHY THEY ARE THESE NUMBERS
 *   · verified + 100k followers → recognized. An X checkmark is purchasable,
 *     so `verified` alone means "pays for X", not "is notable". 100k followers
 *     is not purchasable in the same sense, and the pair is a combination a
 *     bought checkmark does not confer.
 *   · Twitch `partner` → recognized on its own. Partner is an application
 *     Twitch reviews; there is no way to buy it.
 *   · 180 days old AND 50 followers → plausible. Follow-farms are churned
 *     faster than six months and rarely accumulate genuine followers; 50 is
 *     low enough to include a lurker who only knows their own friends.
 *   · 730 days old → plausible on age alone. Two years of continuous existence
 *     is itself evidence, and it rescues the real person with nine followers.
 *   · Twitch `affiliate` → plausible. Reviewed, but a much lower bar than
 *     partner.
 *   · following ≥ 1000 AND younger than 30 days → suspect. That is the
 *     mass-follow farm: brand new, following everyone, followed by nobody.
 *   · following ≥ 500 AND followers/following < 0.02 → suspect. Following 500
 *     people and being followed by under 10 of them is the same signature
 *     without the age tell.
 *   Every one of these is a judgement call with no user data behind it — the
 *   app has zero users. They are written here, in one place, to be argued with.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { accountAttributes, bestAttributes } from './attestation/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const TIERS = ['recognized', 'plausible', 'ambiguous', 'suspect', 'unknown'];

export const THRESHOLDS = {
  recognizedFollowers: 100_000,
  plausibleFollowers: 50,
  plausibleAgeDays: 180,
  plausibleAgeAloneDays: 730,
  suspectYoungDays: 30,
  suspectFollowing: 1_000,
  suspectRatioFollowing: 500,
  suspectRatio: 0.02,
};

/**
 * The seeded allowlist: platform IDS, never handles, because handles change
 * hands and ids do not. The owner maintains it. Empty by default.
 *
 * `recognized-accounts.json` in the repo is the default; a copy in DATA_DIR
 * overrides it, so production can be edited without a deploy. Shape:
 *   { "x": ["44196397"], "twitch": ["12345"] }
 */
export function loadAllowlist({ dataDir = process.env.DATA_DIR || path.join(__dirname, 'data') } = {}) {
  for (const p of [path.join(dataDir, 'recognized-accounts.json'), path.join(__dirname, 'recognized-accounts.json')]) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const out = {};
      for (const [provider, ids] of Object.entries(raw || {})) {
        if (Array.isArray(ids)) out[provider] = ids.map(String);
      }
      return out;
    } catch { /* next */ }
  }
  return {};
}

const daysBetween = (iso, now) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Math.floor((now - t) / 86_400_000) : null;
};

/**
 * `{ tier, reasons[] }` for an account. Reasons are plain language and are
 * stored with the result so a person can be shown why they landed where they
 * did. Pure: pass `allowlist` and `now` rather than letting it reach for them.
 */
export function classify(account, { allowlist = {}, now = Date.now() } = {}) {
  const reasons = [];
  const links = account?.links || [];
  if (!links.length) return { tier: 'unknown', reasons: ['No platform is linked to this account yet.'] };

  // 1. The allowlist, first and unconditionally.
  for (const l of links) {
    const ids = allowlist[l.provider] || [];
    if (ids.includes(String(l.platformId))) {
      return { tier: 'recognized', reasons: [`This ${label(l.provider)} account is on the recognised list.`] };
    }
  }

  const best = bestAttributes(accountAttributes(account));
  const has = (k) => Object.prototype.hasOwnProperty.call(best, k);
  const val = (k) => (has(k) ? best[k].value : null);
  if (!Object.keys(best).length) {
    return { tier: 'unknown', reasons: ['No profile details have been fetched for this account yet.'] };
  }

  const followers = val('followersCount');
  const following = val('followingCount');
  const verified = val('verified');
  const broadcasterType = val('broadcasterType');
  const ageDays = has('accountCreatedAt') ? daysBetween(val('accountCreatedAt'), now) : null;

  // 2. Recognised: a bar a bought account does not clear.
  if (verified === true && typeof followers === 'number' && followers >= THRESHOLDS.recognizedFollowers) {
    return { tier: 'recognized', reasons: [`Verified with ${fmt(followers)} followers — past the ${fmt(THRESHOLDS.recognizedFollowers)} mark where a paid checkmark stops explaining it.`] };
  }
  if (broadcasterType === 'partner') {
    return { tier: 'recognized', reasons: ['A Twitch Partner — a status Twitch reviews and nobody can buy.'] };
  }

  // 3. Suspect: the mass-follow signature, and only that.
  if (typeof following === 'number' && following >= THRESHOLDS.suspectFollowing
      && typeof ageDays === 'number' && ageDays < THRESHOLDS.suspectYoungDays) {
    reasons.push(`Follows ${fmt(following)} accounts but is only ${ageDays} days old.`);
    return { tier: 'suspect', reasons };
  }
  if (typeof following === 'number' && following >= THRESHOLDS.suspectRatioFollowing
      && typeof followers === 'number' && followers / following < THRESHOLDS.suspectRatio) {
    reasons.push(`Follows ${fmt(following)} accounts and is followed by ${fmt(followers)} — the ratio a follow-farm leaves behind.`);
    return { tier: 'suspect', reasons };
  }

  // 4. Plausible: looks like a real person.
  if (typeof ageDays === 'number' && ageDays >= THRESHOLDS.plausibleAgeAloneDays) {
    reasons.push(`The account has existed for ${Math.floor(ageDays / 365)} years.`);
  }
  if (typeof ageDays === 'number' && ageDays >= THRESHOLDS.plausibleAgeDays
      && typeof followers === 'number' && followers >= THRESHOLDS.plausibleFollowers) {
    reasons.push(`${fmt(followers)} followers and ${ageDays} days old.`);
  }
  if (broadcasterType === 'affiliate') reasons.push('A Twitch Affiliate.');
  if (verified === true && !reasons.length) reasons.push('Verified on X, which costs real money even when it proves nothing else.');
  if (reasons.length) return { tier: 'plausible', reasons };

  // 5. Ambiguous: something is known, none of it decides.
  const known = [];
  if (typeof followers === 'number') known.push(`${fmt(followers)} followers`);
  if (typeof following === 'number') known.push(`following ${fmt(following)}`);
  if (typeof ageDays === 'number') known.push(`${ageDays} days old`);
  return {
    tier: 'ambiguous',
    reasons: [known.length ? `Not enough to tell either way: ${known.join(', ')}.` : 'Not enough profile detail to tell either way.'],
  };
}

const label = (p) => ({ twitch: 'Twitch', x: 'X', kick: 'Kick', tiktok: 'TikTok' }[p] || p);
const fmt = (n) => Number(n).toLocaleString('en-US');
