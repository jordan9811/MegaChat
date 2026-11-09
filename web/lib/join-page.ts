// @ts-nocheck
/**
 * Viewer join-page logic (Tempo mainnet).
 *
 * Originally ported verbatim from the Arc-era viewer page (public/index.html,
 * deleted 2026-09-17 — it carried a client-signed Gateway deposit); the camera
 * lifecycle, WS transport, seat state machine, and rewards client are
 * unchanged. The WALLET + PAYMENT layer was rebuilt for Tempo:
 *   - Privy embedded wallets (email/social/passkey) via the window.MegaWallet
 *     bridge installed by components/providers/tempo-wallet.tsx — primary.
 *   - MetaMask stays as the secondary injected-provider path (chain 4217).
 *   - ONE metered join flow for both modes against /api/join/passkey
 *     (session-cap authorize → seat). Circle Gateway deposits/EIP-3009 are
 *     gone — funding is a plain TIP-20 transfer on Tempo.
 */

import { fetchPublicConfig } from '@/lib/api';
import { newAttemptId } from '@/lib/attempt-id';
import { setPayoutWallet } from '@/lib/bounty-api';
import { formatDollars, guestName, shortAddr } from '@/lib/display-format';
import { startEchoDetector } from '@/lib/echo-detector';
import { fetchIdentity } from '@/lib/identity';
import { recorderMime } from '@/lib/recorder-mime';

let CONFIG = null;
let account = null;
let mySeatId = null;
// The seat's proof of ownership, from the join response (money lane N1): a
// seat id is public, so register_seat, camera_ready, leave, the publisher
// token, quality and echo all carry this too. Memory only: never logged,
// never in a URL.
let mySeatToken = null;
let hasWallet = false;
let walletMode = null; // null | 'metamask' | 'privy'
let streamRoomId = 'default';

let ws = null;
let abort = null; // AbortController for window/document listeners

function parseStreamRoomFromUrl() {
  try {
    const q = new URLSearchParams(location.search).get('room');
    if (q && /^[a-z0-9_-]{1,32}$/i.test(q)) return q.toLowerCase();
    // Pretty URLs: megachat.fun/<handle> serves this page in place (no
    // redirect), so the room lives in the PATH. /api/config resolves handles.
    const seg = location.pathname.replace(/^\/+|\/+$/g, '');
    if (seg && seg !== 'join' && /^[a-z0-9_]{3,20}$/i.test(seg)) return seg.toLowerCase();
  } catch { /* ignore */ }
  return 'default';
}

/**
 * MetaMask's own provider, via EIP-6963 (each extension announces itself), or
 * null. Unlike window.ethereum — which Phantom takes over when both are
 * installed, and answers with its "Which extension?" chooser — calling this
 * provider only ever talks to MetaMask.
 */
function findMetaMask(timeoutMs = 600) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve(null);
    let done = false;
    const finish = (p) => {
      if (done) return;
      done = true;
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      resolve(p);
    };
    function onAnnounce(e) {
      const d = e && e.detail;
      if (d && d.info && d.info.rdns === 'io.metamask' && d.provider) finish(d.provider);
    }
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => finish(null), timeoutMs);
  });
}

// Safe provider accessor: never throws, returns null when no injected wallet.
function getProvider() {
  try {
    return (typeof window !== 'undefined' && window.ethereum) ? window.ethereum : null;
  } catch {
    return null;
  }
}

async function loadConfig() {
  // Shared with the wallet provider, which asks for the default room's config
  // at the same moment (lib/api.ts): one request, not two.
  const res = await fetchPublicConfig(streamRoomId);
  if (!res.ok) {
    // The status rides the error: a 404 is a link to no room (init's
    // not-found card), anything else a load that may work on a retry.
    const err = new Error(String(res.body.error || 'Failed to load room config'));
    err.status = res.status;
    throw err;
  }
  CONFIG = res.body;
  const roomName = document.getElementById('joinRoomName');
  if (roomName) roomName.textContent = CONFIG.roomName || 'Room';
  const roomState = document.getElementById('joinRoomState');
  if (roomState) roomState.textContent = CONFIG.isDemo ? 'Demo room' : CONFIG.roomActive === false ? 'Paused' : 'Room entrance';
  // The URL may have carried a HANDLE — adopt the server-resolved room id for
  // every follow-up call (join, balance, letters, WS), and fix the socket's
  // subscription if it already opened with the handle string.
  if (CONFIG.roomId && CONFIG.roomId !== streamRoomId) {
    streamRoomId = CONFIG.roomId;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'subscribe_room', room: streamRoomId }));
    }
  }
  window.__streamRoomId = streamRoomId;
  // The config rides the event, so the room bar's feature tags (join-client)
  // read it instead of asking the server for the same thing again.
  window.dispatchEvent(new CustomEvent('stream:room', { detail: CONFIG }));
  if (CONFIG.roomName) {
    document.title = CONFIG.roomName + ' — Join';
    // Next's static metadata re-applies its own <title> when hydration
    // finishes — usually AFTER this runs, silently clobbering the room name.
    // Re-assert once the dust settles.
    setTimeout(() => { document.title = CONFIG.roomName + ' — Join'; }, 1500);
  }
  if (CONFIG.roomActive === false) {
    showMessage('This room is not accepting new joins right now.', 'error');
    const joinBtn = document.getElementById('joinBtn');
    if (joinBtn) joinBtn.disabled = true;
  }
  updatePriceDisplay();
}

function tokenSymbol() {
  if (!CONFIG) return 'USDC';
  return (CONFIG.paymentTokenSymbol || 'USDC').replace(/USDC\.e/gi, 'USDC');
}

// ── Simple/Advanced presentation (see web/lib/ui-mode.ts) ──
// PRESENTATION ONLY: 1 credit = 1 second of Join Stream at the room's rate.
// Same balances, same transactions underneath — nothing in the payment
// path reads this.
function roomIsFree() {
  return !!CONFIG && !(parseFloat(CONFIG.passkeyTickPrice || '1') > 0);
}
/**
 * Does THIS viewer ride free, whatever the room charges?
 *
 * roomIsFree() asks about the ROOM's price, which is the wrong question for a
 * whitelisted guest: the room is paid, they are not. Without this the guest was
 * still walked through a wallet connect and a chain switch before the request
 * was even sent — the server short-circuited on arrival and they ended up free,
 * so the promise held on the server and broke in front of the person.
 *
 * Server-derived from the sealed identity cookie (CONFIG.viewerRidesFree). It
 * only decides what UI to show; the seat is granted or refused server-side
 * either way, so believing it cannot buy a free seat.
 */
function viewerRidesFree() {
  return !!(CONFIG && (CONFIG as { viewerRidesFree?: boolean }).viewerRidesFree)
}
// Session mode (audit P1-1/P1-2): once a seat is held, the setup controls
// leave the screen — sign-in cluster, fund row, wallet info — and the
// username locks (editing it mid-session does nothing). All restored on leave.
function setSessionUi(inSession) {
  for (const id of ['connectBtn', 'depositBtn', 'walletInfo', 'passkeyFundNote']) {
    const el = document.getElementById(id);
    if (el) el.style.display = inSession ? 'none' : '';
  }
  const u = document.getElementById('username');
  if (u) { u.readOnly = inSession; u.style.opacity = inSession ? '0.6' : ''; }
  if (!inSession) renderWallet(); // re-apply the normal visibility rules
}

// FREE rooms say "no wallet needed" — so no wallet UI exists at all (audit
// P0-3): no sign-in cluster, no fund button, no balance line. Identity lives
// in the header pill. Paid rooms are untouched.
function applyFreeRoomUi() {
  if (!roomIsFree()) return;
  // meter included: a FREE room showing "Remaining 0.07 USDC.e" is a wallet
  // surface contradicting the room's one promise
  for (const id of ['connectBtn', 'depositBtn', 'walletInfo', 'passkeyFundNote']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  const meter = document.getElementById('meter');
  if (meter) meter.classList.remove('show');
}

// ─── Human-readable transaction errors (display only) ───────────────────────
// A failed join/MegaChat used to dump the full viem revert wall (error name,
// chain args, hex calldata). Known reverts render as ONE clean sentence in
// the viewer's own mode (credits vs USDC) with the fix attached; anything
// unknown gets a short generic line plus a collapsible "Technical details"
// expander carrying the raw error. Presentation only — the transaction logic
// underneath is untouched.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function txDetailsBlock(raw) {
  return (
    '<details class="tx-details"><summary>Technical details</summary>' +
    `<pre>${escapeHtml(raw)}</pre></details>`
  );
}

function trimAmt(n) {
  return String(parseFloat(Number(n).toFixed(6)));
}

// Best-effort parse of the amounts inside a TIP20 InsufficientBalance revert.
// viem prints custom errors as `InsufficientBalance(…decimal args…)`; the
// balance/needed pair are the trailing two integers, in the token's atomic
// units. Order is defensive — a revert means have < need, so swap if flipped.
function parseInsufficientAmounts(raw) {
  const s = String(raw);
  const at = s.search(/InsufficientBalance/i);
  if (at < 0) return null;
  // viem prints the SIGNATURE first — `InsufficientBalance(address sender,
  // uint256 balance, …)` — and the values in a later paren group. Only a
  // group made of bare values counts (no type keywords; "uint256" would
  // otherwise donate a bogus 256).
  const groups = [...s.slice(at).matchAll(/\(([^)]*)\)/g)].map((g) => g[1]);
  const valueGroup = groups.find(
    (g) => g.trim() && /^[\s,0-9xa-fA-F.]+$/.test(g.trim()) && /\d/.test(g),
  );
  if (!valueGroup) return null;
  // hex tokens are addresses — amounts arrive as plain decimals
  const nums = valueGroup.replace(/0x[0-9a-fA-F]+/g, ' ').match(/\d{1,30}/g) || [];
  if (nums.length < 2) return null;
  const dec = (CONFIG && CONFIG.paymentTokenDecimals) || 6;
  let have = Number(nums[nums.length - 2]) / 10 ** dec;
  let need = Number(nums[nums.length - 1]) / 10 ** dec;
  if (!isFinite(have) || !isFinite(need) || need <= 0) return null;
  if (have > need) { const t = have; have = need; need = t; }
  return { have, need };
}

// One short line for places that embed the reason inside another message
// (e.g. the tick-failure "leaving the stream" banner).
function shortTxReason(raw) {
  const s = String(raw || 'unknown error');
  if (/InsufficientBalance|insufficient balance|exceeds balance/i.test(s)) return 'Your balance ran out.';
  if (/user rejected|user denied|rejected the request/i.test(s)) return 'The wallet stopped approving payments.';
  const line = s.split('\n')[0];
  return line.length > 140 ? line.slice(0, 140) + '…' : line;
}

async function humanTxErrorHtml(err, ctx) {
  // Already written for a person, with its next step (joinRefusal).
  if (err && typeof err.html === 'string') return err.html;
  const raw = String((err && err.message) || err || 'Unknown error');
  const rawFull = String((err && (err.stack || err.message)) || err || 'Unknown error');
  // Short app-level errors (server rejections, our own throws) pass through
  // untouched — they were already written for humans.
  const looksRaw =
    /reverted|revert|0x[0-9a-f]{10,}|ContractFunction|InsufficientBalance|RpcRequestError/i.test(raw) ||
    raw.length > 220 || raw.includes('\n');
  if (!looksRaw) return escapeHtml(raw);

  if (/InsufficientBalance|insufficient balance|exceeds balance|transfer amount exceeds/i.test(rawFull)) {
    let amt = parseInsufficientAmounts(rawFull);
    if (!amt) {
      // Fall back to what the page already knows: live balance + this cost.
      let have = null;
      try {
        if (account) {
          const r = await fetch(`/api/balance/${account}?room=${encodeURIComponent(streamRoomId)}`);
          const d = await r.json();
          if (r.ok) have = parseFloat(d.available || d.spendable || '0');
        }
      } catch { /* balance display is best-effort */ }
      amt = { have, need: ctx && ctx.need != null ? parseFloat(ctx.need) : null };
    }
    const haveTxt = amt.have != null && isFinite(amt.have) ? formatDollars(trimAmt(amt.have)) : null;
    const needTxt = amt.need != null && isFinite(amt.need) ? formatDollars(trimAmt(amt.need)) : null;
    const line =
      haveTxt != null && needTxt != null
        ? `Not enough balance — you have ${haveTxt}, this costs ${needTxt}.`
        : 'Not enough balance for this.';
    // The funding steps then replace this line, in the same box.
    const where = ctx && MESSAGE_BOX[ctx.where] ? ctx.where : 'wallet';
    return `${line} <button type="button" class="tx-addfunds" onclick="fundWallet('${where}')">Add funds</button>`;
  }
  if (/user rejected|user denied|rejected the request/i.test(rawFull)) {
    return 'You cancelled the request in your wallet.';
  }
  return "The payment didn't go through. " + txDetailsBlock(rawFull);
}

async function showTxError(prefix, err, ctx) {
  const html = await humanTxErrorHtml(err, ctx);
  showMessage('❌ ' + (prefix ? prefix + ': ' : '') + html, 'error', ctx && ctx.where);
}

// An amount of what a refusal counts: earned points by name, dollars as
// dollars, any other token by its symbol.
function amountWithUnit(amount, symbol) {
  const sym = String(symbol || '');
  const n = trimAmt(amount);
  if (/^PTS$/i.test(sym)) return `${n} point${Number(n) === 1 ? '' : 's'}`;
  if (!sym || /^USDC(?:\.e)?$/i.test(sym)) return formatDollars(n);
  return `${n} ${sym}`;
}

// A refused seat says what happened and what to do next, never the bare
// reason code (owner's pick rw-raw-reason): the server's sentence (hint, then
// error), then the next step for the reasons a viewer can act on. The html
// rides the error to humanTxErrorHtml, which shows it as written.
function joinRefusal(data, fallback, detail = '') {
  const d = data || {};
  const said = String(d.hint || d.error || fallback) + detail;
  const stop = /[.!?]$/.test(said) ? '' : '.';
  let next = '';
  if (d.reason === 'no_seats_available') {
    next = 'All seats are taken. Try again when one frees up.';
  } else if (d.reason === 'insufficient_rewards' && d.available != null && d.needAtLeast != null) {
    next = `You have ${amountWithUnit(d.available, d.tokenSymbol)}; a seat needs ${amountWithUnit(d.needAtLeast, d.tokenSymbol)}.`;
  }
  const err = new Error(said);
  err.html = escapeHtml(said) + (next ? stop + ' ' + escapeHtml(next) : '');
  if (d.reason === 'sign_in_required') {
    err.html += ` <button type="button" class="tx-addfunds" onclick="connectPrivyWallet('seat')">Sign in</button>`;
  }
  return err;
}
let lastMeter = null;
function applyModeText() {
  const dep = document.getElementById('depositBtn');
  if (dep) dep.textContent = 'Add funds';
}

function joinStreamEnabled() {
  // Older servers don't send the block — treat absent as enabled.
  return !CONFIG || !CONFIG.joinStream || CONFIG.joinStream.enabled !== false;
}

// The days the send screen says a clip stays in the broadcast's replay — sent
// with the clip, and the server never keeps it longer (aired-clips.js). 0 until
// the room's config says otherwise: "plays once" is all the fan has been told.
let shownKeepDays = 0;

function updateReplayKeepNote() {
  const note = document.getElementById('letterKeepNote');
  const days = Number(CONFIG && CONFIG.letters && CONFIG.letters.replayKeepDays) || 0;
  shownKeepDays = note ? days : 0;
  if (note) note.textContent = days > 0 ? `, and stays in that stream’s replay for up to ${days} day${days === 1 ? '' : 's'}` : '';
}

// Simple mode counts in "credits": one credit is one tick of the meter, so its
// dollar price is the room's tick price (the same figure the ticks-left maths
// divides by). Referenced by the fund notes; it was never defined, so the
// join page threw a ReferenceError in simple mode with the wallet configured.
function perCreditUsd() {
  const tickPrice = parseFloat((CONFIG && (CONFIG.passkeyTickPrice || CONFIG.tickPrice)) || '0.001') || 0.001;
  return formatDollars(tickPrice).replace(/^\$/, '');
}

// Prices live on the buttons (owner's pick, 2026-11-08): no shared rate box.
// Both actions bill by the second; each button names its own rate.
function updatePriceDisplay() {
  if (!CONFIG) return;
  updateReplayKeepNote();
  initLetterUi();
  if (joinBtnState === 'idle') setJoinState('idle');
  const mc = CONFIG.letters && CONFIG.letters.enabled;
  if (!mc && !joinStreamEnabled()) showMessage('Nothing is enabled in this room right now.', 'error');
}

function roomPaused() {
  return !!CONFIG && CONFIG.roomActive === false;
}

// "Call in — $0.002/s · max $1": the seat's rate and the spend cap a call
// can reach, before anyone presses it.
// Plain text in every state (owner's pick vr-emoji-buttons): the button's one
// mark is Call in's dashed seat +, drawn by join.css, never an emoji.
function idleCallInLabel() {
  if (roomPaused()) return 'Call in — paused';
  if (!CONFIG || roomIsFree()) return 'Call in — FREE';
  const rate = Number(CONFIG.passkeyTickPrice || CONFIG.tickPrice) / (Number(CONFIG.passkeyTickSeconds) || 1);
  const cap = Number(CONFIG.maxSession);
  return `Call in — ${formatDollars(rate)}/s${cap > 0 ? ` · max ${formatDollars(cap)}` : ''}`;
}

// Hide the live-path controls entirely in MegaChats-only rooms.
function applyFeatureVisibility() {
  if (!CONFIG) return;
  const on = joinStreamEnabled();
  const joinBtn = document.getElementById('joinBtn');
  const action = document.getElementById('liveSeatAction');
  if (joinBtn) joinBtn.style.display = on ? '' : 'none';
  if (action) action.style.display = on ? '' : 'none';
  // "Every unused cent returns" says nothing where the seat costs nothing
  // (owner's pick vr-free-zero): a free room, or a guest on the free list.
  const trust = document.getElementById('seatTrustLine');
  if (trust) trust.hidden = roomIsFree() || viewerRidesFree();
}

function formatTimeLeft(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

// The held seat's own meter (null for a free seat), for the receipt on leave.
let seatMeter = null;

// The meter belongs to a held seat and to nothing else (owner's pick
// rw-earned-in-seat-meter): it opens on a seat's grant, and closes when the
// seat ends. The wallet's balance before a seat lives in the wallet line
// (renderWallet), and what watching earned in the rewards line.
function showMeter(remaining, spent, secondsLeft) {
  if (roomIsFree()) return; // free rooms have no balance to meter — ever
  if (!mySeatId) return;
  lastMeter = { remaining, spent, secondsLeft };
  seatMeter = { remaining, spent };
  const box = document.getElementById('meter');
  box.classList.add('show');
  document.getElementById('meterRemaining').textContent = formatDollars(remaining);
  document.getElementById('meterSpent').textContent = formatDollars(spent);
  document.getElementById('meterTime').textContent = formatTimeLeft(secondsLeft);
}

function hideMeter() {
  lastMeter = null;
  const box = document.getElementById('meter');
  if (box) box.classList.remove('show');
}

// ─── helpers ─────────────────────────────────────────────────────────────
function b64encode(obj) {
  const json = JSON.stringify(obj);
  // UTF-8 safe base64
  return btoa(unescape(encodeURIComponent(json)));
}
function strip0x(h) { return h.startsWith('0x') ? h.slice(2) : h; }
function pad32(hexNo0x) { return hexNo0x.toLowerCase().padStart(64, '0'); }
function encodeAddress(addr) { return pad32(strip0x(addr)); }
function encodeUint(value) { return pad32(BigInt(value).toString(16)); }


function ensureEthereum() {
  const eth = getProvider();
  if (!eth) {
    throw new Error('No wallet detected. Install MetaMask or open this page in a wallet browser.');
  }
  return eth;
}

// The entrance and exit, from the picker where the choice applies (owner's
// pick vr-stinger-after-button): 'seat' in the Call in camera stage, 'letter'
// in the Holler review step. One choice, shown in both places (syncStingers).
// Empty selection sends nothing → server stores null → overlay plays its
// defaults.
function stingerSelections(kind = 'seat') {
  const val = (id) => document.getElementById(id)?.value || undefined;
  return { flyIn: val(`${kind}FlyIn`), flyOut: val(`${kind}FlyOut`) };
}

function syncStingers(e) {
  const m = /^(seat|letter)(FlyIn|FlyOut)$/.exec((e.target && e.target.id) || '');
  if (!m) return;
  const other = document.getElementById(`${m[1] === 'seat' ? 'letter' : 'seat'}${m[2]}`);
  if (other) other.value = e.target.value;
}

function showStingers(kind, on) {
  const el = document.getElementById(`${kind}Stingers`);
  if (el) el.hidden = !on;
}

// Targeted reward campaign (/c/<slug> → Record your Holler / Call in): the
// slug rides every Holler send and seat join from this page, and the server
// counts it toward the signed-in account's claim (campaign-engine.js). It is
// only ever an id; the server decides whether it counts.
function campaignField() {
  try {
    const c = new URLSearchParams(location.search).get('campaign');
    return c && /^[a-z0-9][a-z0-9-]{2,39}$/.test(c) ? { campaign: c } : {};
  } catch { return {}; }
}

// The campaign banner: the first thing in the sidebar when the page was
// reached from /c/<slug>. It names the offer (title, reward, which action),
// hides the action the campaign does NOT pay for — a Holler campaign's
// visitor is here to record, not to call in, and the other way round — and
// states the room's own price when the room is paid, so the fan knows what
// they pay the room and what the campaign pays them. Read from the public
// campaign view; the server still decides whether the send counts.
async function mountCampaignBanner(slug) {
  const body = document.querySelector('.join-console-body');
  if (!body) return;
  const el = document.createElement('section');
  el.className = 'join-campaign-banner';
  el.setAttribute('aria-label', 'Campaign');
  Object.assign(el.style, { padding: '14px 16px', borderLeft: '3px solid var(--hl-strap-hi)', background: 'var(--mcj-sunk, var(--hl-panel-2))' });
  const offerLink = `<a href="/c/${encodeURIComponent(slug)}" style="color:var(--hl-strap-hi);font-weight:700;text-decoration:underline;text-underline-offset:3px">Back to the offer</a>`;
  let c = null;
  try {
    const r = await fetch(`/api/campaigns/${encodeURIComponent(slug)}`, { credentials: 'same-origin' });
    if (r.ok) c = (await r.json()).campaign || null;
  } catch { /* the page still works without it; the banner says so */ }
  if (!c || c.status !== 'live') {
    el.innerHTML =
      `<span class="join-coordinate">Campaign</span>` +
      `<p style="margin:6px 0 0;font-size:13px;line-height:1.5;color:var(--mcj-muted)">The campaign <strong>${escapeHtml(slug)}</strong> is not open right now, so nothing you send here counts toward it. ${offerLink}</p>`;
    body.prepend(el);
    return;
  }
  const kind = c.action && c.action.kind === 'callin' ? 'callin' : 'holler';
  const actionName = kind === 'callin' ? 'Call in' : 'Holler';
  // Money reads as "$5" for USDC (the symbol is implied); a custom token
  // keeps its symbol, the same rule as the campaign pages.
  const rewardAmount = String((c.reward && c.reward.amount) || '0');
  const rewardSymbol = String((c.reward && c.reward.symbol) || '');
  const reward = rewardSymbol === 'USDC' && Number.isFinite(Number(rewardAmount))
    ? escapeHtml(formatDollars(rewardAmount))
    : `${escapeHtml(rewardAmount)} ${escapeHtml(rewardSymbol)}`;
  // The action the campaign does not pay for leaves the sidebar.
  const other = document.getElementById(kind === 'holler' ? 'liveSeatAction' : 'megachatAction');
  if (other) other.style.display = 'none';
  // The room's own price, if there is one: what the fan pays the room.
  let priceLine = '';
  if (kind === 'holler') {
    const cfg = lettersCfg();
    if (cfg && parseFloat(cfg.price) > 0) priceLine = `Hollers here cost <strong>${formatDollars(letterRate(cfg))} a second</strong>; the campaign pays you <strong>${reward}</strong> once it counts.`;
    else priceLine = `Sending a Holler here is free; the campaign pays you <strong>${reward}</strong> once it counts.`;
  } else if (!roomIsFree()) {
    const tickPrice = (CONFIG && (CONFIG.passkeyTickPrice || CONFIG.tickPrice)) || '0';
    const tickSec = (CONFIG && CONFIG.passkeyTickSeconds) || 1;
    priceLine = `This room charges <strong>${formatDollars(Number(tickPrice) / tickSec)}</strong> per second on camera; the campaign pays you <strong>${reward}</strong> once it counts.`;
  } else {
    priceLine = `Calling in here is free; the campaign pays you <strong>${reward}</strong> once it counts.`;
  }
  const hue = kind === 'holler' ? 'var(--f-holler-ui)' : 'var(--f-callin-ui)';
  const ink = kind === 'holler' ? 'var(--f-holler-ink)' : 'var(--f-callin-ink)';
  const bg = kind === 'holler' ? 'var(--f-holler-bg)' : 'var(--f-callin-bg)';
  el.style.borderLeftColor = hue;
  el.style.background = `linear-gradient(90deg, ${bg} 0, transparent 75%), var(--mcj-sunk, var(--hl-panel-2))`;
  // When it counts, in the campaign's own terms (action.require, and the
  // minimum seconds for a Call in), read from the public view. Signing in
  // is not what makes it count; the stream is.
  const require = String((c.action && c.action.require) || 'aired');
  const minSeconds = Math.max(1, Math.floor(Number(c.action && c.action.minSeconds) || 60));
  const countsLine = kind === 'callin'
    ? (require === 'joined' ? 'It counts once your camera is live on the stream.' : `It counts after ${minSeconds} seconds on camera.`)
    : (require === 'approved' ? 'It counts once the streamer clears it.' : 'It counts when it plays on the stream.');
  el.innerHTML =
    `<span class="join-coordinate" style="color:${ink}">${actionName} campaign</span>` +
    `<strong style="display:block;margin-top:6px;font-size:15px;line-height:1.3;color:var(--mcj-fg)">${escapeHtml(String(c.title || slug))}</strong>` +
    `<p style="margin:6px 0 0;font-size:13px;line-height:1.5;color:var(--mcj-muted)"><strong style="color:var(--f-bounty-ink);font-size:16px">${reward}</strong> for a ${actionName} on this stream. ${priceLine}</p>` +
    `<p style="margin:8px 0 0;font-size:12.5px;line-height:1.5;color:var(--mcj-faint, var(--hl-dim))">${countsLine} ${offerLink}</p>`;
  body.prepend(el);
}

// ─── Join button state machine ────────────────────────────────────────────
// ONE button morphs through the whole flow (no separate Go Live button):
//   idle → busy (connect/authorize) → awaiting-camera → go-live → going-live → live
// going-live: GO LIVE was pressed and the server has not confirmed it yet.
// Click routing lives in the joinBtn handler; every transition goes through
// setJoinState so no code path can leave the label out of sync again.
let joinBtnState = 'idle';

// ONE state-morphing control (audit P0-1): no disabled dead-ends. The
// camera wait can be cancelled, and while live the same button IS the
// leave action — there is no sibling Leave button anymore.
const JOIN_BTN_STATES = {
  idle: { label: 'Call in', disabled: false },
  busy: { label: 'Processing…', disabled: true },
  'awaiting-camera': { label: 'Waiting for camera — tap to cancel', disabled: false },
  'go-live': { label: 'Go Live', disabled: false },
  'going-live': { label: 'Going live — tap to cancel', disabled: false },
  live: { label: "You're LIVE — tap to leave", disabled: false },
};

function setJoinState(state, labelOverride) {
  const preset = JOIN_BTN_STATES[state] || JOIN_BTN_STATES.idle;
  joinBtnState = JOIN_BTN_STATES[state] ? state : 'idle';
  const btn = document.getElementById('joinBtn');
  if (!btn) return;
  btn.textContent = labelOverride || (joinBtnState === 'idle' ? idleCallInLabel() : preset.label);
  btn.disabled = preset.disabled
    || (joinBtnState === 'idle' && CONFIG && CONFIG.roomActive === false);
  // The entrance and exit apply until Go Live is pressed: the picker shows
  // from the seat's grant to that press, and not before or after.
  showStingers('seat', joinBtnState === 'awaiting-camera' || joinBtnState === 'go-live');
  // The camera attached: Go Live is the next press, so it must be on screen.
  if (joinBtnState === 'go-live') revealSeatCam();
}

// Lazy connect: the overlay sits disconnected while idle, so it needs the
// EARLIEST credible signal that a guest is coming — this is the FIRST "Join
// Stream" click, before wallet-connect and before payment (there is no
// separate join-sheet/modal step in this UI to hook instead). The handshake
// then runs in parallel with the payment flow (which is far slower), so the
// overlay is connected and waiting before the guest's tracks exist and the
// audience sees no difference. Fire-and-forget: a failed prewarm must never
// block a join, and an abandoned attempt expires on its own TTL server-side
// — see the abandonment-cost note in HANDOFF-LAZY-CONNECT.md (pinned,
// unresolved): today that TTL is prewarmTtlMs (5 min), not the 60s grace,
// so a high wallet-flow drop-off rate is more expensive than the happy-path
// math implies.
let prewarmToken: string | null = null;
function prewarmOverlay() {
  fetch('/api/livekit/prewarm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: streamRoomId }),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return;
      if (d.prewarm) prewarmToken = d.prewarm;
      // Reliability guard: lazy connect's new failure mode is "guest pays,
      // overlay never woke, nobody appears on stream" — a refund event on a
      // live broadcast. Warn BEFORE the money moves rather than blocking,
      // since a false negative here would kill a legitimate join.
      const h = d.health;
      if (h && !h.present) {
        showMessage(
          "<strong>Heads up:</strong> this streamer's overlay isn't open right now, so your camera may not appear on their broadcast. " +
          "You can still join — you're only charged for the seconds you're actually on.",
          'warning',
          'seat',
        );
      }
    })
    .catch(() => { /* overlay wake is best-effort; the seat grant wakes it too */ });
}
export function releasePrewarm() {
  if (!prewarmToken) return;
  const body = JSON.stringify({ room: streamRoomId, prewarm: prewarmToken });
  prewarmToken = null;
  // sendBeacon survives page teardown; fetch does not. This is the tab-close
  // path, and it is exactly the path the old code never had — which is why an
  // abandoned prewarm used to ride the full 5-minute TTL.
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    try { navigator.sendBeacon('/api/livekit/prewarm/cancel', body); return; } catch { /* fall through */ }
  }
  fetch('/api/livekit/prewarm/cancel', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true,
  }).catch(() => { /* the abandon cap cleans it up anyway */ });
}

/**
 * Tell the server the guest is still moving forward, which restarts the
 * abandon clock. Called at each real step of the join flow so a slow human in
 * a wallet dialog is never mistaken for someone who walked away.
 */
export function prewarmProgress(stage) {
  if (!prewarmToken) return;
  fetch('/api/livekit/prewarm/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: streamRoomId, prewarm: prewarmToken, stage }),
    keepalive: true,
  }).catch(() => { /* best effort; the cap is the backstop */ });
}

// Bail paths a leaving user actually takes. leaveStream() covers the polite
// exit; these cover the rest.
if (typeof window !== 'undefined') {
  const bail = () => releasePrewarm();
  window.addEventListener('pagehide', bail);
  window.addEventListener('beforeunload', bail);
  // Backgrounding a tab is NOT abandonment (people tab away mid-wallet), so
  // visibilitychange deliberately does not release — the abandon cap handles
  // someone who backgrounds and never returns.
}

function onJoinButtonClick() {
  if (joinBtnState === 'go-live') return goLive();
  if (joinBtnState === 'idle') { prewarmOverlay(); return joinSeat(); }
  // The same control exits the flow: cancel a hung camera wait, or leave
  // the stream while live (audit P0-1 — no dead-ends, no button pairs).
  if (joinBtnState === 'awaiting-camera' || joinBtnState === 'going-live' || joinBtnState === 'live') {
    return leaveStream();
  }
  // busy: disabled — ignore stray clicks.
}

// `where`: the message box under the control that asked (showMessage).
async function connectMetaMask(where) {
  walletMode = 'metamask';
  return connectWallet(where);
}

/** The window bridge installed by components/providers/tempo-wallet.tsx. */
function getMegaWallet() {
  return (typeof window !== 'undefined' && window.MegaWallet) || null;
}

/** EIP-1193 provider for the ACTIVE wallet mode (Privy embedded or MetaMask). */
async function getActiveProvider() {
  if (walletMode === 'privy') {
    const MW = getMegaWallet();
    if (!MW || !MW.configured) throw new Error('Privy wallet not available');
    return MW.getProvider();
  }
  return ensureEthereum();
}

/**
 * Privy embedded wallet connect (email / social / passkey — one modal covers
 * both new and returning users). There is no sign-in button on this page any
 * more: the paid actions (Send, Call in, Add funds) call this the moment they
 * need an account, and `where` puts the outcome under that control.
 */
async function connectPrivyWallet(where) {
  const MW = getMegaWallet();
  if (!MW) {
    // The bridge appears once the room config arrives (tempo-wallet.tsx); a
    // tap before then is early, not a server without sign-in.
    showMessage('Sign-in is still loading. Wait a moment, then retry.', 'error', where);
    return null;
  }
  if (!MW.configured) {
    showMessage(
      'Privy sign-in is not configured on this server yet (set NEXT_PUBLIC_PRIVY_APP_ID in .env and restart). MetaMask still works below.',
      'error',
      where
    );
    return null;
  }
  try {
    walletMode = 'privy';
    updatePriceDisplay();
    account = null; // clear any stale MetaMask address
    walletBalance = null;

    const addr = await MW.connect();
    account = addr;
    renderWallet();
    window.dispatchEvent(new CustomEvent('wallet:connected', { detail: { account } }));
    await refreshBalance();
    showMessage('✅ Signed in — wallet ready on Tempo.', 'success', where);
    return account;
  } catch (err) {
    walletMode = null;
    account = null;
    console.error('[privy]', err);
    showMessage('❌ ' + ((err && err.message) || 'Sign-in failed'), 'error', where);
    renderWallet();
    return null;
  }
}

async function connectWallet(where) {
  try {
    const eth = ensureEthereum();
    // First account read happens HERE — only after an explicit Connect.
    const accounts = await eth.request({ method: 'eth_requestAccounts' });
    if (!accounts || !accounts.length) {
      showMessage('🔒 Wallet is locked or no account is shared. Unlock MetaMask and try again.', 'error', where);
      return null;
    }
    if (accounts[0] !== account) walletBalance = null;
    account = accounts[0];
    walletMode = 'metamask';
    watchWalletAccount(eth);
    await ensureTempoChain();
    renderWallet();
    // Let the isolated watch-to-earn module know which wallet to credit.
    window.dispatchEvent(new CustomEvent('wallet:connected', { detail: { account } }));
    refreshBalance();
    return account;
  } catch (err) {
    const msg = err && err.code === 4001
      ? 'Connection request rejected in your wallet.'
      : (err && err.message) || 'Wallet connection failed';
    showMessage('❌ ' + msg, 'error', where);
    return null;
  }
}

// Add / switch MetaMask to Tempo mainnet (chainId 0x1079 = 4217). Privy
// embedded wallets are created on Tempo already — this is MetaMask-only.
async function ensureTempoChain() {
  if (walletMode === 'privy') return; // embedded wallet lives on Tempo
  const eth = getProvider();
  if (!eth) {
    throw new Error('No wallet detected. Install MetaMask or open this page in a wallet browser.');
  }
  if (!account) {
    throw new Error('Connect your wallet first.');
  }
  if (!CONFIG) {
    try { await loadConfig(); } catch { /* handled below */ }
  }
  if (!CONFIG || !CONFIG.chainIdHex) {
    throw new Error('Network config not loaded yet — please try again in a moment.');
  }
  const hexChainId = CONFIG.chainIdHex; // 0x1079
  try {
    await eth.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexChainId }]
    });
  } catch (switchErr) {
    // 4902 = chain not added yet — add it, then it becomes current.
    if (switchErr.code === 4902 || /Unrecognized chain/i.test(switchErr.message || '')) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: hexChainId,
          chainName: CONFIG.chainName || 'Tempo',
          // Tempo has no native gas token (fees come out of stablecoins);
          // MetaMask hard-requires decimals 18 here, display-only.
          nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
          rpcUrls: [CONFIG.rpcUrl],
          blockExplorerUrls: [CONFIG.explorerUrl]
        }]
      });
    } else {
      throw switchErr;
    }
  }
}

// Copy helper with a plain-http fallback: Privy needs a secure origin, but
// MetaMask can run on http where navigator.clipboard is unavailable — fall
// back to a hidden textarea + execCommand there.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Clickable, abbreviated address chip that copies the FULL value. The cut
// (shortAddr, display-format.ts) keeps the connected line from wrapping; the
// full address stays in the title tooltip and the copy.
function addrChip(address) {
  const full = String(address || '');
  return (
    `<button type="button" class="addr-copy" data-copy="${full}" ` +
    `title="Copy full address · ${full}" aria-label="Copy full address ${full}">` +
    `<span class="addr">${shortAddr(full)}</span>` +
    `<span class="addr-copy-icon" aria-hidden="true">⧉</span>` +
    `</button>`
  );
}

// Delegated on #walletInfo AND #message (the Add funds message carries the
// same chip, and in Simple mode it is the only one on screen), so it survives
// the innerHTML rerenders of both (audit web-17).
function onAddrCopyClick(e) {
  const btn = e.target.closest && e.target.closest('.addr-copy');
  if (!btn) return;
  const full = btn.getAttribute('data-copy');
  if (!full) return;
  copyText(full).then((ok) => {
    const icon = btn.querySelector('.addr-copy-icon');
    if (!icon) return;
    if (ok) {
      btn.classList.add('copied');
      icon.textContent = '✓';
      setTimeout(() => {
        btn.classList.remove('copied');
        icon.textContent = '⧉';
      }, 1500);
    }
  });
}

function renderWallet() {
  const info = document.getElementById('walletInfo');
  const connectBtn = document.getElementById('connectBtn');
  const fundNote = document.getElementById('passkeyFundNote');
  const dep = document.getElementById('depositBtn');
  const join = document.getElementById('joinBtn');
  if (!info || !connectBtn) return;

  if (roomIsFree()) { applyFreeRoomUi(); return; }

  // The wallet's balance before a seat, here in the wallet line: the seat
  // meter no longer opens to show it (owner's pick rw-earned-in-seat-meter).
  const bal = walletBalance != null ? ` · balance ${formatDollars(walletBalance)}` : '';

  if (account && walletMode === 'privy') {
    // Connected — the paths not taken LEAVE the screen (no dulled clutter):
    // MetaMask row gone, Fund takes the row.
    connectBtn.style.display = 'none';
    if (dep) dep.style.gridColumn = '1 / -1';
    info.innerHTML =
      `<span class="adv-only">Connected · ${addrChip(account)} <span class="net-chip">${tokenSymbol()} · Tempo</span>${bal}</span>` +
      `<span class="simple-only">Signed in${bal || ' — your balance is ready'}.<br>` +
      `<details class="addr-details"><summary>account details</summary>` +
      `Account address (tap to copy): ${addrChip(account)}</details></span>`;
    if (fundNote) {
      fundNote.style.display = 'block';
      fundNote.classList.add('simple-only');
      fundNote.innerHTML =
        '<span class="simple-only">Add funds any time — 1 credit costs $' +
        String(perCreditUsd()) + '. Your account details are just above.</span>';
    }
    if (dep) { dep.style.display = ''; dep.disabled = false; }
    if (join && joinBtnState === 'idle') setJoinState('idle');
    return;
  }

  if (fundNote) fundNote.style.display = 'none';
  // MetaMask is offered only where one is installed (owner's pick, both
  // modes): no "No injected wallet" line and no disabled fox button for the
  // many who have none. Add funds takes the row alone then.
  connectBtn.style.display = hasWallet ? '' : 'none';
  if (dep) { dep.style.display = ''; dep.style.gridColumn = hasWallet ? '' : '1 / -1'; }

  if (account && walletMode === 'metamask') {
    // The MetaMask chip stays as the one connected-state indicator.
    connectBtn.textContent = 'MetaMask connected';
    connectBtn.disabled = true;
    info.innerHTML =
      `<span class="adv-only">Connected · Wallet: ${addrChip(account)}${bal}<br>Network: Tempo (MetaMask)</span>` +
      `<span class="simple-only">Signed in${bal || ' — your balance is ready'}.<br>` +
      `<details class="addr-details"><summary>account details</summary>` +
      `Account address (tap to copy): ${addrChip(account)}</details></span>`;
    if (dep) dep.disabled = false;
    if (join && joinBtnState === 'idle') setJoinState('idle');
    return;
  }

  const MW = getMegaWallet();
  const privyReady = !!(MW && MW.configured);
  connectBtn.disabled = false;
  connectBtn.textContent = 'Connect MetaMask';
  info.textContent = '';
  // Fund shows the connected address; useless before any wallet exists.
  if (dep) dep.disabled = !hasWallet && !privyReady;
  // Join stays enabled while disconnected — clicking it runs the Privy sign-in
  // (the primary path). The state machine owns it outside idle.
  if (join && joinBtnState === 'idle') setJoinState('idle');
}

// Read the wallet's on-chain balance on Tempo, for the wallet line.
let walletBalance = null;
async function refreshBalance() {
  if (!account || mySeatId) return;
  const asked = account;
  try {
    const res = await fetch(`/api/balance/${account}?room=${encodeURIComponent(streamRoomId)}`);
    const data = await res.json();
    if (!res.ok || asked !== account) return;
    walletBalance = data.available != null ? data.available : null;
    renderWallet();
  } catch (e) {
    console.warn('balance refresh failed', e);
  }
}

async function waitForTx(hash, provider) {
  const eth = provider || await getActiveProvider();
  for (let i = 0; i < 60; i++) {
    const receipt = await eth.request({
      method: 'eth_getTransactionReceipt',
      params: [hash]
    });
    if (receipt) return receipt;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Timed out waiting for transaction ' + hash);
}

// "Fund wallet": there is no Gateway deposit on Tempo — funding is a plain
// TIP-20 transfer to the connected address. Show it, copy it, link explorer.
// `whereArg`: the box to answer in — the Add funds button inside an error
// passes its own; the wallet row's button (a click event) answers under itself.
async function fundWallet(whereArg) {
  const where = typeof whereArg === 'string' ? whereArg : 'wallet';
  if (!account) {
    const MW = getMegaWallet();
    if (MW && MW.configured) await connectPrivyWallet(where);
    else await connectMetaMask(where);
  }
  if (!account) return;
  showMessage(
    `<span class="adv-only">💧 Send <strong>${tokenSymbol()}</strong> on <strong>Tempo</strong> to ${addrChip(account)}<br>` +
    `<a class="addr" href="${CONFIG.explorerUrl}/address/${account}" target="_blank" rel="noopener">View on explorer</a></span>` +
    `<span class="simple-only">➕ Add funds by sending money to your account: ${addrChip(account)}<br>` +
    `1 credit costs $${perCreditUsd()} in this room.</span>` +
    `<p style="margin-top:10px;font-size:0.85rem;">Balance updates automatically once the transfer lands.</p>`,
    'success',
    where
  );
  refreshBalance();
  for (const delay of [5000, 12000]) setTimeout(refreshBalance, delay);
}

// ─── MPP session meter (primary path, Privy embedded wallets) ─────────────
// The seat is granted instantly; the escrow channel opens on the FIRST paid
// tick after the camera goes live (one silent wallet transaction), then every
// tick is a signed off-chain voucher. Leave closes the channel and the
// unspent deposit returns to the viewer from escrow.
let mppSession = null;
let mppTickTimer = null;
let mppInFlight = false;
let mppFailures = 0;

// Wallet providers are trustworthy SIGNERS but not trustworthy RPCs: Privy's
// embedded provider proxies reads through its own infrastructure, which does
// not speak Tempo — eth_call against the channel precompile returned '0x'
// ("Cannot convert 0x to a BigInt") and killed every embedded-wallet session.
// So: signing/broadcast stays on the wallet, every read goes to the public
// Tempo RPC. (Privy sends work fine on Tempo — proven by its own send UI.)
const WALLET_ONLY_METHODS = new Set([
  'eth_sendTransaction',
  'eth_signTransaction',
  'personal_sign',
  'eth_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'eth_accounts',
  'eth_requestAccounts',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
]);

// Build a fresh mppx session manager over the hybrid transport. Shared by
// the seat meter (ensureMppSession) and one-shot letter payments — the
// transport/preflight logic is IDENTICAL, only maxDeposit differs.
async function buildMppManager(maxDeposit) {
  const provider = await getActiveProvider();
  const viem = await import('viem');
  const { tempo } = await import('viem/chains');

  // Preflight: the SIGNER must be on Tempo (reads below are pinned to the
  // public RPC regardless). Fail with a human error, not a viem stack trace.
  const expectHex = '0x' + tempo.id.toString(16);
  const walletChain = await provider.request({ method: 'eth_chainId' }).catch(() => null);
  if (walletChain && parseInt(walletChain, 16) !== tempo.id) {
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: expectHex }],
      });
    } catch {
      throw new Error(
        `Wallet is on chain ${parseInt(walletChain, 16)} instead of Tempo (${tempo.id}) — reconnect your wallet and try again.`
      );
    }
  }

  const rpcUrl = (CONFIG && CONFIG.rpcUrl) || tempo.rpcUrls.default.http[0];
  const readClient = viem.createPublicClient({ chain: tempo, transport: viem.http(rpcUrl) });
  // mppx broadcasts via the Tempo-idiomatic triplet: eth_fillTransaction
  // (node fills nonce/gas/fees — public RPC), eth_signTransaction (wallet),
  // eth_sendRawTransaction (public RPC). The fill returns a Tempo type-0x76
  // batch envelope whose empty fields come back as bare "0x" — embedded
  // wallet parsers do BigInt("0x") and die ("Cannot convert 0x to a BigInt",
  // the exact error that kicked every embedded viewer seconds after going
  // live). Retry with a normalized envelope ("0x" → "0x0"). NO further
  // fallback: Tempo has no native token (plain eip1559 can't pay fees), and
  // letting the wallet SEND instead of sign strands the deposit — mppx
  // derives its channel bookkeeping from the raw bytes (gate-proven: a
  // wallet-broadcast open landed on-chain but the session never recognized
  // it). Failing clean before any funds move is the only safe behavior.
  const normalizeTempoTx = (tx) => {
    const fix = (v) => (v === '0x' ? '0x0' : v);
    const out = { ...tx };
    for (const k of ['value', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce']) {
      if (out[k] !== undefined) out[k] = fix(out[k]);
    }
    if (Array.isArray(out.calls)) {
      out.calls = out.calls.map((c) => (c && typeof c === 'object' ? { ...c, value: fix(c.value) } : c));
    }
    return out;
  };
  const client = viem.createWalletClient({
    account,
    chain: tempo,
    transport: viem.custom({
      async request(args) {
        if (args.method === 'eth_signTransaction') {
          const [tx] = args.params || [];
          try {
            return await provider.request(args);
          } catch (errRaw) {
            const norm = normalizeTempoTx(tx || {});
            try {
              return await provider.request({ method: 'eth_signTransaction', params: [norm] });
            } catch (errNorm) {
              console.warn('[mpp] wallet cannot sign the Tempo envelope:', errNorm?.message || errNorm);
              throw new Error(
                'This wallet cannot sign Tempo channel transactions — connect MetaMask (or another Tempo-compatible wallet) to join.'
              );
            }
          }
        }
        if (WALLET_ONLY_METHODS.has(args.method)) return provider.request(args);
        return readClient.request(args);
      },
    }),
  });
  const mpp = await import('mppx/client');
  return mpp.tempo.session.manager({
    client,
    account,
    maxDeposit: String(maxDeposit),
    decimals: (CONFIG && CONFIG.paymentTokenDecimals) || 6,
  });
}

async function ensureMppSession(sessionCap) {
  if (mppSession) return mppSession;
  mppSession = await buildMppManager(sessionCap);
  return mppSession;
}

function startMppTicks(data) {
  // Free seats have no tickUrl — nothing to bill, nothing to strike out on.
  if (!data || !data.tickUrl) return;
  stopMppTicks(false);
  const interval = (data.tickSeconds || 1) * 1000;
  // Transient blips must not nuke the seat: keep retrying for ~12s of
  // consecutive failures (the server tolerates 20s without a paid tick)
  // before giving up.
  const maxStrikes = Math.max(3, Math.ceil(12000 / interval));
  mppFailures = 0;
  mppTickTimer = setInterval(async () => {
    if (mppInFlight || !mySeatId) return;
    // LiveKit rooms: while the transport is reconnecting, SKIP ticks
    // entirely — no vouchers means no charges for dead air, and no failure
    // strikes either. The seat survives on the server's grace window; ticks
    // resume the moment the room is connected again.
    if (isLivekitRoom() && lkRoom && lkRoom.state !== 'connected') {
      const t = document.getElementById('meterTime');
      if (t) t.textContent = '⏸ paused';
      return;
    }
    mppInFlight = true;
    try {
      const session = await ensureMppSession(data.sessionCap);
      const resp = await session.fetch(data.tickUrl, { method: 'POST' });
      if (!resp.ok) throw new Error(`tick rejected (${resp.status})`);
      mppFailures = 0;
    } catch (err) {
      mppFailures += 1;
      console.warn(`[mpp] tick failed (${mppFailures}/${maxStrikes})`, err);
      if (mppFailures >= maxStrikes) {
        // quiet leave: THIS message is the notification — leaveStream must
        // not paper over it with the friendly "you left" line. Reason is
        // humanized; the raw error stays available in the expander.
        showMessage(
          '❌ Payment stream failed — leaving the stream.<br>' +
          `<span style="font-size:0.85em;opacity:0.85">${escapeHtml(shortTxReason(err?.message))}</span>` +
          txDetailsBlock(String(err?.stack || err?.message || 'unknown error')),
          'error',
          'seat'
        );
        leaveStream(true);
      }
    } finally {
      mppInFlight = false;
    }
  }, interval);
}

function stopMppTicks(closeChannel) {
  if (mppTickTimer) {
    clearInterval(mppTickTimer);
    mppTickTimer = null;
  }
  if (closeChannel && mppSession) {
    const session = mppSession;
    mppSession = null;
    // Cooperative close: settles the streamed amount and refunds the unspent
    // deposit from escrow. If it races a server-side settle (kick), the
    // channel is already closed — ignore.
    session.close().then((receipt) => {
      if (receipt && receipt.txHash) {
        console.log('[mpp] channel closed, settlement tx', receipt.txHash);
      }
    }).catch((err) => console.warn('[mpp] close skipped:', err?.message || err));
  } else if (!closeChannel) {
    mppSession = null;
  }
}

async function joinSeatMpp(username) {
  setJoinState('busy', 'Requesting session terms…');
  const r = await fetch('/api/join/mpp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, address: account, room: streamRoomId, ...stingerSelections(), ...campaignField() })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = data.available != null && data.reason !== 'insufficient_rewards'
      ? ` (available ${formatDollars(data.available)})`
      : '';
    throw joinRefusal(data, 'Cannot join', detail);
  }
  onJoinSuccess(data);
}

// Unified metered join (fallback: MetaMask + servers without the MPP meter):
// fetch session terms, authorize the session cap with ONE approve, then the
// server pulls per tick via transferFrom.
async function joinSeatMetered(username, { retry = false } = {}) {
  const SEL_APPROVE = '0x095ea7b3'; // approve(address,uint256)

  setJoinState('busy', 'Requesting session terms…');
  const first = await fetch('/api/join/passkey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, address: account, room: streamRoomId, ...stingerSelections(), ...campaignField() })
  });

  const terms = await first.json().catch(() => ({}));
  if (!first.ok) {
    const detail = terms.available != null && terms.reason !== 'insufficient_rewards'
      ? ` (available ${formatDollars(terms.available)})`
      : '';
    throw joinRefusal(terms, 'Cannot join', detail);
  }
  if (terms.useRewardCredit) {
    setJoinState('busy', 'Joining with earned balance…');
    const paid = await fetch('/api/join/passkey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        address: account,
        room: streamRoomId,
        useRewardCredit: true,
        ...campaignField(),
      }),
    });
    const data = await paid.json().catch(() => ({}));
    if (paid.ok && data.success) {
      onJoinSuccess(data);
    } else {
      throw joinRefusal(data, 'Reward join was not accepted');
    }
    return;
  }
  if (!terms.needsApprove) {
    throw new Error('Unexpected join response');
  }

  setJoinState('busy', walletMode === 'privy'
    ? 'Authorizing session…'
    : 'Approve in MetaMask…');
  const eth = await getActiveProvider();
  const approveData = SEL_APPROVE +
    encodeAddress(terms.payTo) + encodeUint(BigInt(terms.sessionAmountAtomic));
  const approveTx = await eth.request({
    method: 'eth_sendTransaction',
    params: [{ from: account, to: terms.paymentTokenAddress, data: approveData }]
  });
  await waitForTx(approveTx, eth);

  const payment = {
    type: 'approve',
    txHash: approveTx,
    payer: account,
    amount: terms.sessionAmountAtomic,
    seller: terms.payTo,
    tokenAddress: terms.paymentTokenAddress,
  };

  setJoinState('busy', 'Confirming seat…');
  prewarmProgress('tx-pending');
  const paid = await fetch('/api/join/passkey', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Modular-Payment': b64encode(payment)
    },
    body: JSON.stringify({ username, address: account, room: streamRoomId, ...stingerSelections(), ...campaignField() })
  });
  const data = await paid.json().catch(() => ({}));
  if (paid.ok && data.success) {
    onJoinSuccess(data);
  } else if (!retry && data.retry === 'direct') {
    // SESSION 2 — the seat escrow could not take the deposit (chain refused or
    // unreachable). Nothing moved. Fetch terms again: they now name the seller
    // key as spender, and the viewer pays the streamer directly per tick.
    setJoinState('busy', 'Escrow unavailable — paying the streamer directly…');
    await joinSeatMetered(username, { retry: true });
  } else {
    throw joinRefusal(data, 'Join was not accepted');
  }
}

async function joinSeat() {
  const username = document.getElementById('username').value.trim();

  if (!username) {
    showMessage('Please enter a username', 'error', 'seat');
    return;
  }
  if (joinBtnState !== 'idle') return;

  // Clear the previous attempt's result — a stale error next to a freshly
  // spinning button reads as an instant failure.
  clearMessage('seat');

  setJoinState('busy');

  try {
    // Privy is the PRIMARY path: an unconnected click runs the sign-in modal
    // right here, shows the connected state, then continues straight into the
    // seat authorization. MetaMask users connect via the secondary button
    // first, which sets walletMode below.
    if (roomIsFree() || viewerRidesFree()) {
      // Free room, or a guest on the streamer's list: no wallet, no chain, no
      // session — straight to the seat.
      await joinSeatMpp(username);
      return;
    }
    if (!account) {
      // "Connecting your balance", not "signing in" — a Twitch/X-signed-in
      // viewer IS signed in; this step is about money, and saying "sign in"
      // twice made the two look broken.
      setJoinState('busy', 'Connecting your balance…');
      prewarmProgress('wallet-connect'); // slow wallet UI must not read as abandonment
      const addr = await connectPrivyWallet('seat');
      if (!addr) {
        // Wallet dismissed/rejected — a real bail path. Release now rather
        // than making the overlay wait out the abandon cap.
        releasePrewarm();
        setJoinState('idle');
        return;
      }
      prewarmProgress('wallet-approve');
    }

    await ensureTempoChain();
    if (walletMode === 'privy' && CONFIG && CONFIG.meterMode === 'mpp_session') {
      // Primary: MPP session (TIP-1034 channel) — cap authorized once,
      // per-second signed vouchers, unspent auto-refunds on close.
      await joinSeatMpp(username);
    } else {
      // MetaMask (per-voucher popups would be unusable) and servers without
      // the MPP meter use the proven allowance flow.
      await joinSeatMetered(username);
    }
  } catch (error) {
    console.error('Error:', error);
    // A failed/rejected join is a bail path: the guest is not arriving, so
    // stop holding the overlay connection open for them.
    releasePrewarm();
    // Joining reserves the session cap — that's the "cost" a viewer must
    // cover when the revert says their balance can't.
    await showTxError('', error, { need: CONFIG && CONFIG.maxSession, where: 'seat' });
  } finally {
    // Success hands the button to the camera states (awaiting-camera →
    // go-live → live); only reset to idle when no seat was granted.
    if (!mySeatId) setJoinState('idle');
  }
}

// ─── Inline camera-publish stage ────────────────────────────────────────
// Vdo.ninja's official IFRAME API — the full notes lived in the retired
// public/index.html (deleted 2026-09-17); see git history for them.
const VDO_ORIGIN = 'https://vdo.ninja';
let lastJoinData = null;
let cameraLiveFired = false;
let camFallbackTimer = null;
let camErrorTimer = null;
let camMsgBound = false;

// GO LIVE is a request; the seat is live when the SERVER says so. serverLive
// is that answer for this seat: seat_added naming it, or initial_state listing
// it after a (re)subscribe. Until it arrives nothing bills and nothing says
// LIVE. A GO LIVE pressed while the socket was down used to be lost for good,
// while the page said "You're LIVE", an MPP seat paid every tick, and the
// overlay never drew the guest until the 5-minute camera timeout (audit web-2).
let serverLive = false;
// This camera stage is showing live (UI, meter, LiveKit publish). Separate
// from serverLive: a stage rebuilt after a camera failure starts un-live on a
// seat the server already has live.
let stageLive = false;
let liveAskTimer = null;
const LIVE_ASK_RETRY_MS = 5000;

// A seat message on the control socket. Returns whether it went out.
function sendSeat(type, extra = {}) {
  if (!mySeatId || !ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify({ ...extra, type, seatId: mySeatId, seatToken: mySeatToken }));
  return true;
}

// A seat-scoped POST: the id and its token ride every one.
function seatPost(url, body, init = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, seatToken: mySeatToken }),
    ...init,
  });
}

// When this seat first went live (0: not yet), for the receipt on leave.
let seatLiveSince = 0;

// The camera frame with Go Live on its edge, brought on screen: on grant, and
// again when the camera attaches and the button becomes Go Live.
function revealSeatCam() {
  const el = document.getElementById('seatCam');
  if (!el || typeof el.scrollIntoView !== 'function') return;
  const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' }));
}

function onJoinSuccess(data) {
  mySeatId = data.seatId;
  mySeatToken = data.seatToken || null;
  lastJoinData = data;
  serverLive = false;
  stageLive = false;
  seatMeter = null;
  seatLiveSince = 0;
  // Bind this WS to the seat so closing the tab instantly frees + refunds it.
  sendSeat('register_seat');
  setSessionUi(true);
  if (!data.free) showMeter(data.remaining, '0', data.secondsLeft);
  prewarmProgress('seat-granted');
  if (data.free) {
    showMessage("You're set. It's free once you go live.", 'success', 'seat');
  } else {
    // One plain line of cost, in this seat's own numbers: the rate a second
    // and the cap the call can reach. A transaction, where the path made one
    // (the allowance path; an MPP grant has none), sits behind "Receipt".
    const rate = Number(data.tickPrice) / (Number(data.tickSeconds) || 1);
    const cap = Number(data.sessionCap != null ? data.sessionCap : data.remaining);
    const receipt = data.payment && data.payment.transaction
      ? `<details class="tx-details"><summary>Receipt</summary><a class="addr" href="${CONFIG.explorerUrl}/tx/${data.payment.transaction}" target="_blank" rel="noopener">${escapeHtml(data.payment.transaction)}</a></details>`
      : '';
    showMessage(
      `You're set. ${formatDollars(rate)} a second once you go live${cap > 0 ? `, up to ${formatDollars(cap)}` : ''}.${receipt}`,
      'success',
      'seat'
    );
  }
  startCameraStage(data);
  setJoinState('awaiting-camera');
  revealSeatCam();
}

function startCameraStage(data) {
  prewarmProgress('camera-stage');
  // LiveKit rooms publish via the SDK — the vdo iframe path never runs.
  if (isLivekitRoom()) return void startLivekitCameraStage(data);
  cameraLiveFired = false;
  stageLive = false;
  const stage = document.getElementById('cameraStage');
  const pub = document.getElementById('camPublisher');
  const det = document.getElementById('camDetector');
  const retryBtn = document.getElementById('camRetryBtn');

  retryBtn.classList.remove('show');
  setCamStatus('', 'Requesting camera…');
  // No direction hints: the preview and Go Live sit together on the frame.
  // Only a page that cannot open a camera at all says so.
  document.getElementById('camHint').textContent =
    location.protocol === 'https:' || location.hostname === 'localhost'
      ? ''
      : '⚠ Camera needs a secure context (https or localhost).';

  // Bare in-page publisher: webcam, auto-start, current camera, minimal UI.
  const sep = data.pushUrl.includes('?') ? '&' : '?';
  pub.src = data.pushUrl + sep + 'webcam&autostart&prefercurrentcamera&cleanish';

  // Hidden self-view on the same stream ID to confirm we're truly publishing.
  let pushId = '';
  try { pushId = new URL(data.pushUrl).searchParams.get('push') || ''; } catch {}
  det.src = pushId
    ? `${VDO_ORIGIN}/?view=${encodeURIComponent(pushId)}&cleanoutput&muted&autostart`
    : '';

  stage.classList.add('show');

  if (!camMsgBound) {
    window.addEventListener('message', onVdoMessage, { signal: abort.signal });
    camMsgBound = true;
  }

  clearTimeout(camFallbackTimer);
  clearTimeout(camErrorTimer);
  // Fallback: offer GO LIVE on the join button even if auto-detect stalls.
  camFallbackTimer = setTimeout(() => {
    if (cameraLiveFired || joinBtnState !== 'awaiting-camera') return;
    setJoinState('go-live');
  }, 5000);
  // Error path: surface retry if nothing happened (camera likely denied).
  camErrorTimer = setTimeout(() => {
    if (cameraLiveFired) return;
    setCamStatus('error', 'Camera not detected — check permissions.');
    retryBtn.classList.add('show');
  }, 25000);
}

function onVdoMessage(e) {
  if (e.origin !== VDO_ORIGIN) return; // verify it's really vdo.ninja
  const pub = document.getElementById('camPublisher');
  const det = document.getElementById('camDetector');
  if (e.source !== pub.contentWindow && e.source !== det.contentWindow) return;
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  console.log('[vdo]', e.source === pub.contentWindow ? 'publisher' : 'detector', d);

  // Documented connect signals (value truthy = connected). Camera granted →
  // the join button becomes GO LIVE; the user starts the meter explicitly.
  const a = d.action;
  const connected = d.value === true || (d.value && d.value !== false);
  if (
    (a === 'push-connection' && connected) ||
    (a === 'view-connection' && connected) ||
    (a === 'guest-connected' && connected)
  ) {
    if (!cameraLiveFired && joinBtnState === 'awaiting-camera') {
      setJoinState('go-live');
      setCamStatus('', 'Camera ready — hit GO LIVE');
    }
  }
}

function setCamStatus(cls, text) {
  const s = document.getElementById('camStatus');
  s.className = 'cam-status' + (cls ? ' ' + cls : '');
  document.getElementById('camStatusText').textContent = text;
}

// GO LIVE (the button, or the vdo detector): ask the server to put the seat
// live. The tile appears and the meter starts on its answer (onSeatLive).
function fireCameraReady(source) {
  if (cameraLiveFired || !mySeatId) return;
  cameraLiveFired = true;
  clearTimeout(camFallbackTimer);
  clearTimeout(camErrorTimer);
  console.log(`[camera] GO LIVE via ${source}`);
  // A stage rebuilt after a camera failure, on a seat the server already has
  // live: the answer is in, nothing to ask.
  if (serverLive) return goLiveNow();
  setJoinState('going-live');
  askToGoLive();
}

function askToGoLive() {
  clearTimeout(liveAskTimer);
  if (!mySeatId || !cameraLiveFired || serverLive) return;
  // The entrance and exit picked in the camera stage ride GO LIVE: the
  // overlay first draws the seat on the server's answer to this message.
  // null, not absent, for the default, so a switch back to it counts too.
  const picks = stingerSelections('seat');
  if (sendSeat('camera_ready', { flyIn: picks.flyIn || null, flyOut: picks.flyOut || null })) {
    setCamStatus('', 'Going live…');
  } else {
    // The control socket is down. ws.onopen asks again the moment it is back.
    setCamStatus('', 'Reconnecting…');
    document.getElementById('camHint').textContent =
      'Reconnecting — you go live the moment the connection is back.';
  }
  liveAskTimer = setTimeout(() => {
    // Still no answer on an open socket. Subscribing again makes the server
    // list the room's live seats (initial_state), which answers either way;
    // register_seat makes a seat it has lost say so (seat_removed). Then ask
    // again: camera_ready is a no-op for a seat that is already live.
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'subscribe_room', room: streamRoomId }));
      sendSeat('register_seat');
    }
    askToGoLive();
  }, LIVE_ASK_RETRY_MS);
}

// The server's answer: this seat is live.
function onSeatLive() {
  serverLive = true;
  clearTimeout(liveAskTimer);
  if (cameraLiveFired && !stageLive) goLiveNow();
}

function goLiveNow() {
  stageLive = true;
  // Once per seat: a camera stage rebuilt mid-seat keeps the first start.
  if (!seatLiveSince) seatLiveSince = Date.now();
  clearTimeout(liveAskTimer);
  // LiveKit: the camera was local-only until now, so nothing reaches the
  // room before GO LIVE (NEW-1: a campaign Call in cannot count preview
  // time) and the track the overlay receives always has a tile to land in.
  if (isLivekitRoom()) void publishLivekitTracks();
  // MPP seats: the meter is client-driven — start streaming paid ticks now.
  // The first tick opens the escrow channel (one silent wallet transaction).
  // Once per seat: a camera stage rebuilt mid-seat must not open a second
  // channel next to the one already streaming.
  if (lastJoinData && lastJoinData.paymentMode === 'mpp_session' && !mppTickTimer) {
    startMppTicks(lastJoinData);
  }
  setJoinState('live');
  setCamStatus('live', "You're LIVE on stream");
  // Swap the delayed broadcast for the sub-second host feed for the slot.
  mountHostFeed();
  document.getElementById('camHint').textContent = roomIsFree()
    ? 'Leave with the button above — or just close the tab.'
    : 'Leaving (button or closing the tab) stops the meter. Unspent balance stays in your wallet.';
  document.getElementById('camRetryBtn').classList.remove('show');
  // The pre-live instructions are OVER — a stale "hit GO LIVE" next to a
  // live badge read as a contradiction (audit P0-2). One status (cam pill),
  // one control (the morphing button).
  clearMessage('seat');
  // Detector self-view has done its job; tear it down to save bandwidth.
  const det = document.getElementById('camDetector');
  det.src = 'about:blank';
}

// Leave instantly — same as closing the tab. `quiet` skips the friendly
// goodbye message so failure paths can keep their own error on screen.
async function leaveStream(quiet) {
  const seatId = mySeatId;
  const seatToken = mySeatToken;
  releasePrewarm(); // the seat's own vacate starts the overlay grace timer
  if (!seatId) return;
  // The receipt's numbers, read before anything is torn down: time on camera,
  // and the seat meter's own Spent and Remaining (the server's figures; the
  // unspent part of the session cap is what comes back).
  const receipt = seatReceipt();
  setJoinState('busy', 'Leaving…');
  // Stop reacting to this seat locally right away so the meter stops instantly.
  mySeatId = null;
  mySeatToken = null;
  stopMppTicks(true); // close the channel → unspent deposit refunds from escrow
  teardownCameraStage();
  try {
    await fetch(`/api/leave/${seatId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatToken }),
    });
  } catch (e) {
    console.warn('leave request failed (server still drops seat on disconnect)', e);
  }
  setJoinState('idle');
  // The seat is over, so is its meter; the receipt says what it cost.
  hideMeter();
  setSessionUi(false);
  if (!quiet) showMessage(receipt, 'success', 'seat');
  // Back to pre-join: the wallet line shows the balance again.
  refreshBalance();
}

// "You were on for 1:42 · $0.20 spent · $0.80 back in your balance", from
// numbers the page already holds. A free seat has no meter, so it says only
// the time.
function seatReceipt() {
  const onMs = seatLiveSince ? Date.now() - seatLiveSince : 0;
  if (!seatMeter) {
    return onMs ? `You were on for ${clockText(onMs)} · free` : 'You left before going live.';
  }
  const spent = Number(seatMeter.spent) || 0;
  if (!onMs && !spent) return 'You left before going live · nothing spent';
  return `You were on for ${clockText(onMs)} · ${formatDollars(spent)} spent · ${formatDollars(seatMeter.remaining)} back in your balance`;
}

// Manual fallback button.
function goLive() { fireCameraReady('manual'); }

// Stop publishing + hide the stage (seat ended).
function teardownCameraStage() {
  clearTimeout(camFallbackTimer);
  clearTimeout(camErrorTimer);
  clearTimeout(liveAskTimer);
  serverLive = false;
  stageLive = false;
  teardownLivekit();
  // Live slot over (leave/kick/removal all land here): drop the real-time
  // host feed, bring the delayed spectate embed back.
  unmountHostFeed();
  mountStreamPreview();
  const stage = document.getElementById('cameraStage');
  const pub = document.getElementById('camPublisher');
  const det = document.getElementById('camDetector');
  if (pub) pub.src = 'about:blank';
  if (det) det.src = 'about:blank';
  if (stage) stage.classList.remove('show');
  // The hint and Retry sit outside the stage now (under Go Live's frame):
  // they leave with it.
  const hint = document.getElementById('camHint');
  if (hint) hint.textContent = '';
  const retryBtn = document.getElementById('camRetryBtn');
  if (retryBtn) retryBtn.classList.remove('show');
  cameraLiveFired = false;
}

// Rebuild the camera stage after a permission failure.
function retryCamera() {
  const data = lastJoinData;
  // Only for the seat still held: a leave in the 200 ms gap must not bring
  // the camera back up for a seat that is gone.
  const restart = (start) => setTimeout(() => { if (data && mySeatId === data.seatId) start(data); }, 200);
  if (isLivekitRoom()) {
    teardownLivekit();
    restart(startLivekitCameraStage);
    return;
  }
  const pub = document.getElementById('camPublisher');
  const det = document.getElementById('camDetector');
  pub.src = 'about:blank';
  det.src = 'about:blank';
  restart(startCameraStage);
}

// Each result shows under the control that caused it (owner's pick): a
// Holler's under the Holler block, a seat's under Call in, a wallet step's
// under the wallet row. Anything about the room as a whole keeps #message.
const MESSAGE_BOX = { holler: 'letterMessage', seat: 'seatMessage', wallet: 'walletMessage', rewards: 'rewardsMessage' };

function messageBox(where) {
  return (MESSAGE_BOX[where] && document.getElementById(MESSAGE_BOX[where])) || document.getElementById('message');
}

function showMessage(html, type, where) {
  const msgBox = messageBox(where);
  if (!msgBox) return;
  msgBox.innerHTML = html;
  msgBox.className = 'join-message ' + type + ' show';
}

function clearMessage(where) {
  const msgBox = messageBox(where);
  if (msgBox) msgBox.className = 'join-message';
}

// ─── Init (runs after all state is initialized) ──────────────────────────
function initWallet() {
  // Only whether an extension EXISTS — never a call into it. Subscribing and
  // reading accounts wait for an explicit Connect (watchWalletAccount): with
  // two wallet extensions installed, the first call into window.ethereum pops
  // Phantom's "Which extension?" chooser at someone who only opened a room.
  hasWallet = !!getProvider();
  // Note: account stays null here on purpose — we only read it on Connect.
  renderWallet();
}

// Reflect account changes once — and only once — the visitor has connected.
let watchingWallet = false;
function watchWalletAccount(eth) {
  if (watchingWallet || !eth || typeof eth.on !== 'function') return;
  watchingWallet = true;
  try {
    eth.on('accountsChanged', (accs) => {
      if (walletMode === 'privy') return;
      account = (accs && accs[0]) || null;
      walletBalance = null;
      if (account) walletMode = 'metamask';
      renderWallet();
      if (account) {
        refreshBalance();
        // The watch-to-earn module credits whichever wallet this announces.
        window.dispatchEvent(new CustomEvent('wallet:connected', { detail: { account } }));
      }
    });
    eth.on('chainChanged', () => { /* user can re-trigger via actions */ });
  } catch (e) {
    console.warn('wallet listener setup failed', e);
  }
}

// ─── Delayed spectate surface (Twitch embed) ────────────────────────────────
// True real-time exists only on the WebRTC layer; this embed is the normal
// ~15s-delayed broadcast every spectator sees. Mounted when the room has a
// twitchChannel configured. Removing the iframe (not just hiding) guarantees
// silence — the live-slot flow relies on that for echo safety.
// The media column's designed idle state (join-client #previewIdle) shows
// exactly when NOTHING real is mounted — otherwise a no-preview room reads
// as a dead black rectangle / empty column.
function syncPreviewIdle() {
  const idle = document.getElementById('previewIdle');
  if (!idle) return;
  const showing = ['hostLiveFeed', 'streamPreview'].some((id) => {
    const el = document.getElementById(id);
    return el && el.style.display !== 'none';
  });
  idle.style.display = showing ? 'none' : '';
  // On phones an idle stage folds to a thin strip (join.css), so the actions
  // are on the first screen.
  const stage = idle.closest('.join-media-stage');
  if (stage) stage.classList.toggle('is-idle', !showing);
}

function setIdleTitle(text) {
  const el = document.getElementById('previewIdleTitle');
  if (el) el.textContent = text;
}

// Whether the room's Twitch channel is live, from the room's liveness
// (join-client RoomLiveness → room:liveness): null until the first answer.
let channelLiveNow = null;

function liveEmbedMounted() {
  const mount = document.getElementById('streamPreviewMount');
  return !!(mount && mount.querySelector('iframe[src*="channel="]'));
}

// The off-air card: Holler's own slate, never Twitch's offline promo (whose
// links leave the site). Watched for the channel going live meanwhile.
function showOffAir(wrap, mount, gen, roomId) {
  const channel = CONFIG && CONFIG.twitchChannel;
  mount.innerHTML = '';
  wrap.style.display = 'none';
  setIdleTitle(channel ? `${channel} is off air` : 'No preview');
  syncPreviewIdle();
  if (channel) watchForLive(gen, roomId);
}

// A liveness answer arrived: put the player up the moment the channel goes
// live, and take it down when the broadcast ends. A viewer holding a live seat
// watches the host feed instead (echo safety), so nothing moves then.
function syncLivePreview() {
  if (!CONFIG || !CONFIG.twitchChannel || stageLive) return;
  const host = document.getElementById('hostLiveFeed');
  if (host && host.style.display !== 'none') return;
  const wrap = document.getElementById('streamPreview');
  const mount = document.getElementById('streamPreviewMount');
  if (!wrap || !mount) return;
  if (channelLiveNow && !liveEmbedMounted()) {
    previewGen++; // a replay up meanwhile, or its live watch, steps aside
    mount.innerHTML = '';
    mountLivePreview(wrap, mount);
  } else if (channelLiveNow === false && liveEmbedMounted()) {
    mountStreamPreview(); // the broadcast ended: its replay, or the off-air card
  }
}

// Bumped by every mount and every hide: a replay lookup that comes back after
// the preview was removed (the viewer took a live seat — echo safety) must
// not put a player back.
let previewGen = 0;

function mountStreamPreview() {
  const wrap = document.getElementById('streamPreview');
  const mount = document.getElementById('streamPreviewMount');
  if (!wrap || !mount) return;
  const gen = ++previewGen;
  // An OFFLINE room shows the replay of a broadcast — the one a "Recently
  // aired" card asked for (?replay=), else its latest — instead of Twitch's
  // "is offline / Watch Latest Stream", which leaves the site. A live room
  // gets the live embed; one with nothing to replay, Holler's off-air card.
  const roomId = (CONFIG && CONFIG.roomId) || streamRoomId;
  const want = new URLSearchParams(location.search).get('replay') || '';
  fetch(`/api/rooms/${encodeURIComponent(roomId)}/replay${want ? `?airing=${encodeURIComponent(want)}` : ''}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((replay) => {
      if (gen !== previewGen) return; // hidden or re-mounted meanwhile
      // A replay needs something to show: a moment to open, or — once the
      // recording has been looked up and is gone — the broadcast's picture.
      // "Not looked up yet" (minutes after the end) keeps Twitch's own embed.
      const playable = replay && !replay.live && replay.airing
        && (replay.start >= 0 || (replay.recordingsResolved && replay.airing.poster?.kind === 'frame'));
      // The Twitch player only while the channel is live (owner's pick):
      // liveness decides once it has answered, the replay lookup until then.
      const live = channelLiveNow != null ? channelLiveNow : !!(replay && replay.live);
      if (live) {
        mountLivePreview(wrap, mount);
      } else if (playable) {
        mountReplay(wrap, mount, replay);
        watchForLive(gen, roomId);
      } else {
        showOffAir(wrap, mount, gen, roomId);
      }
    });
}

// While a replay is up, keep asking whether the room went live: the replay was
// chosen once, and a viewer who opened it before the stream must not stay on
// yesterday's broadcast after it starts.
function watchForLive(gen, roomId) {
  const t = setInterval(() => {
    if (gen !== previewGen) { clearInterval(t); return; }
    fetch(`/api/rooms/${encodeURIComponent(roomId)}/replay`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((j) => {
        if (!j || !j.live || channelLiveNow === false || gen !== previewGen) return;
        clearInterval(t);
        const wrap = document.getElementById('streamPreview');
        const mount = document.getElementById('streamPreviewMount');
        if (wrap && mount) { mount.innerHTML = ''; mountLivePreview(wrap, mount); }
      });
  }, 45_000);
}

/** Twitch's `time` parameter: 1h2m3s. */
function twitchTime(totalS) {
  const s = Math.max(0, Math.floor(totalS));
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${s % 60}s`;
}

function clockText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function agoText(ms) {
  const mins = Math.max(1, Math.round((Date.now() - ms) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

/**
 * The replay: the broadcast's recording opened `leadS` before the moment (a
 * MegaChat first, else a guest going on camera), a button for every other
 * moment, and — for a moment the recording cannot show any more — the kept
 * MegaChat clip. With nothing playable at all, the broadcast's picture.
 */
function mountReplay(wrap, mount, replay) {
  const label = document.getElementById('streamPreviewLabel');
  const list = document.getElementById('streamReplayMoments');
  const moments = replay.moments || [];
  const describe = (m) => (m.kind === 'start' ? 'the start'
    : `${m.kind === 'megachat' ? 'Holler' : 'On camera'} · ${m.label || 'guest'}`);
  const play = (i) => {
    const m = moments[i];
    mount.innerHTML = '';
    if (m.vod) {
      const iframe = document.createElement('iframe');
      iframe.src =
        'https://player.twitch.tv/?video=v' + encodeURIComponent(m.vod.vodId) +
        '&parent=' + encodeURIComponent(location.hostname) +
        '&time=' + twitchTime(m.vod.offsetS) +
        '&autoplay=true&muted=true';
      iframe.allow = 'autoplay; fullscreen';
      iframe.allowFullscreen = true;
      iframe.title = 'Replay';
      mount.appendChild(iframe);
    } else if (m.clip) {
      const v = document.createElement('video');
      v.className = 'stream-replay-clip';
      v.controls = true;
      v.autoplay = true;
      v.muted = true;
      v.playsInline = true;
      const src = document.createElement('source');
      src.src = m.clip.url;
      src.type = m.clip.mime || 'video/webm';
      // A browser that cannot play it (Safari and a webm) shows the
      // broadcast's picture instead of a dead player.
      src.addEventListener('error', () => showPoster('This clip cannot play in this browser'));
      v.appendChild(src);
      mount.appendChild(v);
    }
    if (label) {
      label.textContent = m.vod
        ? (m.kind === 'start'
          ? `Replay · aired ${agoText(replay.airing.endedAt)} · from the start`
          : `Replay · aired ${agoText(replay.airing.endedAt)} · from ${replay.leadS}s before ${describe(m)}`)
        : `The Holler · ${m.label || 'guest'} · aired ${agoText(replay.airing.endedAt)} (the recording is gone)`;
    }
    if (list) list.querySelectorAll('button').forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
  };
  function showPoster(why) {
    mount.innerHTML = '';
    if (replay.airing.poster?.kind === 'frame') {
      const img = document.createElement('img');
      img.className = 'stream-replay-poster';
      img.src = replay.airing.poster.url;
      img.alt = '';
      mount.appendChild(img);
    }
    if (label) label.textContent = `Aired ${agoText(replay.airing.endedAt)} · ${why}`;
  }
  if (list) {
    list.innerHTML = '';
    if (moments.length > 1) {
      // The first dozen: the row scrolls sideways (join.css), never grows.
      moments.slice(0, 12).forEach((m, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `${describe(m)} · ${clockText(m.offsetMs)}${m.vod ? '' : ' · clip'}`;
        b.addEventListener('click', () => play(i));
        list.appendChild(b);
      });
      list.hidden = false;
    } else {
      list.hidden = true;
    }
  }
  if (replay.start >= 0) {
    play(replay.start);
  } else {
    // Nothing left to play: the picture the board showed, and why.
    showPoster('the recording is no longer available');
  }
  wrap.style.display = '';
  syncPreviewIdle();
}

function mountLivePreview(wrap, mount) {
  const channel = CONFIG && CONFIG.twitchChannel;
  if (!channel) {
    wrap.style.display = 'none';
    setIdleTitle('No preview');
    syncPreviewIdle();
    return;
  }
  const label = document.getElementById('streamPreviewLabel');
  if (label) label.textContent = 'Stream preview · slight delay';
  const list = document.getElementById('streamReplayMoments');
  if (list) list.hidden = true;
  if (!mount.querySelector('iframe[src*="channel="]')) {
    mount.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.src =
      'https://player.twitch.tv/?channel=' + encodeURIComponent(channel) +
      '&parent=' + encodeURIComponent(location.hostname) +
      '&muted=true&autoplay=true';
    iframe.allow = 'autoplay; fullscreen';
    iframe.allowFullscreen = true;
    iframe.title = 'Live stream preview';
    mount.appendChild(iframe);
  }
  wrap.style.display = '';
  syncPreviewIdle();
}

function hideStreamPreview() {
  previewGen++; // a replay lookup still in flight must not mount afterwards
  const wrap = document.getElementById('streamPreview');
  const mount = document.getElementById('streamPreviewMount');
  if (mount) mount.innerHTML = ''; // iframe (live or replay) removed → guaranteed silent
  if (wrap) wrap.style.display = 'none';
  syncPreviewIdle();
}

// ─── True-live return feed (host cam over the app's own WebRTC pipe) ────────
// While this viewer holds a live slot they watch the HOST sub-second via
// vdo.ninja instead of the ~15s Twitch broadcast — that's what makes a real
// two-way conversation possible. The host publishes to a deterministic
// per-room stream id (push link in the dashboard); if the host cam isn't
// open, vdo.ninja shows its waiting screen and recovers when it appears.
function hostStreamId() {
  return 'mc-host-' + ((CONFIG && CONFIG.roomId) || streamRoomId || 'default');
}

function mountHostFeed() {
  const wrap = document.getElementById('hostLiveFeed');
  const mount = document.getElementById('hostLiveMount');
  if (!wrap || !mount) return;
  hideStreamPreview(); // echo safety: the delayed embed is REMOVED, not muted
  if (isLivekitRoom()) return mountLivekitHostFeed(wrap, mount);
  if (!mount.querySelector('iframe')) {
    const iframe = document.createElement('iframe');
    const q = [
      `view=${encodeURIComponent(hostStreamId())}`,
      'cleanviewer',
      'cleanoutput',
      'cover',
      'hideplaybutton',
      'autostart',
      'noheader',
      // low-latency defaults: no buffer param → vdo.ninja's sub-second path
      'retrytimeout=2000',
    ].join('&');
    iframe.src = `https://vdo.ninja/?${q}`;
    iframe.allow = 'autoplay; fullscreen';
    iframe.title = 'Host camera (real-time)';
    mount.appendChild(iframe);
  }
  wrap.style.display = '';
  syncPreviewIdle();
}

function unmountHostFeed() {
  const wrap = document.getElementById('hostLiveFeed');
  const mount = document.getElementById('hostLiveMount');
  if (lkHostFeedCleanup) {
    lkHostFeedCleanup();
    lkHostFeedCleanup = null;
  }
  if (mount) mount.innerHTML = '';
  if (wrap) wrap.style.display = 'none';
  syncPreviewIdle();
}

// LiveKit return feed: the joiner is ALREADY connected (publisher tokens
// carry canSubscribe) — attach the host's tracks when they exist and follow
// them live. Sub-second by construction; no second connection needed.
let lkHostFeedCleanup = null;

async function mountLivekitHostFeed(wrap, mount) {
  if (!lkRoom) return;
  const lk = await import('livekit-client');
  // Mounted again after a camera rebuild (a new Room): drop the listeners
  // and audio of the room that was torn down before following this one.
  if (lkHostFeedCleanup) { lkHostFeedCleanup(); lkHostFeedCleanup = null; }
  if (!lkRoom) return;
  const hostIdentity = 'host:' + ((CONFIG && CONFIG.roomId) || streamRoomId);
  let video = mount.querySelector('video');
  if (!video) {
    video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;';
    mount.appendChild(video);
  }
  const audioEls = [];

  // The host's PICTURE is shown only once their booth says it is a person
  // (mc.picture = 'live'). Until then — and whenever it is OBS's "virtual
  // camera not started" logo, a frozen frame, or no camera at all — the guest
  // gets a designed state. The host's VOICE plays regardless.
  // A booth that predates the signal sends no attribute: if a host picture has
  // been attached for LEGACY_SHOW_MS with no attribute, show it as before, so a
  // dashboard tab opened before a deploy cannot hide the host forever.
  const LEGACY_SHOW_MS = 2000;
  const HELD = {
    waiting: ['Waiting for the host', 'Their camera and voice come through here when they join you.'],
    checking: ['Host camera starting', 'You can already hear the host.'],
    still: ['Host camera is off', 'You can still hear the host.'],
  };
  const held = document.getElementById('hostFeedHeld');
  const heldTitle = document.getElementById('hostFeedHeldTitle');
  const heldText = document.getElementById('hostFeedHeldText');
  let legacyShow = false;
  let legacyTimer = null;
  const hostNow = () => [...(lkRoom ? lkRoom.remoteParticipants.values() : [])].find((p) => p.identity === hostIdentity);
  const applyHostPicture = () => {
    const host = hostNow();
    const signalled = host && host.attributes ? host.attributes['mc.picture'] : undefined;
    const state = !host ? 'waiting' : signalled || (legacyShow ? 'live' : 'checking');
    const show = state === 'live';
    video.style.visibility = show ? '' : 'hidden';
    if (!held) return;
    held.style.display = show ? 'none' : '';
    held.dataset.state = state;
    const [title, text] = HELD[state] || HELD.still;
    if (heldTitle) heldTitle.textContent = title;
    if (heldText) heldText.textContent = text;
  };
  const onHostPresence = (participant) => {
    if (participant && participant.identity !== hostIdentity) return;
    if (!hostNow()) {
      legacyShow = false;
      if (legacyTimer) { clearTimeout(legacyTimer); legacyTimer = null; }
    }
    applyHostPicture();
  };
  const onHostAttributes = (_changed, participant) => {
    if (participant && participant.identity === hostIdentity) applyHostPicture();
  };
  applyHostPicture();

  const attachIfHost = (track, participant) => {
    if (participant.identity !== hostIdentity) return;
    console.log('[livekit] host feed: attaching', track.kind);
    if (track.kind === 'video') {
      track.attach(video);
      if (!legacyTimer && !(participant.attributes && participant.attributes['mc.picture'])) {
        legacyTimer = setTimeout(() => {
          const h = hostNow();
          if (h && !(h.attributes && h.attributes['mc.picture'])) { legacyShow = true; applyHostPicture(); }
        }, LEGACY_SHOW_MS);
      }
    }
    if (track.kind === 'audio') {
      const a = track.attach();
      a.style.display = 'none';
      mount.appendChild(a);
      audioEls.push(a);
      watchGuestEcho(track);
    }
  };
  // ECHO: is this page's mic sending the host's own voice back? A guest on
  // speakers whose canceller leaks, or with the stream playing in another tab
  // (seconds behind — hence up to 30s). The guest is told here; the streamer's
  // booth names them (POST /api/seat/echo). What is shown belongs to the PAGE,
  // not to one detector: a new mic track (LiveKit restarts it on a device
  // change or a reconnect) gets a new detector that carries the finding over,
  // so the warning neither sticks nor flickers.
  let echoWatch = null;
  let echoGen = 0;
  let echoHostTrack = null;
  let echoMicTrack = null;
  let echoShown = null; // null, or the delay (s) of the echo being shown
  let echoSent = undefined; // what the server last accepted
  let echoRetry = null;
  const warn = document.getElementById('guestEchoWarn');
  const sendEcho = () => {
    if (echoRetry) { clearTimeout(echoRetry); echoRetry = null; }
    const want = echoShown != null;
    if (!mySeatId || echoSent === want) return;
    seatPost('/api/seat/echo', { seatId: mySeatId, echo: want, lagS: echoShown })
      .then((r) => {
        if (r.ok || r.status === 404) { echoSent = want; return; } // 404: the seat is gone
        echoRetry = setTimeout(sendEcho, 5000);
      })
      .catch(() => { echoRetry = setTimeout(sendEcho, 5000); });
  };
  const showEcho = (lagS) => {
    echoShown = lagS;
    if (warn) warn.hidden = lagS == null;
    sendEcho();
  };
  const rearmEcho = () => { if (echoHostTrack) watchGuestEcho(echoHostTrack); };
  const watchGuestEcho = (hostTrack) => {
    echoHostTrack = hostTrack;
    const gen = ++echoGen;
    if (echoWatch) { echoWatch.stop(); echoWatch = null; }
    const micPub = [...lkRoom.localParticipant.audioTrackPublications.values()][0];
    // The mic is published at GO LIVE, in parallel with this feed mounting:
    // until its publication exists, the local track it will publish is the
    // same object, so the detector starts on that.
    const micTrack = (micPub && micPub.track) || lkLocalTracks.find((t) => t.kind === 'audio') || null;
    if (micTrack !== echoMicTrack) {
      if (echoMicTrack) echoMicTrack.off(lk.TrackEvent.Restarted, rearmEcho);
      if (micTrack) micTrack.on(lk.TrackEvent.Restarted, rearmEcho);
      echoMicTrack = micTrack;
    }
    const mic = micTrack && micTrack.mediaStreamTrack;
    if (!mic || !hostTrack.mediaStreamTrack) return;
    startEchoDetector(hostTrack.mediaStreamTrack, mic, {
      maxLagS: 30,
      reportedLagS: echoShown,
      onEcho: (f) => { if (gen === echoGen) showEcho(f.lagS); },
      onClear: () => { if (gen === echoGen) showEcho(null); },
    }).then((d) => {
      if (gen !== echoGen) { d.stop(); return; }
      echoWatch = d;
    });
  };
  // host may already be on air — attach existing tracks now
  console.log(
    '[livekit] host feed mount — remotes:',
    [...lkRoom.remoteParticipants.values()]
      .map((p) => `${p.identity}(${p.trackPublications.size} pubs, subscribed=${[...p.trackPublications.values()].map((x) => x.isSubscribed).join('/')})`)
      .join(', ') || 'none',
  );
  for (const p of lkRoom.remoteParticipants.values()) {
    if (p.identity !== hostIdentity) continue;
    for (const pub of p.trackPublications.values()) {
      if (pub.track) attachIfHost(pub.track, p);
      else if (pub.setSubscribed) pub.setSubscribed(true);
    }
  }
  const onSub = (track, _pub, participant) => attachIfHost(track, participant);
  lkRoom.on(lk.RoomEvent.TrackSubscribed, onSub);
  lkRoom.on(lk.RoomEvent.ParticipantAttributesChanged, onHostAttributes);
  lkRoom.on(lk.RoomEvent.ParticipantConnected, onHostPresence);
  lkRoom.on(lk.RoomEvent.ParticipantDisconnected, onHostPresence);
  lkHostFeedCleanup = () => {
    try {
      if (lkRoom) {
        lkRoom.off(lk.RoomEvent.TrackSubscribed, onSub);
        lkRoom.off(lk.RoomEvent.ParticipantAttributesChanged, onHostAttributes);
        lkRoom.off(lk.RoomEvent.ParticipantConnected, onHostPresence);
        lkRoom.off(lk.RoomEvent.ParticipantDisconnected, onHostPresence);
      }
    } catch { /* down */ }
    if (legacyTimer) clearTimeout(legacyTimer);
    if (held) held.style.display = 'none';
    audioEls.forEach((a) => a.remove());
    echoGen++;
    if (echoWatch) { echoWatch.stop(); echoWatch = null; }
    if (echoMicTrack) { echoMicTrack.off(lk.TrackEvent.Restarted, rearmEcho); echoMicTrack = null; }
    if (echoShown != null) showEcho(null); // the seat is ending or the feed is gone: nothing to warn about
    if (echoRetry) { clearTimeout(echoRetry); echoRetry = null; }
  };
  wrap.style.display = '';
  syncPreviewIdle();
}

// ─── LiveKit transport (flag-gated; vdo stays the default, untouched) ───────
// Joiner publish path for rooms with transport === 'livekit'. Same UI state
// machine as vdo: stage → camera preview → GO LIVE → live. The vdo iframes
// are simply never created for these rooms.
//
// The camera and mic are LOCAL during the preview: created here, shown in the
// self-view, and published only once the seat is live (goLiveNow). That makes
// the hint's promise true, and it means a campaign Call in, which counts from
// LiveKit's track_published, can never count preview time (owner decision on
// audit NEW-1).
let lkRoom = null;
let lkLocalVideo = null;
let lkLocalTracks = [];
// Bumped by every stage start and every teardown. A stage still starting
// checks it after each await and stops itself when it has moved on, so a
// cancel during the token fetch, the SDK download, the connect or the
// permission prompt cannot leave the camera captured and publishing after
// the viewer left (audit web-3).
let lkStageGen = 0;

function stopLkLocalTracks() {
  for (const t of lkLocalTracks) { try { t.stop(); } catch { /* already ended */ } }
  lkLocalTracks = [];
}

function isLivekitRoom() {
  return CONFIG && CONFIG.transport === 'livekit';
}

async function startLivekitCameraStage(data) {
  const gen = ++lkStageGen;
  const stale = () => gen !== lkStageGen;
  // A rejoin used to overwrite lkRoom while the old room was still connected.
  if (lkRoom) { try { lkRoom.disconnect(); } catch { /* already down */ } lkRoom = null; }
  stopLkLocalTracks();
  cameraLiveFired = false;
  stageLive = false;
  const stage = document.getElementById('cameraStage');
  const pub = document.getElementById('camPublisher');
  const det = document.getElementById('camDetector');
  const retryBtn = document.getElementById('camRetryBtn');
  retryBtn.classList.remove('show');
  setCamStatus('', 'Requesting camera…');
  // vdo iframes stay dormant for livekit rooms
  if (pub) pub.style.display = 'none';
  if (det) det.src = '';
  stage.classList.add('show');
  document.getElementById('camHint').textContent =
    'Your camera preview is below (LiveKit). Nothing is broadcast until you hit GO LIVE.';

  try {
    const tokRes = await seatPost('/api/livekit/token', { room: streamRoomId, role: 'publisher', seatId: data.seatId });
    const tok = await tokRes.json().catch(() => ({}));
    if (stale()) return;
    if (!tokRes.ok || !tok.token) throw new Error(tok.error || `token failed (${tokRes.status})`);

    const lk = await import('livekit-client');
    if (stale()) return;
    // Built into a local and handed to lkRoom at once, so a teardown during
    // connect() can reach it and disconnect it.
    const room = new lk.Room({
      adaptiveStream: true,
      // dynacast: layers nobody subscribes to PAUSE at the publisher — the
      // viewer's uplink (usually the real bottleneck) stops paying for
      // resolutions no one is watching.
      dynacast: true,
      // simulcast for smooth degradation (phase 3 requirement, on by default)
      publishDefaults: { simulcast: true },
    });
    lkRoom = room;
    await room.connect(tok.url || (CONFIG && CONFIG.livekitUrl), tok.token);
    if (stale()) { room.disconnect(); return; }
    // createTracks, not enableCameraAndMicrophone: that one publishes at once,
    // and livekit-client 2.20.1 never stops the tracks it made when the
    // publish fails. These stay ours until goLiveNow publishes them.
    const tracks = await room.localParticipant.createTracks({ audio: true, video: true });
    if (stale()) {
      for (const t of tracks) { try { t.stop(); } catch { /* ended */ } }
      room.disconnect();
      return;
    }
    lkLocalTracks = tracks;

    // Local self-view in the SAME frame the vdo iframe used.
    const frame = pub ? pub.parentElement : stage.querySelector('.cam-frame');
    if (frame && !lkLocalVideo) {
      lkLocalVideo = document.createElement('video');
      lkLocalVideo.muted = true;
      lkLocalVideo.playsInline = true;
      lkLocalVideo.className = 'lk-self'; // sized by join.css, stays IN the frame
      frame.appendChild(lkLocalVideo);
    }
    const cam = tracks.find((t) => t.kind === 'video');
    if (cam && lkLocalVideo) cam.attach(lkLocalVideo);

    // Phase-3 payoff: auto-reconnect + connection-quality signals.
    room.on(lk.RoomEvent.ConnectionStateChanged, (state) => {
      const s = String(state);
      console.log('[livekit] connection state:', s);
      // LiveKit reports 'signalReconnecting' first, then 'reconnecting' —
      // both mean the pipe is down: pause the meter display, flag the dot.
      if (/reconnect/i.test(s)) {
        setCamStatus('', 'Reconnecting…');
        renderLkQuality('lost'); // offline-safe: local UI truth, no network
        const t = document.getElementById('meterTime');
        if (t) t.textContent = '⏸ paused';
      } else if (s === 'connected') {
        console.log('[livekit] reconnected — meter resumes');
        renderLkQuality('good');
        lastReportedQuality = null; // re-report fresh quality to the server
        if (joinBtnState === 'live') setCamStatus('live', "You're LIVE on stream");
      }
    });
    room.on(lk.RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant !== room.localParticipant) return;
      renderLkQuality(String(quality));
      reportLkQuality(String(quality), data.seatId);
    });

    if (serverLive) {
      // Rebuilt mid-seat (Retry after a camera failure): the seat is already
      // live, so the camera goes straight back on air without a second GO LIVE.
      cameraLiveFired = true;
      goLiveNow();
    } else if (joinBtnState === 'awaiting-camera') {
      // Camera up — same UX beat as the vdo detector firing.
      setJoinState('go-live');
      setCamStatus('', 'Camera ready — hit GO LIVE');
      document.getElementById('camHint').textContent =
        'Camera connected over LiveKit. Hit GO LIVE above to start your stream.';
    }
  } catch (err) {
    // A cancel's own disconnect surfaces here as an error: not a failure.
    if (stale()) return;
    console.error('[livekit] camera stage failed:', err);
    setCamStatus('error', 'Camera failed — ' + (err?.message || 'unknown'));
    retryBtn.classList.add('show');
  }
}

// GO LIVE, confirmed: put the preview's camera and mic on the room.
async function publishLivekitTracks() {
  const room = lkRoom;
  const gen = lkStageGen;
  const tracks = lkLocalTracks;
  if (!room || !tracks.length) return;
  try {
    await Promise.all(tracks.map((t) => room.localParticipant.publishTrack(t)));
  } catch (err) {
    if (gen !== lkStageGen) return; // torn down meanwhile; teardown stopped them
    console.error('[livekit] publish failed:', err);
    // The library leaves a track whose publish failed running: stop them, or
    // the camera stays on with nothing showing it.
    stopLkLocalTracks();
    setCamStatus('error', 'Camera failed — ' + (err?.message || 'unknown'));
    document.getElementById('camRetryBtn').classList.add('show');
  }
}

function teardownLivekit() {
  lkStageGen++; // a stage still starting stops at its next await
  stopLkLocalTracks();
  if (lkRoom) {
    try { lkRoom.disconnect(); } catch { /* already down */ }
    lkRoom = null;
  }
  if (lkLocalVideo) {
    lkLocalVideo.remove();
    lkLocalVideo = null;
  }
  const pub = document.getElementById('camPublisher');
  if (pub) pub.style.display = '';
  const dot = document.getElementById('lkQualityDot');
  if (dot) dot.style.display = 'none';
  lastReportedQuality = null;
}

// Subtle connection-quality dot on the joiner's own UI + a report to the
// server so the streamer's dashboard sees who's riding a bad link.
let lastReportedQuality = null;

function renderLkQuality(q) {
  const dot = document.getElementById('lkQualityDot');
  if (!dot) return;
  dot.style.display = '';
  dot.dataset.q = q;
  dot.title = 'Connection: ' + q;
}

function reportLkQuality(q, seatId) {
  if (q === lastReportedQuality || !seatId) return;
  lastReportedQuality = q;
  seatPost('/api/seat/quality', { seatId, quality: q }).catch(() => { /* cosmetic signal — never block on it */ });
}

// ─── Letter mode: record → preview → pay flat → one-shot upload ─────────────
// Recorded clips sidestep the broadcast delay entirely: the sender watches
// the delayed embed and sees their letter pop up like any other spectator.
let letterState = 'idle'; // idle | recording | preview | sending | sent
let letterRecorder = null;
let letterChunks = [];
let letterBlob = null;
let letterStream = null;
let letterCountdown = null;
let letterDurationS = 0;
let myLetterId = null;
let letterFrames = [];
let letterFrameTimer = null;
// The take on screen, by name: { id, letterId, uploadUrl }. Made when a take
// is recorded, dropped when it is replaced or the stage closes. A Send that
// fails AFTER paying keeps letterId and uploadUrl, so "Send again" retries the
// upload instead of paying again, and the server answers a repeated id from
// the letter it already paid for (letters.js), which covers a submit whose
// answer was lost (audit web-4).
let letterAttempt = null;
let letterPreviewUrl = null;

const newLetterAttempt = () => ({ id: newAttemptId(), letterId: null, uploadUrl: null });

// The recorded take plays back from a blob URL; each one holds the whole
// recording in memory until revoked.
function setLetterPreview(video, blob) {
  if (letterPreviewUrl) URL.revokeObjectURL(letterPreviewUrl);
  letterPreviewUrl = blob ? URL.createObjectURL(blob) : null;
  if (video) video.src = letterPreviewUrl || '';
}

function lettersCfg() {
  return CONFIG && CONFIG.letters && CONFIG.letters.enabled ? CONFIG.letters : null;
}

// Hollers bill by the second (letters.js): the rate times the whole seconds
// recorded, capped at the longest clip. The server sends the price for every
// length it accepts, so the figure shown is the figure charged.
function letterRate(cfg) {
  const r = Number(cfg.ratePerSecond);
  return Number.isFinite(r) ? r : Number(cfg.price) / Math.max(1, Number(cfg.maxSeconds) || 10);
}
function letterPriceForTake(cfg, seconds) {
  const s = Math.min(Number(cfg.maxSeconds) || 10, Math.max(1, Math.ceil(Number(seconds) || 0)));
  if (cfg.prices && cfg.prices[s] != null) return String(cfg.prices[s]);
  const p = letterRate(cfg) * s;
  return p > 0 ? String(Math.max(0.000001, Math.round(p * 1e6) / 1e6)) : '0';
}
function letterIsFreeRoom(cfg) {
  return !(parseFloat(cfg.price) > 0);
}

function initLetterUi() {
  const btn = document.getElementById('letterBtn');
  const action = document.getElementById('megachatAction');
  if (!btn) return;
  const cfg = lettersCfg();
  if (!cfg) {
    btn.style.display = 'none';
    if (action) action.style.display = 'none';
    return;
  }
  if (action) action.style.display = '';
  // While the recorder is open the stage's own Send is the only send: a second
  // "Send a Holler" here started over and threw the take away.
  const stage = document.getElementById('letterStage');
  btn.style.display = stage && stage.style.display !== 'none' ? 'none' : '';
  // Short label — "· up to 10s" pushed the button onto two wrapped lines on
  // mobile, and the recorder stage states the cap the moment it opens.
  // Plain text (owner's pick vr-emoji-buttons): the button's one mark is the
  // Holler record dot, drawn by join.css.
  (btn as HTMLButtonElement).disabled = roomPaused();
  btn.textContent = roomPaused()
    ? 'Send a Holler — paused'
    : letterIsFreeRoom(cfg)
      ? 'Send a Holler — FREE'
      : `Send a Holler — ${formatDollars(letterRate(cfg))}/s`;
}

function setLetterStatus(text, tone) {
  const el = document.getElementById('letterStatus');
  if (!el) return;
  el.textContent = text || '';
  // A refusal must not read like ordinary progress copy.
  el.classList.toggle('text-[var(--neon-magenta)]', tone === 'error');
  el.classList.toggle('text-muted-foreground', tone !== 'error');
}

function letterButtons({ record, redo, send }) {
  const show = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.style.display = on ? '' : 'none';
  };
  show('letterRecordBtn', record);
  show('letterRedoBtn', redo);
  show('letterSendBtn', send);
  // The review step: the entrance and exit go with Send.
  showStingers('letter', send);
}

async function openLetterStage() {
  const cfg = lettersCfg();
  if (!cfg) return;
  const stage = document.getElementById('letterStage');
  const video = document.getElementById('letterVideo');
  clearMessage('holler'); // the last Holler's news is not this one's
  try {
    letterStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    showMessage('❌ Camera/mic access is needed to record a Holler.', 'error', 'holler');
    return;
  }
  stage.style.display = '';
  const entry = document.getElementById('letterBtn');
  if (entry) entry.style.display = 'none';
  video.srcObject = letterStream;
  video.muted = true;
  video.controls = false;
  video.play().catch(() => {});
  letterState = 'idle';
  letterBlob = null;
  letterButtons({ record: true, redo: false, send: false });
  setLetterStatus(letterIsFreeRoom(cfg)
    ? `${cfg.minSeconds ?? 3}–${cfg.maxSeconds}s · free`
    : `${cfg.minSeconds ?? 3}–${cfg.maxSeconds}s · ${formatDollars(letterRate(cfg))} a second, so you pay for what you record.`);
}

function closeLetterStage() {
  const stage = document.getElementById('letterStage');
  const video = document.getElementById('letterVideo');
  clearInterval(letterCountdown);
  if (letterRecorder && letterRecorder.state === 'recording') {
    try { letterRecorder.stop(); } catch { /* already stopping */ }
  }
  letterRecorder = null;
  if (letterStream) {
    letterStream.getTracks().forEach((t) => t.stop());
    letterStream = null;
  }
  if (video) video.srcObject = null;
  setLetterPreview(video, null);
  letterAttempt = null;
  if (stage) stage.style.display = 'none';
  letterState = 'idle';
  const cancel = document.getElementById('letterCancelBtn');
  if (cancel) cancel.textContent = 'Cancel';
  const entry = document.getElementById('letterBtn');
  if (entry && lettersCfg()) entry.style.display = '';
  showRedoConfirm(false);
}

// Sent: the recorder stays open in a "Sent" state, with the result in its own
// status line (owner's pick), so the viewer sees it where they pressed Send.
// The camera goes off; the take stays on screen; Done closes the stage.
function showLetterSent(text) {
  clearInterval(letterCountdown);
  clearInterval(letterFrameTimer);
  if (letterStream) {
    letterStream.getTracks().forEach((t) => t.stop());
    letterStream = null;
  }
  letterAttempt = null;
  letterState = 'sent';
  showRedoConfirm(false);
  letterButtons({ record: false, redo: false, send: false });
  const cancel = document.getElementById('letterCancelBtn');
  if (cancel) cancel.textContent = 'Done';
  setLetterStatus(text);
}

// A Holler's later news (queued, approved, on air): in the open recorder's
// status line while it shows "Sent", else under the Holler block.
function showHollerResult(text) {
  const stage = document.getElementById('letterStage');
  if (letterState === 'sent' && stage && stage.style.display !== 'none') setLetterStatus(text);
  else showMessage(escapeHtml(text), 'success', 'holler');
}

function toggleLetterRecording() {
  const cfg = lettersCfg();
  if (!cfg || !letterStream) return;
  const recordBtn = document.getElementById('letterRecordBtn');
  const video = document.getElementById('letterVideo');

  if (letterState === 'recording') {
    try { letterRecorder.stop(); } catch { /* noop */ }
    return;
  }

  const mime = recorderMime();
  if (!mime) {
    showMessage('❌ This browser cannot record video (no MediaRecorder).', 'error', 'holler');
    return;
  }
  letterChunks = [];
  letterAttempt = null; // a new take is a new send
  letterRecorder = new MediaRecorder(letterStream, { mimeType: mime });
  letterRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) letterChunks.push(e.data);
  };
  // Sample a few small frames while recording — the AI review (if the
  // server has it configured) checks these alongside the transcript.
  letterFrames = [];
  clearInterval(letterFrameTimer);
  letterFrameTimer = setInterval(() => {
    try {
      if (letterFrames.length >= 5 || !video.videoWidth) return;
      const c = document.createElement('canvas');
      c.width = 320;
      c.height = Math.round(320 * (video.videoHeight / video.videoWidth)) || 180;
      c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
      letterFrames.push(c.toDataURL('image/jpeg', 0.6));
    } catch { /* sampling is best-effort */ }
  }, 900);
  const startedAt = Date.now();
  letterRecorder.onstop = () => {
    clearInterval(letterCountdown);
    clearInterval(letterFrameTimer);
    letterDurationS = Math.max(1, Math.ceil((Date.now() - startedAt) / 1000));
    letterBlob = new Blob(letterChunks, { type: mime.split(';')[0] });
    letterState = 'preview';
    // Preview the take: swap the live camera for the recorded blob.
    video.srcObject = null;
    setLetterPreview(video, letterBlob);
    video.muted = false;
    video.controls = true;
    recordBtn.textContent = 'Record';
    // Too short to be verifiable on stream → never offer to charge for it.
    // The server rejects this too; refusing here means the person finds out
    // before a wallet prompt rather than after one.
    const minS = cfg.minSeconds ?? 3;
    if (letterDurationS < minS) {
      letterButtons({ record: false, redo: true, send: false });
      setLetterStatus(
        `That take was ${letterDurationS}s — Hollers need at least ${minS}s. ` +
        'Shorter clips can\'t be reliably shown on stream, so we won\'t charge for one. Give it another go.',
        'error',
      );
      return;
    }
    letterAttempt = newLetterAttempt();
    letterButtons({ record: false, redo: true, send: true });
    const takePrice = letterPriceForTake(cfg, letterDurationS);
    setLetterStatus(letterIsFreeRoom(cfg) ? `${letterDurationS}s recorded. Send it.` : `${letterDurationS}s recorded. Send for ${formatDollars(takePrice)}.`);
    const sendBtn = document.getElementById('letterSendBtn');
    if (sendBtn) sendBtn.textContent = letterIsFreeRoom(cfg) ? 'Send' : `Send · ${formatDollars(takePrice)}`;
  };
  letterRecorder.start();
  letterState = 'recording';
  letterButtons({ record: true, redo: false, send: false });
  let left = cfg.maxSeconds;
  recordBtn.textContent = `Stop (${left}s)`;
  letterCountdown = setInterval(() => {
    left -= 1;
    recordBtn.textContent = `Stop (${left}s)`;
    if (left <= 0 && letterRecorder && letterRecorder.state === 'recording') {
      try { letterRecorder.stop(); } catch { /* noop */ }
    }
  }, 1000);
}

// Re-record discards a finished take, so it asks first, in place: the stage's
// buttons give way to "Discard this take?" Discard / Keep it.
function showRedoConfirm(on) {
  const box = document.getElementById('letterRedoConfirm');
  if (box) box.style.display = on ? '' : 'none';
  const ctl = document.getElementById('letterControls');
  if (ctl) ctl.style.display = on ? 'none' : '';
}

function askRedoLetter() {
  if (letterState === 'preview' && letterBlob) { showRedoConfirm(true); return; }
  void redoLetter();
}

async function redoLetter() {
  showRedoConfirm(false);
  const video = document.getElementById('letterVideo');
  letterBlob = null;
  letterAttempt = null;
  letterState = 'idle';
  setLetterPreview(video, null);
  video.srcObject = letterStream;
  video.muted = true;
  video.controls = false;
  video.play().catch(() => {});
  letterButtons({ record: true, redo: false, send: false });
  setLetterStatus('Rolling again — hit Record when ready.');
}

async function sendLetter() {
  const cfg = lettersCfg();
  if (!cfg || !letterBlob || letterState === 'sending' || letterState === 'sent') return;
  const username = (document.getElementById('username').value || '').trim();
  if (!username) {
    showMessage('Pick a username first — it labels your Holler on stream.', 'error', 'holler');
    return;
  }
  const letterIsFree = letterIsFreeRoom(cfg);
  const takePrice = letterPriceForTake(cfg, letterDurationS);
  if (!account && !letterIsFree) {
    const MW = getMegaWallet();
    if (MW && MW.configured) await connectPrivyWallet('holler');
    else await connectMetaMask('holler');
    if (!account) return;
  }
  const attempt = letterAttempt || (letterAttempt = newLetterAttempt());
  letterState = 'sending';
  try {
    let upData = null;
    // Twice at most: an upload slot the server no longer has (404) is asked
    // for again under the same take id, and the server decides whether that
    // pays (letters.js: a take it already has costs nothing).
    for (let round = 0; round < 2 && !upData; round++) {
      if (!attempt.uploadUrl) {
        setLetterStatus(letterIsFree ? 'Sending…' : `Paying ${formatDollars(takePrice)}…`);
        const sent = await submitLetter(cfg, username, letterIsFree, attempt.id, takePrice);
        if (sent.alreadySent) {
          showLetterSent('📮 That take was already sent — no second charge.');
          return;
        }
        attempt.letterId = sent.letterId;
        attempt.uploadUrl = sent.uploadUrl;
      }
      myLetterId = attempt.letterId;
      try {
        upData = await uploadLetter(attempt);
      } catch (err) {
        if (err.status !== 404 || round === 1) throw err;
        attempt.letterId = null;
        attempt.uploadUrl = null;
      }
    }
    // overlayLive: false = the streamer's OBS overlay isn't connected, so the
    // clip HOLDS in the queue — saying "on stream shortly" there was a lie
    // that cost a solo tester their clip.
    const held = upData.overlayLive === false
      ? ' Heads up: the stream overlay isn\'t online yet — your Holler is safely queued and plays the moment it connects.'
      : '';
    showLetterSent(
      (upData.status === 'reviewing'
        ? '🔎 Holler sent — quick automated review (a few seconds), then it queues.'
        : upData.status === 'pending_approval'
          ? (letterIsFree
            ? '📮 Holler sent — the streamer approves Hollers before they play.'
            : '📮 Holler sent — the streamer approves Hollers before they play. You were charged; rejects auto-refund.')
          : '📮 Holler sent! It will pop up on stream shortly — watch the preview above (it runs on a slight delay).') + held,
    );
  } catch (err) {
    letterState = 'preview';
    // The person is looking at the RECORDING STAGE, not the page banner —
    // a blank status line here read as "nothing happened". Show the reason
    // right where their eyes are; the banner still carries the full story.
    const why = '❌ ' + shortTxReason(err?.message);
    if (err && (err.status === 410 || err.status === 507)) {
      // The server refunded this take's payment, so the next Send is a new
      // payment, under a new name.
      letterAttempt = newLetterAttempt();
      setLetterStatus(why + '. Send again to pay and upload it.');
    } else if (letterAttempt && letterAttempt.uploadUrl) {
      setLetterStatus(why + ' — your take is still here, and Send again only retries the upload.');
    } else {
      setLetterStatus(why + ' — your take is still here, try Send again.');
    }
    await showTxError('Holler failed', err, { need: takePrice, where: 'holler' });
  }
}

// The paid half of a send: one voucher for the take's seconds, named by the take.
// Free letters skip the payment session entirely — plain fetch, no wallet.
// The stub must still quack like a session: close() gets called after
// submit, and a missing method threw right there, killing the upload
// ("Sending…" then silence).
async function submitLetter(cfg, username, letterIsFree, attemptId, takePrice) {
  // Paid ones ride a one-voucher session at the take's price (same rails as ticks).
  const session = letterIsFree
    ? { fetch: (u, i) => fetch(u, i), close: async () => {} }
    : await buildMppManager(takePrice);
  const resp = await session.fetch(
    `/api/letter/submit?room=${encodeURIComponent(streamRoomId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room: streamRoomId,
        username,
        address: account,
        durationS: letterDurationS,
        mime: letterBlob.type || 'video/webm',
        replayKeepDays: shownKeepDays,
        attemptId,
        ...stingerSelections('letter'), ...campaignField(),
      }),
    },
  );
  const data = await resp.json().catch(() => ({}));
  // This take reached the streamer on an earlier Send whose answer was lost.
  if (resp.status === 409 && data.reason === 'already_sent') return { alreadySent: true };
  if (!resp.ok || !data.letterId) {
    throw new Error(data.error || `Holler submit failed (${resp.status})`);
  }
  session.close().catch(() => { /* nothing unspent; channel just closes */ });
  return { letterId: data.letterId, uploadUrl: data.uploadUrl };
}

// The unpaid half: frames, then the clip, to the slot the payment opened. The
// error carries the status, because a 410/507 means the server refunded.
async function uploadLetter(attempt) {
  // Frames ride ahead of the clip so an AI review has them at hand.
  if (letterFrames.length) {
    await fetch(`/api/letter/frames/${attempt.letterId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frames: letterFrames }),
    }).catch(() => { /* review falls back to transcript-only */ });
  }
  setLetterStatus('Uploading your clip…');
  const up = await fetch(attempt.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': letterBlob.type || 'video/webm' },
    body: letterBlob,
  });
  const upData = await up.json().catch(() => ({}));
  if (!up.ok) {
    const err = new Error(upData.error || 'Upload failed');
    err.status = up.status;
    throw err;
  }
  return upData;
}

// ─── Identity (minted by Privy sign-in, server-verified) ────────────────────
// No chooser here anymore: the header pill opens Privy's modal, which covers
// Twitch / X / Google / email / passkey in ONE step, and the server mints the
// handle from that verified session. This just prefills the username with it.
async function initAuthUi() {
  const prefill = (name) => {
    const input = document.getElementById('username');
    // Never clobber something the viewer typed themselves.
    if (input && input.dataset.userEdited !== 'true' && name) input.value = name.slice(0, 25);
  };
  try {
    // Shared with the header and every other reader on the page (lib/identity.ts).
    const identity = await fetchIdentity();
    if (identity) return prefill(identity.handle);
    // No server handle (e.g. the mint is failing) but a Privy session exists —
    // still prefill their name. Being signed in must never look like being
    // anonymous.
    const MW = getMegaWallet();
    if (MW && MW.authenticated && MW.displayName) prefill(MW.displayName);
  } catch { /* identity optional */ }
}

async function init() {
  try {
    await loadConfig();
    mountStreamPreview();
    initLetterUi();
    applyFeatureVisibility();
    applyModeText();
    applyFreeRoomUi();
    void initAuthUi();
    const camp = campaignField().campaign;
    if (camp) void mountCampaignBanner(camp);
  } catch (err) {
    console.error('Failed to load config', err);
    if (err && err.status === 404) {
      showRoomNotFound();
      return;
    }
    // Anything else may work on a retry (the network, a restart).
    showMessage(
      'Could not load this room. Refresh to retry, or find another room on the <a class="addr" href="/app">Rooms page</a>.',
      'error',
    );
  }
  initWallet();
}

// A link to no room (owner's pick vr-unknown-room): the strip and the tab say
// so, and the console gives way to the not-found card (join-client
// RoomNotFound): browse live rooms, or type a room code. No name, sign-in,
// wallet or entrance controls are left for a room that does not exist.
function showRoomNotFound() {
  const name = document.getElementById('joinRoomName');
  if (name) name.textContent = 'Room not found';
  const state = document.getElementById('joinRoomState');
  if (state) state.style.display = 'none';
  const body = document.querySelector('.join-console-body');
  if (body) body.style.display = 'none';
  const title = 'Room not found — Holler';
  document.title = title;
  // Next's static metadata re-applies its <title> after hydration (loadConfig).
  setTimeout(() => { document.title = title; }, 1500);
  window.dispatchEvent(new CustomEvent('room:notfound'));
}

// ─── Pass C: watch-to-earn (ported verbatim from public/rewards.js) ──────
function initRewardsClient(wsUrl) {
  let wallet = null;
  let rws = null;
  let cfg = null;
  let reconnectTimer = null;
  let retries = 0;
  let started = false;

  function getRoomId() {
    return window.__streamRoomId || 'default';
  }

  // The seat socket's capped backoff: 1 s doubling to 15 s, plus jitter. It
  // used to retry every 3 s forever, from every open tab (audit web-32).
  function scheduleRetry() {
    const delay = Math.min(15000, 1000 * 2 ** Math.min(retries, 4)) + Math.floor(Math.random() * 400);
    retries += 1;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect() {
    if (abort.signal.aborted) return;
    let sock;
    try {
      sock = new WebSocket(wsUrl);
    } catch (e) {
      console.warn('[rewards] ws connect failed', e);
      scheduleRetry();
      return;
    }
    rws = sock;

    sock.addEventListener('open', () => {
      retries = 0;
      sendVisibility();
      registerWallet();
    });

    sock.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      switch (msg.type) {
        case 'rewards_config':
          cfg = msg;
          // The server sends the balance with the state, earning or not
          // (rewards.js keptFor), so a paused or superseded page keeps it.
          if (msg.earned != null) lastEarned = msg.earned;
          renderRewardsLine();
          break;
        case 'rewards_earned':
          renderEarned(msg);
          break;
        case 'rewards_error':
          console.warn('[rewards] payout error:', msg.message);
          break;
        default:
          break;
      }
    });

    sock.addEventListener('close', () => {
      // A page that has gone, or a socket this client replaced on purpose
      // (sign-in, below): nothing to retry.
      if (abort.signal.aborted || sock !== rws) return;
      scheduleRetry();
    });

    sock.addEventListener('error', () => { /* close handler will retry */ });
  }

  function send(obj) {
    if (rws && rws.readyState === 1) {
      try { rws.send(JSON.stringify(obj)); } catch { /* ignore */ }
    }
  }

  // Sent on every open, wallet or not: cash and credit rewards pay the
  // signed-in account (the server reads it at the socket's upgrade), and a
  // connected wallet only adds points and watch time (money-1).
  function registerWallet() {
    send({ type: 'rewards_register', roomId: getRoomId(), ...(wallet ? { wallet } : {}) });
  }

  function sendVisibility() {
    send({ type: 'rewards_visibility', visible: document.visibilityState === 'visible' });
  }

  function setWallet(addr) {
    if (!addr) return;
    wallet = addr;
    registerWallet();
  }

  // ── The payout wallet, added in place (owner's pick) ──
  // Cash and credit rewards pay the signed-in account's payout wallet. The
  // hint's button opens a sheet right here: one tap for the viewer's own
  // Holler wallet, or a pasted address; saved through the same route and
  // client helper as the bounty claim (bounty-api setPayoutWallet).
  const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

  function hollerWalletAddress() {
    if (walletMode === 'privy' && account && EVM_ADDRESS.test(account)) return account;
    const MW = getMegaWallet();
    return MW && MW.authenticated && MW.address && EVM_ADDRESS.test(MW.address) ? MW.address : null;
  }

  function payoutResult(text, tone) {
    const el = document.getElementById('payoutResult');
    if (!el) return;
    el.textContent = text || '';
    el.dataset.tone = tone || '';
  }

  function payoutControls(show) {
    const form = document.getElementById('payoutForm');
    if (form) form.hidden = !show;
    const use = document.getElementById('payoutUseHoller');
    if (use) use.hidden = !show || !hollerWalletAddress();
  }

  function openPayoutSheet() {
    const sheet = document.getElementById('payoutSheet');
    if (!sheet) return;
    const holler = hollerWalletAddress();
    const use = document.getElementById('payoutUseHoller');
    if (use && holler) use.textContent = `Use my Holler wallet (${shortAddr(holler)})`;
    const input = document.getElementById('payoutAddress');
    if (input) input.value = '';
    const close = document.getElementById('payoutClose');
    if (close) close.textContent = 'Cancel';
    payoutResult('');
    payoutControls(true);
    sheet.hidden = false;
    if (!holler && input) input.focus();
  }

  function closePayoutSheet() {
    const sheet = document.getElementById('payoutSheet');
    if (sheet) sheet.hidden = true;
  }

  let payoutSaving = false;
  async function savePayout(raw) {
    if (payoutSaving) return;
    const address = String(raw || '').trim();
    if (!EVM_ADDRESS.test(address)) {
      payoutResult('That is not a wallet address: 0x followed by 40 letters and numbers (0–9, a–f).', 'error');
      return;
    }
    payoutSaving = true;
    const buttons = ['payoutUseHoller', 'payoutSave'].map((id) => document.getElementById(id)).filter(Boolean);
    buttons.forEach((b) => { b.disabled = true; });
    payoutResult('Saving…');
    try {
      const out = await setPayoutWallet(address);
      payoutControls(false);
      payoutResult(`Saved. This room now pays ${shortAddr(out.payoutWallet || address)} for watching.`, 'success');
      const close = document.getElementById('payoutClose');
      if (close) close.textContent = 'Done';
      // The server reads the payout wallet when the socket registers: ask
      // again, and the earning starts (rewards_config comes back enabled).
      registerWallet();
    } catch (err) {
      payoutResult((err && err.message) || 'Could not save the wallet. Try again.', 'error');
    } finally {
      payoutSaving = false;
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  // "Sign in to start": the same sign-in the paid actions run. Signing in
  // mints the identity, and the socket reconnects on megachat:identity, so
  // the line turns to "Earning" on the server's next answer.
  async function signInToEarn() {
    const btn = document.getElementById('rewardsSignIn');
    if (btn) btn.disabled = true;
    try {
      const addr = await connectPrivyWallet('rewards');
      // The line says it now; the "Signed in" note would only repeat it.
      if (addr) clearMessage('rewards');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  {
    const on = (id, type, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(type, fn, { signal: abort.signal });
    };
    on('rewardsSignIn', 'click', () => void signInToEarn());
    on('rewardsPayoutBtn', 'click', openPayoutSheet);
    on('payoutUseHoller', 'click', () => void savePayout(hollerWalletAddress()));
    on('payoutForm', 'submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('payoutAddress');
      void savePayout(input && input.value);
    });
    on('payoutClose', 'click', closePayoutSheet);
  }

  // ── The rewards line (owner's picks rw-earned-in-seat-meter, rw-hint-hidden,
  // rw-pause-silent) ──
  // One green line at the top of the console, in every rewards room: the
  // terms ("1 point every 30 s, up to 50"), this viewer's state, the balance
  // whenever it is known, and the one step that starts earning. The server
  // pushes the state on pause, resume and takeover (rewards.js), so the line
  // never promises earning that is not happening.
  let lastEarned = null; // this room's balance for this viewer, as last told
  let lastCapped = false;

  // An amount of the reward: dollars for USDC (cash, or USDC seat balance),
  // "N points" for points, else the room token's symbol.
  function rewardUnit(amount, withUnit = true) {
    const sym = (cfg && cfg.symbol) || 'USDC';
    if (/^USDC(?:\.e)?$/i.test(sym)) return formatDollars(amount);
    const n = String(amount);
    if (!withUnit) return n;
    if (/^PTS$/i.test(sym)) return `${n} point${Number(n) === 1 ? '' : 's'}`;
    return `${n} ${sym}`;
  }

  function rewardTerms() {
    const every = Number(cfg.earnInterval) || 60;
    const cap = Number(cfg.earnCap) > 0 ? `, up to ${rewardUnit(cfg.earnCap, false)}` : '';
    return `${rewardUnit(cfg.earnAmount)} every ${every} s${cap}`;
  }

  function balanceOfCap() {
    const cap = Number(cfg.earnCap) > 0 ? cfg.earnCap : null;
    const earned = lastEarned != null ? lastEarned : '0';
    return cap != null ? `${rewardUnit(earned, false)} of ${rewardUnit(cap, false)}` : rewardUnit(earned);
  }

  // "your 7 points are kept" — only when there is something to keep.
  function keptNote() {
    if (lastEarned == null || !(Number(lastEarned) > 0)) return '';
    const amt = rewardUnit(lastEarned);
    const one = amt.startsWith('$') || Number(lastEarned) === 1; // "$0.05 is", "1 point is"
    return ` · your ${amt} ${one ? 'is' : 'are'} kept`;
  }

  function renderRewardsLine() {
    const line = document.getElementById('rewardsLine');
    const state = document.getElementById('rewardsState');
    if (!line || !state || !cfg) return;
    const signIn = document.getElementById('rewardsSignIn');
    const payout = document.getElementById('rewardsPayoutBtn');
    const reason = cfg.enabled ? null : cfg.reason;
    const maxed = cfg.enabled && (lastCapped || (Number(cfg.earnCap) > 0 && lastEarned != null && Number(lastEarned) >= Number(cfg.earnCap)));
    let text = null;
    if (cfg.enabled) {
      text = maxed
        ? `Maxed · ${balanceOfCap()} in this room`
        : `Earning · ${balanceOfCap()} · ${rewardUnit(cfg.earnAmount)} every ${Number(cfg.earnInterval) || 60} s`;
    } else if (reason === 'sign_in_required' || reason === 'wallet_required' || reason === 'payout_wallet_required') {
      // Not earning yet, and the viewer can change that: the terms, and the step.
      text = rewardTerms() + keptNote();
    } else if (reason === 'room_not_live') {
      text = 'Paused by the streamer' + keptNote();
    } else if (reason === 'superseded') {
      text = 'Earning in another tab' + keptNote();
    } else if (reason !== 'rewards_off' && keptNote()) {
      // Not this viewer's to fix (the room's payout set-up): the balance stays.
      text = 'Not earning right now' + keptNote();
    }
    line.hidden = text == null;
    line.dataset.state = cfg.enabled ? (maxed ? 'maxed' : 'earning') : String(reason || '');
    state.textContent = text || '';
    if (signIn) signIn.hidden = !(reason === 'sign_in_required' || reason === 'wallet_required');
    if (payout) payout.hidden = reason !== 'payout_wallet_required';
    if (reason !== 'payout_wallet_required') {
      const sheet = document.getElementById('payoutSheet');
      // A saved wallet is the sheet's own news ("Saved…", Done): keep it open.
      if (sheet && !cfg.enabled) sheet.hidden = true;
    }
  }

  function renderEarned(msg) {
    if (msg.earned != null) lastEarned = msg.earned;
    lastCapped = !!msg.capped;
    renderRewardsLine();
  }

  document.addEventListener('visibilitychange', sendVisibility, { signal: abort.signal });

  window.addEventListener('wallet:connected', (e) => {
    if (e.detail && e.detail.account) setWallet(e.detail.account);
  }, { signal: abort.signal });

  // No socket at all in a room that pays nothing for watching (most rooms):
  // the room, and whether it rewards, is known once its config has loaded.
  window.addEventListener('stream:room', (e) => {
    if (started) return registerWallet();
    const roomCfg = (e && e.detail) || CONFIG;
    if (!roomCfg || !roomCfg.rewardsEnabled) return;
    started = true;
    connect();
  }, { signal: abort.signal });

  // The server learns who is signed in once, at the socket's upgrade (cash and
  // credit rewards pay the signed-in account, money-1), so a sign-in on this
  // page needs a new socket for its watch time to count.
  window.addEventListener('megachat:identity', () => {
    if (!started || abort.signal.aborted) return;
    // A different viewer now: the balance shown is theirs, from the server.
    lastEarned = null;
    lastCapped = false;
    const old = rws;
    rws = null;
    clearTimeout(reconnectTimer);
    retries = 0;
    if (old) { try { old.close(); } catch { /* already closed */ } }
    connect();
  }, { signal: abort.signal });

  // NEVER window.ethereum here. This used to ask it for accounts the moment the
  // page loaded — and with more than one wallet extension installed (MetaMask +
  // Phantom), window.ethereum is Phantom's proxy and ANY call on it pops "Which
  // extension do you want to connect with?" at a visitor who only clicked a
  // room. A returning MetaMask viewer is still registered silently, so their
  // watch time counts from page load as it always did — but through
  // MetaMask's OWN provider, found via EIP-6963, where eth_accounts never
  // prompts and Phantom's chooser is not involved.
  void findMetaMask().then((mm) => {
    if (!mm || abort.signal.aborted) return;
    mm.request({ method: 'eth_accounts' })
      .then((accts) => { if (accts && accts[0]) setWallet(accts[0]); })
      .catch(() => {});
    try {
      mm.on && mm.on('accountsChanged', (accts) => { if (accts && accts[0]) setWallet(accts[0]); });
    } catch { /* a provider without events is still a provider */ }
  });

  return () => {
    clearTimeout(reconnectTimer);
    if (rws) { try { rws.close(); } catch { /* ignore */ } }
  };
}

/**
 * Mount the join page. Call once from the page's useEffect; returns cleanup.
 */
export function initJoinPage({ wsUrl }) {
  streamRoomId = parseStreamRoomFromUrl();
  window.__streamRoomId = streamRoomId;
  mySeatId = null;
  mySeatToken = null;
  abort = new AbortController();
  camMsgBound = false;

  // Control WS with auto-reconnect: a network blip must NOT kill the seat.
  // On reconnect we re-subscribe the room and re-register the seat so the
  // server cancels its grace timer and meter updates resume on the fresh
  // socket. Transport-only — message handling is unchanged.
  let wsRetries = 0;
  let wsReconnectTimer = null;

  const scheduleSeatWsRetry = () => {
    const delay = Math.min(15000, 1000 * 2 ** Math.min(wsRetries, 4))
      + Math.floor(Math.random() * 400);
    wsRetries += 1;
    console.log(`[ws] connection lost — retrying in ${delay}ms`);
    wsReconnectTimer = setTimeout(connectSeatWs, delay);
  };

  const connectSeatWs = () => {
    if (abort.signal.aborted) return;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      // Constructor can throw synchronously (no network stack, exotic
      // environments) — the retry loop must survive that too.
      scheduleSeatWsRetry();
      return;
    }

    ws.onopen = () => {
      wsRetries = 0;
      console.log('Connected');
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'subscribe_room', room: streamRoomId }));
        if (mySeatId) {
          sendSeat('register_seat');
          // A GO LIVE the server has not answered (pressed while the socket
          // was down, or its answer lost with the old socket) goes out again.
          if (cameraLiveFired && !serverLive) askToGoLive();
        }
      }
    };
    ws.onerror = (err) => console.error('WebSocket error:', err);
    ws.onclose = () => {
      if (abort.signal.aborted) return;
      scheduleSeatWsRetry();
    };


    // Live meter + seat lifecycle updates from the server.
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      // Letter lifecycle toasts are seat-independent (senders usually have
      // no seat) — handle them before the seat guard.
      if (msg.type === 'letter_play' && msg.letter && msg.letter.id === myLetterId) {
        showHollerResult('▶ Your Holler is on stream RIGHT NOW — the preview above shows it after a slight delay.');
        return;
      }
      if (msg.type === 'letter_queued' && msg.letterId === myLetterId) {
        if (msg.status === 'queued') {
          showHollerResult(
            msg.overlayLive === false
              ? "✅ Review passed — your Holler is queued. The stream overlay isn't online yet; it plays the moment it connects."
              : '✅ Review passed — your Holler is queued and will pop up on stream shortly.',
          );
        } else if (msg.status === 'pending_approval') {
          showHollerResult(
            msg.flagged
              ? (lettersCfg() && letterIsFreeRoom(lettersCfg())
                ? '🕵️ The automated review flagged your Holler — the streamer will approve or reject it.'
                : '🕵️ The automated review flagged your Holler — the streamer will approve or reject it (rejects refund).')
              : '📮 Your Holler awaits the streamer\'s approval.',
          );
        }
        return;
      }
      if (!mySeatId) return;
      // The server putting this seat live: the broadcast when it happens, or
      // the room's live list on a (re)subscribe if that broadcast was missed.
      if (
        (msg.type === 'seat_added' && msg.seat && msg.seat.id === mySeatId)
        || (msg.type === 'initial_state' && Array.isArray(msg.seats) && msg.seats.some((s) => s && s.id === mySeatId))
      ) {
        onSeatLive();
      } else if (msg.type === 'meter_update' && msg.seatId === mySeatId) {
        showMeter(msg.remaining, msg.spent, msg.secondsLeft);
      } else if (msg.type === 'seat_removed' && msg.seatId === mySeatId) {
        hideMeter();
        // Every way a seat can end gets its own message — a viewer should
        // never have to guess whether they left, got kicked, or broke.
        if (msg.reason === 'out_of_funds') {
          showMessage('Out of funds. Your seat ended. Add funds to rejoin.', 'error', 'seat');
        } else if (msg.reason === 'kicked') {
          showMessage(
            '🚫 The streamer removed you from the stream. You were only charged for the time you were on camera — the rest stays in your wallet.',
            'error',
            'seat'
          );
        } else if (msg.reason === 'payment_stalled') {
          showMessage(
            '⚠️ Your payment ticks stopped reaching the server, so the seat ended. Unspent balance stays in your wallet — rejoin when your connection is stable.',
            'error',
            'seat'
          );
        } else if (msg.reason === 'not_found') {
          // We reconnected after the server's grace expired.
          showMessage(
            '⚠️ Connection was down too long — your seat ended and unused balance was returned. Rejoin when ready.',
            'error',
            'seat'
          );
        } else if (msg.reason === 'camera_timeout') {
          // These two used to end the seat without a word (audit web-2).
          showMessage(
            roomIsFree()
              ? '⚠️ Your camera never went live, so the seat ended. Rejoin when your camera is ready.'
              : '⚠️ Your camera never went live, so the seat ended. Unspent balance stays in your wallet — rejoin when your camera is ready.',
            'error',
            'seat'
          );
        } else if (msg.reason === 'disconnected') {
          showMessage(
            roomIsFree()
              ? '⚠️ Your connection dropped for too long, so the seat ended. Rejoin when you are back.'
              : '⚠️ Your connection dropped for too long, so the seat ended. Unspent balance stays in your wallet — rejoin when you are back.',
            'error',
            'seat'
          );
        }
        stopMppTicks(true); // server already settles on kick; close is a no-op race
        teardownCameraStage();
        mySeatId = null;
        mySeatToken = null;
        setJoinState('idle');
        // The setup controls come back, as after a leave: "Add funds to
        // rejoin" was said with the Add funds button still hidden.
        setSessionUi(false);
        refreshBalance();
      } else if (msg.type === 'seat_refused' && msg.seatId === mySeatId) {
        // The server would not take this tab's word that it holds the seat
        // (its token did not match: a stale tab, or a bug). Logged without
        // the token. Nothing here can put the seat on air, so stop billing
        // and showing it as ours rather than stall; the server ends the
        // unclaimed seat on its own timer.
        console.warn(`[seat] ${msg.type} for ${msg.seatId}: ${msg.reason}`);
        stopMppTicks(true);
        teardownCameraStage();
        mySeatId = null;
        mySeatToken = null;
        setJoinState('idle');
        hideMeter();
        setSessionUi(false);
        showMessage('⚠️ This tab could not confirm it holds that seat, so it is not on air. Join again to take a fresh seat.', 'error', 'seat');
      }
    };
  };
  connectSeatWs();

  // Deliberate exits (tab close / navigate away) still free the seat
  // instantly: the WS close alone now has a reconnect grace on the server,
  // so fire an explicit leave beacon.
  // keepalive fetch, not sendBeacon: the leave carries the seat token as JSON,
  // and a beacon can only send a safelisted content type.
  window.addEventListener('pagehide', (e) => {
    if (mySeatId && !e.persisted) {
      try {
        seatPost(`/api/leave/${mySeatId}`, {}, { keepalive: true }).catch(() => { /* best effort */ });
      } catch { /* best effort */ }
    }
  }, { signal: abort.signal });

  // Same handlers the original page bound via inline onclick attributes.
  const on = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn, { signal: abort.signal });
  };
  on('connectBtn', () => connectMetaMask('wallet'));
  on('depositBtn', fundWallet);
  // ONE button through the whole flow: Join Stream → (connect/authorize) →
  // Waiting for camera → Go Live → You're LIVE.
  on('joinBtn', onJoinButtonClick);
  on('camRetryBtn', retryCamera);
  // The entrance and exit are one choice, shown in two places.
  document.addEventListener('change', syncStingers, { signal: abort.signal });
  // Re-render presentation on Simple/Advanced toggle (values unchanged).
  window.addEventListener('mc-ui-mode-changed', () => {
    updatePriceDisplay();
    initLetterUi();
    renderWallet();
    applyModeText();
    if (lastMeter) showMeter(lastMeter.remaining, lastMeter.spent, lastMeter.secondsLeft);
  }, { signal: abort.signal });

  // Returning Privy session → adopt it SILENTLY. Asking an already-signed-in
  // person to sign in again was the single most-reported bug in this app.
  // No modal, no signing — pure state adoption; the wallet only signs later,
  // when a paid action actually needs it.
  const adoptExistingSession = () => {
    const MW = getMegaWallet();
    if (account || walletMode || !MW || !MW.configured) return;
    if (MW.authenticated && MW.address) {
      walletMode = 'privy';
      account = MW.address;
      renderWallet();
      window.dispatchEvent(new CustomEvent('wallet:connected', { detail: { account } }));
      refreshBalance();
    }
  };
  window.addEventListener('megawallet:changed', adoptExistingSession, { signal: abort.signal });
  adoptExistingSession();

  // Privy sign-in mints the handle server-side — reflect it without a reload.
  window.addEventListener('megachat:identity', () => { void initAuthUi(); }, { signal: abort.signal });
  // A Privy session can land after first paint: prefill its name without a
  // refresh. megawallet:changed fires on every bridge update (the modal
  // opening, the SDK getting ready), so only a change in who is signed in
  // asks again (audit web-35).
  const walletWho = () => {
    const MW = getMegaWallet();
    return MW && MW.authenticated ? `in:${MW.displayName || ''}` : 'out';
  };
  let lastWalletWho = walletWho(); // init() below asks for this state
  window.addEventListener('megawallet:changed', () => {
    const who = walletWho();
    if (who === lastWalletWho) return;
    lastWalletWho = who;
    void initAuthUi();
  }, { signal: abort.signal });

  // Letter mode controls (button hidden unless the room enables letters).
  on('letterBtn', () => void openLetterStage());
  on('letterRecordBtn', toggleLetterRecording);
  on('letterRedoBtn', askRedoLetter);
  on('letterRedoYes', () => void redoLetter());
  on('letterRedoNo', () => showRedoConfirm(false));
  on('letterSendBtn', () => void sendLetter());
  on('letterCancelBtn', closeLetterStage);
  // Click-to-copy the connected address (delegated: the chip is re-injected
  // whenever renderWallet rewrites #walletInfo or fundWallet writes #message).
  on('walletInfo', onAddrCopyClick);
  for (const id of ['message', ...Object.values(MESSAGE_BOX)]) on(id, onAddrCopyClick);

  // The room's liveness (join-client polls it): the Twitch player shows only
  // while the channel is live.
  window.addEventListener('room:liveness', (e) => {
    const d = e && e.detail;
    if (!d) return;
    channelLiveNow = d.channelLive === true || d.onAir === true;
    syncLivePreview();
  }, { signal: abort.signal });

  const usernameEl = document.getElementById('username');
  if (usernameEl) {
    if (!usernameEl.value) {
      let name = guestName();
      try { name = sessionStorage.getItem('mc-guest-name') || name; sessionStorage.setItem('mc-guest-name', name); } catch { /* storage optional */ }
      usernameEl.value = name;
    }
    usernameEl.addEventListener('input', () => { usernameEl.dataset.userEdited = 'true'; }, { signal: abort.signal });
    // Enter commits the name and nothing else: a text field never starts a
    // paid action (it used to run Call in, past a paused or Holler-only room).
    usernameEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      usernameEl.blur();
    }, { signal: abort.signal });
  }

  // Re-render wallet buttons whenever the Privy bridge state changes (it
  // mounts after this init runs, and login completes asynchronously).
  window.addEventListener('megawallet:changed', () => {
    const MW = getMegaWallet();
    // Adopt a session restored by Privy (returning user, still signed in).
    if (MW && MW.configured && MW.authenticated && MW.address && !account) {
      walletMode = 'privy';
      account = MW.address;
      window.dispatchEvent(new CustomEvent('wallet:connected', { detail: { account } }));
      refreshBalance();
    }
    renderWallet();
  }, { signal: abort.signal });

  // Exposed for parity with the original global-scope page (and testing).
  Object.assign(window, {
    connectMetaMask, connectPrivyWallet, fundWallet, joinSeat,
    goLive, retryCamera, leaveStream, onJoinSuccess, refreshBalance,
    // display-only tx-error helpers — exposed so gates can exercise the
    // humanizer through the REAL message pipeline without burning funds
    showTxError, humanTxErrorHtml,
  });

  init();
  const cleanupRewards = initRewardsClient(wsUrl);

  return () => {
    abort.abort();
    cleanupRewards();
    clearTimeout(camFallbackTimer);
    clearTimeout(camErrorTimer);
    clearTimeout(liveAskTimer);
    clearTimeout(wsReconnectTimer);
    // ws always points at the CURRENT socket (reconnects rebind it).
    try { ws.close(); } catch { /* ignore */ }
  };
}
