/**
 * campaign-eligibility.js — who qualifies for a targeted reward campaign.
 *
 * PURE. No imports, no disk, no network, no clock of its own: everything it
 * needs arrives as arguments (the gate copies this file, mutates one rule and
 * shows the gate then fails — it must stand alone to be copied). The network
 * parts — refreshing stale X attributes, the followedByFromSet lookups — run
 * in campaign-engine.js BEFORE this is called, and their results arrive in
 * `extra`.
 *
 * X DEVELOPER POLICY — THE CONSTRAINT EVERYTHING HERE OBEYS. X forbids paying
 * people to take actions on X. A campaign pays for ONE thing: a Holler (or a
 * Call in) on a Holler stream. Every rule below OBSERVES a fact that already
 * exists about an X account — its size, its age, whether it is on a frozen
 * list, whether accounts on that list already follow it. No rule asks for, or
 * rewards, a follow, reply, repost, quote or like, and `copyViolation` keeps
 * campaign copy from asking for one either. followedByFromSet counts accounts
 * on the list that follow THE APPLICANT — something the applicant cannot do
 * themselves — never accounts the applicant follows, which would make a
 * follow the price of a reward.
 *
 * FAIL CLOSED. A missing or stale attribute fails its rule with a reason the
 * person can act on ("reconnect X to refresh"); it never passes by default.
 */

const DAY = 86_400_000;

/** The rule menu a creator picks from. `attr` is the X attribute it reads. */
export const RULE_MENU = [
  { key: 'minFollowers', kind: 'number', attr: 'followersCount', label: 'Minimum followers' },
  { key: 'minVerifiedFollowers', kind: 'number', attr: 'verifiedFollowersCount', label: 'Minimum verified followers' },
  { key: 'verified', kind: 'flag', attr: 'verified', label: 'Verified on X' },
  { key: 'verifiedTypes', kind: 'list', attr: 'verifiedType', options: ['blue', 'business', 'government'], label: 'Verification type' },
  { key: 'identityVerified', kind: 'flag', attr: 'identityVerified', label: 'ID-verified on X' },
  { key: 'minAccountAgeDays', kind: 'number', attr: 'accountCreatedAt', label: 'Minimum account age (days)' },
  { key: 'minTweetCount', kind: 'number', attr: 'postCount', label: 'Minimum posts' },
  { key: 'minListedCount', kind: 'number', attr: 'listedCount', label: 'Minimum times listed' },
  { key: 'hasProfileImage', kind: 'flag', attr: 'hasProfileImage', label: 'Has a profile photo' },
  { key: 'hasDescription', kind: 'flag', attr: 'hasDescription', label: 'Has a bio' },
  { key: 'referenceSetId', kind: 'set', attr: null, label: 'On a frozen list' },
  { key: 'followedByFromSet', kind: 'followedBy', attr: null, label: 'Followed by accounts on a frozen list' },
];

/** Always enforced, never a menu item: a parody or protected account is out. */
export const ALWAYS_ATTRS = ['parody', 'protected'];

const fmt = (n) => Number(n).toLocaleString('en-US');
const dateOf = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); };
/** "1 follower", "2 followers". */
const count = (n, one, many = `${one}s`) => `${fmt(n)} ${Number(n) === 1 ? one : many}`;
/** An account age in the largest whole unit: "1+ year", "6+ months", "45+ days". */
const ageOf = (days) => {
  const d = Number(days);
  if (d >= 365 && d % 365 === 0) return `${count(d / 365, 'year')}`.replace(/^(\S+) /, '$1+ ');
  if (d >= 30 && d % 30 === 0) return `${count(d / 30, 'month')}`.replace(/^(\S+) /, '$1+ ');
  return `${count(d, 'day')}`.replace(/^(\S+) /, '$1+ ');
};
const posInt = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : null; };

/**
 * Normalise a rules object from a form or a request. Unknown keys dropped,
 * numbers made positive integers, flags only when true. Returns
 * `{ rules, errors[] }`.
 */
export function normaliseRules(raw = {}) {
  const r = {}, errors = [];
  for (const k of ['minFollowers', 'minVerifiedFollowers', 'minAccountAgeDays', 'minTweetCount', 'minListedCount']) {
    if (raw[k] == null || raw[k] === '' || raw[k] === 0) continue;
    const n = posInt(raw[k]);
    if (n == null) errors.push(`${k} must be a whole number above zero`); else r[k] = n;
  }
  for (const k of ['verified', 'identityVerified', 'hasProfileImage', 'hasDescription']) if (raw[k] === true) r[k] = true;
  if (Array.isArray(raw.verifiedTypes) && raw.verifiedTypes.length) {
    const ok = raw.verifiedTypes.filter((t) => ['blue', 'business', 'government'].includes(t));
    if (ok.length) r.verifiedTypes = [...new Set(ok)];
  }
  if (raw.referenceSetId) r.referenceSetId = String(raw.referenceSetId).slice(0, 64);
  // A followedByFromSet rule that is PRESENT is ENFORCED. There used to be a
  // separate `enabled` flag that defaulted to false, so a rule sent without
  // it was stored, shown everywhere as on, and never checked. Now: present →
  // on; only an explicit `enabled: false` turns it off, and then the rule is
  // dropped entirely so nothing displays it.
  const fb = raw.followedByFromSet;
  if (fb && typeof fb === 'object' && fb.enabled !== false) {
    const min = posInt(fb.min);
    const cap = Number(fb.perClaimCostCapUsd);
    if (min == null) errors.push('followedByFromSet.min must be a whole number above zero');
    else if (!(cap > 0) || cap > 50) errors.push('followedByFromSet.perClaimCostCapUsd must be above 0 and at most 50');
    else r.followedByFromSet = { enabled: true, min, perClaimCostCapUsd: Math.round(cap * 100) / 100, referenceSetId: fb.referenceSetId ? String(fb.referenceSetId).slice(0, 64) : (r.referenceSetId || null) };
    // What checking may cost the campaign IN ALL (every applicant, qualifying
    // or not). Absent: 20% of the budget (campaign-engine.js DEFAULT_X_CHECK_SHARE).
    if (r.followedByFromSet && fb.maxTotalUsd != null && fb.maxTotalUsd !== '') {
      const total = Number(fb.maxTotalUsd);
      if (!(total > 0) || total > 100_000) errors.push('followedByFromSet.maxTotalUsd must be above 0');
      else if (total < r.followedByFromSet.perClaimCostCapUsd) errors.push('followedByFromSet.maxTotalUsd must be at least the per-claim cap');
      else r.followedByFromSet.maxTotalUsd = Math.round(total * 100) / 100;
    }
    if (r.followedByFromSet && !r.followedByFromSet.referenceSetId) errors.push('followedByFromSet needs a frozen list to count from');
  }
  return { rules: r, errors };
}

/** The X link's attributes as {name: {value, fetchedAt}} — x-api source only. */
export function xAttributes(account) {
  const link = (account?.links || []).find((l) => l.provider === 'x');
  const out = {};
  for (const rec of link?.attributes || []) {
    if (!rec || rec.source !== 'x-api') continue;
    const cur = out[rec.attribute];
    if (!cur || String(rec.fetchedAt || '') >= String(cur.fetchedAt || '')) out[rec.attribute] = { value: rec.value, fetchedAt: rec.fetchedAt };
  }
  return out;
}

/** The rules in plain language, for the public page. Never asks for an action. */
export function describeRules(rules = {}, { refSets = {} } = {}) {
  const out = [];
  if (rules.minFollowers) out.push(`At least ${count(rules.minFollowers, 'follower')} on X`);
  if (rules.minVerifiedFollowers) out.push(`At least ${count(rules.minVerifiedFollowers, 'verified account')} among your X followers`);
  if (rules.verified) out.push('A verified X account');
  if (rules.verifiedTypes?.length) out.push(`Verified as ${rules.verifiedTypes.join(', ')}`);
  if (rules.identityVerified) out.push('ID-verified on X');
  if (rules.minAccountAgeDays) out.push(`An X account ${ageOf(rules.minAccountAgeDays)} old`);
  if (rules.minTweetCount) out.push(`At least ${count(rules.minTweetCount, 'post')} on X`);
  if (rules.minListedCount) out.push(`On at least ${count(rules.minListedCount, 'X list')}`);
  if (rules.hasProfileImage) out.push('A profile photo on X');
  if (rules.hasDescription) out.push('A bio on X');
  if (rules.referenceSetId) {
    const s = refSets[rules.referenceSetId];
    out.push(s ? `Your X account is on the frozen list "${s.name}" (${count(s.count, 'account')}, snapshot ${dateOf(s.snapshotAt)})` : 'Your X account is on a frozen list');
  }
  const fb = rules.followedByFromSet;
  if (fb?.enabled) {
    const s = refSets[fb.referenceSetId];
    out.push(`At least ${count(fb.min, 'account')} on ${s ? `"${s.name}"` : 'the frozen list'} already ${Number(fb.min) === 1 ? 'follows' : 'follow'} you on X`);
  }
  out.push('Not a parody account, and your posts are not protected');
  return out;
}

/**
 * X DEVELOPER POLICY GUARD for campaign copy. Returns a reason when the text
 * asks people to act on X, else null. Deliberately broad: a false refusal
 * costs a creator a rewrite; a false pass puts the platform in breach.
 */
export function copyViolation(text) {
  const t = String(text || '').toLowerCase();
  const asks = [
    /\bfollow (me|us|him|her|them|@|back|for|and|to)\b/, /\bfollow\b.*\bto (qualify|enter|claim|get)\b/,
    /\b(re-?tweet|repost|rt)\b/, /\bquote[- ]?(tweet|post)?\b/, /\breply\b/, /\blike (this|my|the) (post|tweet)\b/,
    /\bf4f\b/, /\bturn on notifications\b/,
  ];
  return asks.some((re) => re.test(t))
    ? 'Campaign copy cannot ask anyone to follow, reply, repost, quote or like on X. X\'s Developer Policy forbids paying for actions on X; a campaign pays only for the Holler.'
    : null;
}

/**
 * evaluate(campaign, account, refSet, extra?) → { eligible, checks[] }
 *
 *   campaign  { rules }
 *   account   the account (accounts.js shape); its X link is what is read
 *   refSet    the reference set for inReferenceSet, or null
 *   extra     {
 *     now:             ms clock (required for age; defaults to Date.now())
 *     stale:           a reason string when attributes could not be refreshed
 *     followedBy:      { count, method, costUsd, capped, error } from the engine
 *     followedBySet:   the set followedByFromSet counts against
 *   }
 */
export function evaluate(campaign, account, refSet, extra = {}) {
  const rules = campaign?.rules || {};
  const now = extra.now ?? Date.now();
  const checks = [];
  const add = (rule, pass, detail) => checks.push({ rule, pass: !!pass, detail });
  const link = (account?.links || []).find((l) => l.provider === 'x');
  if (!link) {
    add('xLinked', false, 'Connect your X account to check. Only X sign-in through Holler counts.');
    return { eligible: false, checks };
  }
  const a = xAttributes(account);
  const v = (name) => a[name]?.value;
  // Absent, or KNOWN missing (a profile read where X left the field out is
  // stored as null — campaign-engine.js check): either way it fails closed.
  const missing = (name) => a[name] === undefined || a[name].value == null;
  const staleNote = extra.stale ? ` ${extra.stale}` : '';
  const unknown = (what) => `We could not read your ${what} from X.${staleNote || ' Reconnect X to refresh it.'}`;
  // An attribute rule only passes on a value read fresh enough; a stale read
  // fails closed with the reason, never silently on the old number.
  const fresh = !extra.stale;

  // Always on.
  if (missing('parody') || missing('protected') || !fresh) add('notParodyOrProtected', false, unknown('account labels'));
  else if (v('parody') === true) add('notParodyOrProtected', false, 'Parody and fan accounts cannot take part.');
  else if (v('protected') === true) add('notParodyOrProtected', false, 'Accounts with protected posts cannot take part.');
  else add('notParodyOrProtected', true, 'Not a parody account, and your posts are public.');

  const atLeast = (rule, attrName, min, noun) => {
    if (min == null) return;
    if (missing(attrName) || !fresh) return add(rule, false, unknown(noun));
    const have = Number(v(attrName));
    add(rule, have >= min, `You have ${fmt(have)} ${noun}; this needs ${fmt(min)}.`);
  };
  atLeast('minFollowers', 'followersCount', rules.minFollowers, 'followers');
  atLeast('minVerifiedFollowers', 'verifiedFollowersCount', rules.minVerifiedFollowers, 'verified followers');
  atLeast('minTweetCount', 'postCount', rules.minTweetCount, 'posts');
  atLeast('minListedCount', 'listedCount', rules.minListedCount, 'list memberships');

  const flag = (rule, attrName, yes, no) => {
    if (!rules[rule]) return;
    if (missing(attrName) || !fresh) return add(rule, false, unknown(attrName === 'verified' ? 'verification' : 'profile'));
    add(rule, v(attrName) === true, v(attrName) === true ? yes : no);
  };
  flag('verified', 'verified', 'Your X account is verified.', 'This needs a verified X account.');
  flag('identityVerified', 'identityVerified', 'Your X account is ID-verified.', 'This needs an ID-verified X account.');
  flag('hasProfileImage', 'hasProfileImage', 'You have a profile photo.', 'This needs a profile photo on X.');
  flag('hasDescription', 'hasDescription', 'You have a bio.', 'This needs a bio on your X profile.');

  if (rules.verifiedTypes?.length) {
    if (missing('verifiedType') || !fresh) add('verifiedTypes', false, unknown('verification type'));
    else {
      const t = String(v('verifiedType'));
      const ok = rules.verifiedTypes.includes(t);
      add('verifiedTypes', ok, ok ? `Verified as ${t}.` : `This needs ${rules.verifiedTypes.join(' or ')} verification; yours reads "${t}".`);
    }
  }

  if (rules.minAccountAgeDays != null) {
    if (missing('accountCreatedAt') || !fresh) add('minAccountAgeDays', false, unknown('account age'));
    else {
      const born = Date.parse(v('accountCreatedAt'));
      const days = Number.isFinite(born) ? Math.floor((now - born) / DAY) : -1;
      add('minAccountAgeDays', days >= rules.minAccountAgeDays,
        days < 0 ? unknown('account age') : `Your X account is ${fmt(days)} days old; this needs ${fmt(rules.minAccountAgeDays)}.`);
    }
  }

  if (rules.referenceSetId) {
    if (!refSet || refSet.id !== rules.referenceSetId) add('inReferenceSet', false, 'The frozen list for this campaign is unavailable, so nobody can be checked against it right now.');
    else {
      const on = (refSet._idSet || new Set(refSet.ids)).has(String(link.platformId));
      add('inReferenceSet', on, on
        ? `Your X account is on "${refSet.name}".`
        : `Your X account is not on "${refSet.name}" (${fmt(refSet.count)} accounts, frozen ${dateOf(refSet.snapshotAt)}).`);
    }
  }

  const fb = rules.followedByFromSet;
  if (fb?.enabled) {
    const r = extra.followedBy;
    const setName = extra.followedBySet?.name ? `"${extra.followedBySet.name}"` : 'the frozen list';
    if (!r || r.error) add('followedByFromSet', false, r?.error ? `We could not check who follows you right now (${r.error}). Nothing was decided; try again later.` : 'This check is not available on this server right now.');
    else {
      const ok = r.count >= fb.min;
      add('followedByFromSet', ok, ok
        ? `${fmt(r.count)} account${r.count === 1 ? '' : 's'} on ${setName} follow you; this needs ${fmt(fb.min)}.`
        : `${r.capped ? 'At least ' : ''}${fmt(r.count)} account${r.count === 1 ? '' : 's'} on ${setName} follow you${r.capped ? ' (the check stopped at its cost cap)' : ''}; this needs ${fmt(fb.min)}.`);
    }
  }

  return { eligible: checks.length > 0 && checks.every((c) => c.pass), checks };
}
