// @ts-nocheck
/**
 * Viewer join-page logic (Tempo mainnet).
 *
 * Originally ported verbatim from the Arc-era public/index.html; the camera
 * lifecycle, WS transport, seat state machine, and rewards client are
 * unchanged. The WALLET + PAYMENT layer was rebuilt for Tempo:
 *   - Privy embedded wallets (email/social/passkey) via the window.MegaWallet
 *     bridge installed by components/providers/tempo-wallet.tsx — primary.
 *   - MetaMask stays as the secondary injected-provider path (chain 4217).
 *   - ONE metered join flow for both modes against /api/join/passkey
 *     (session-cap authorize → seat). Circle Gateway deposits/EIP-3009 are
 *     gone — funding is a plain TIP-20 transfer on Tempo.
 */

let CONFIG = null;
let account = null;
let mySeatId = null;
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

// Safe provider accessor: never throws, returns null when no injected wallet.
function getProvider() {
  try {
    return (typeof window !== 'undefined' && window.ethereum) ? window.ethereum : null;
  } catch {
    return null;
  }
}

async function loadConfig() {
  const res = await fetch('/api/config?room=' + encodeURIComponent(streamRoomId));
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to load room config');
  }
  CONFIG = await res.json();
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
  window.dispatchEvent(new CustomEvent('stream:room'));
  const earnedRow = document.getElementById('earnedRow');
  if (earnedRow) {
    earnedRow.style.display = (CONFIG.rewards && CONFIG.rewards.enabled) ? '' : 'none';
  }
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
  return CONFIG.paymentTokenSymbol || 'USDC';
}

// ── Simple/Advanced presentation (see web/lib/ui-mode.ts) ──
// PRESENTATION ONLY: 1 credit = 1 second of Join Stream at the room's rate.
// Same balances, same transactions underneath — nothing in the payment
// path reads this.
function roomIsFree() {
  return !!CONFIG && !(parseFloat(CONFIG.passkeyTickPrice || '1') > 0);
}
// Session mode (audit P1-1/P1-2): once a seat is held, the setup controls
// leave the screen — sign-in cluster, fund row, wallet info — and the
// username locks (editing it mid-session does nothing). All restored on leave.
function setSessionUi(inSession) {
  for (const id of ['privyChoice', 'connectBtn', 'depositBtn', 'walletInfo', 'passkeyFundNote']) {
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
  for (const id of ['privyChoice', 'connectBtn', 'depositBtn', 'walletInfo', 'passkeyFundNote']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
}

function uiSimple() {
  return typeof document !== 'undefined'
    && document.documentElement.dataset.ui === 'simple';
}
function perCreditUsd() {
  const p = parseFloat((CONFIG && (CONFIG.passkeyTickPrice || CONFIG.tickPrice)) || '0.001');
  return p > 0 ? p : 0.001;
}
function credits(usdc) {
  const n = parseFloat(usdc || '0');
  if (!isFinite(n)) return '0';
  return String(Math.max(0, Math.round(n / perCreditUsd())));
}
function fmtAmount(usdc) {
  return uiSimple() ? `${credits(usdc)} credits` : `${usdc} ${tokenSymbol()}`;
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
    const haveTxt = amt.have != null && isFinite(amt.have) ? fmtAmount(trimAmt(amt.have)) : null;
    const needTxt = amt.need != null && isFinite(amt.need) ? fmtAmount(trimAmt(amt.need)) : null;
    const line =
      haveTxt != null && needTxt != null
        ? `Not enough balance — you have ${haveTxt}, this costs ${needTxt}.`
        : 'Not enough balance for this.';
    return `${line} <button type="button" class="tx-addfunds" onclick="fundWallet()">➕ Add funds</button>`;
  }
  if (/user rejected|user denied|rejected the request/i.test(rawFull)) {
    return 'You cancelled the request in your wallet.';
  }
  return "The payment didn't go through. " + txDetailsBlock(rawFull);
}

async function showTxError(prefix, err, ctx) {
  const html = await humanTxErrorHtml(err, ctx);
  showMessage('❌ ' + (prefix ? prefix + ': ' : '') + html, 'error');
}
let lastMeter = null;
function applyModeText() {
  const dep = document.getElementById('depositBtn');
  if (dep) dep.textContent = uiSimple() ? '➕ Add funds' : '💧 Fund wallet';
}

function joinStreamEnabled() {
  // Older servers don't send the block — treat absent as enabled.
  return !CONFIG || !CONFIG.joinStream || CONFIG.joinStream.enabled !== false;
}

function updatePriceDisplay() {
  if (!CONFIG) return;
  const sym = tokenSymbol();
  const amt = document.getElementById('priceAmount');
  const lbl = document.getElementById('priceLabel');
  const tickPrice = CONFIG.passkeyTickPrice || CONFIG.tickPrice;
  const tickSec = CONFIG.passkeyTickSeconds || 1;
  const mc = CONFIG.letters && CONFIG.letters.enabled ? CONFIG.letters : null;
  if (joinStreamEnabled() && roomIsFree()) {
    if (amt) amt.textContent = 'FREE';
    if (lbl) lbl.textContent = 'this room is free — hop on camera, no wallet needed';
  } else if (joinStreamEnabled()) {
    if (uiSimple()) {
      if (amt) amt.textContent = '1 credit';
      if (lbl) lbl.textContent = `per second on camera · session cap ${credits(CONFIG.maxSession)} credits`;
    } else {
      // One meter on Tempo — every wallet mode streams at the same rate.
      if (amt) amt.textContent = `${tickPrice} ${sym}`;
      if (lbl) {
        lbl.textContent =
          `${tickPrice} ${sym} / ${tickSec}s · cap ${CONFIG.maxSession} ${sym} · Tempo`;
      }
    }
  } else if (mc) {
    // MegaChats-only room: the headline price is the flat MegaChat price.
    if (amt) amt.textContent = fmtAmount(mc.price);
    if (lbl) lbl.textContent = `per MegaChat · up to ${mc.maxSeconds}s · recorded, plays once`;
  } else {
    if (amt) amt.textContent = '—';
    if (lbl) lbl.textContent = 'Nothing is enabled in this room right now.';
  }
}

// Hide the live-path controls entirely in MegaChats-only rooms.
function applyFeatureVisibility() {
  if (!CONFIG) return;
  const on = joinStreamEnabled();
  const joinBtn = document.getElementById('joinBtn');
  const leaveBtn = document.getElementById('leaveBtn');
  if (joinBtn) joinBtn.style.display = on ? '' : 'none';
  if (leaveBtn && !on) leaveBtn.classList.remove('show');
}

function formatTimeLeft(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function showMeter(remaining, spent, secondsLeft) {
  lastMeter = { remaining, spent, secondsLeft };
  const box = document.getElementById('meter');
  box.classList.add('show');
  document.getElementById('meterRemaining').textContent = fmtAmount(remaining);
  document.getElementById('meterSpent').textContent = fmtAmount(spent);
  document.getElementById('meterTime').textContent = formatTimeLeft(secondsLeft);
}

// ─── helpers ─────────────────────────────────────────────────────────────
function b64encode(obj) {
  const json = JSON.stringify(obj);
  // UTF-8 safe base64
  return btoa(unescape(encodeURIComponent(json)));
}
function b64decode(str) {
  return JSON.parse(decodeURIComponent(escape(atob(str))));
}
function strip0x(h) { return h.startsWith('0x') ? h.slice(2) : h; }
function pad32(hexNo0x) { return hexNo0x.toLowerCase().padStart(64, '0'); }
function encodeAddress(addr) { return pad32(strip0x(addr)); }
function encodeUint(value) { return pad32(BigInt(value).toString(16)); }

// parse a decimal USDC string into 6-decimal atomic units (BigInt)
function parseUsdc(amountStr) {
  const [whole, frac = ''] = String(amountStr).split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  return BigInt(whole || '0') * 1000000n + BigInt(fracPadded || '0');
}
function formatUsdc(atomic) {
  const v = BigInt(atomic);
  const whole = v / 1000000n;
  const frac = (v % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
function randomNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function ensureEthereum() {
  const eth = getProvider();
  if (!eth) {
    throw new Error('No wallet detected. Install MetaMask or open this page in a wallet browser.');
  }
  return eth;
}

// Opt-in overlay stinger picks from the Advanced expander. Empty selection
// sends nothing → server stores null → overlay plays its defaults.
function stingerSelections() {
  const val = (id) => document.getElementById(id)?.value || undefined;
  return { flyIn: val('flyInSelect'), flyOut: val('flyOutSelect') };
}

// ─── Join button state machine ────────────────────────────────────────────
// ONE button morphs through the whole flow (no separate Go Live button):
//   idle → busy (connect/authorize) → awaiting-camera → go-live → live
// Click routing lives in the joinBtn handler; every transition goes through
// setJoinState so no code path can leave the label out of sync again.
let joinBtnState = 'idle';

// ONE state-morphing control (audit P0-1): no disabled dead-ends. The
// camera wait can be cancelled, and while live the same button IS the
// leave action — there is no sibling Leave button anymore.
const JOIN_BTN_STATES = {
  idle: { label: '🎬 Join Stream', disabled: false },
  busy: { label: '⏳ Processing…', disabled: true },
  'awaiting-camera': { label: '⏳ Waiting for camera — tap to cancel', disabled: false },
  'go-live': { label: '🎥 Go Live', disabled: false },
  live: { label: "🔴 You're LIVE — tap to leave", disabled: false },
};

function setJoinState(state, labelOverride) {
  const preset = JOIN_BTN_STATES[state] || JOIN_BTN_STATES.idle;
  joinBtnState = JOIN_BTN_STATES[state] ? state : 'idle';
  const btn = document.getElementById('joinBtn');
  if (!btn) return;
  btn.textContent = labelOverride || preset.label;
  btn.disabled = preset.disabled
    || (joinBtnState === 'idle' && CONFIG && CONFIG.roomActive === false);
}

function onJoinButtonClick() {
  if (joinBtnState === 'go-live') return goLive();
  if (joinBtnState === 'idle') return joinSeat();
  // The same control exits the flow: cancel a hung camera wait, or leave
  // the stream while live (audit P0-1 — no dead-ends, no button pairs).
  if (joinBtnState === 'awaiting-camera' || joinBtnState === 'live') {
    return leaveStream();
  }
  // busy: disabled — ignore stray clicks.
}

async function connectMetaMask() {
  walletMode = 'metamask';
  return connectWallet();
}

const PRIVY_SIGNIN_LABEL = '🔐 Sign in — Google, email or passkey';
const PRIVY_CREATE_LABEL = '✨ Google, email or passkey';

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
 * both new and returning users, so 'register' vs 'login' only changes labels).
 */
async function connectPrivyWallet(mode) {
  const btn = document.getElementById('passkeyBtn');
  const createBtn = document.getElementById('passkeyCreateBtn');
  const clicked = mode === 'register' ? (createBtn || btn) : btn;
  const MW = getMegaWallet();
  if (!MW || !MW.configured) {
    showMessage(
      'Privy sign-in is not configured on this server yet (set NEXT_PUBLIC_PRIVY_APP_ID in .env and restart). MetaMask still works below.',
      'error'
    );
    return null;
  }
  try {
    btn.disabled = true;
    if (createBtn) createBtn.disabled = true;
    clicked.textContent = '⏳ Waiting for sign-in…';
    walletMode = 'privy';
    updatePriceDisplay();
    account = null; // clear any stale MetaMask address

    const addr = await MW.connect();
    account = addr;
    renderWallet();
    window.dispatchEvent(new CustomEvent('wallet:connected', { detail: { account } }));
    await refreshBalance();
    showMessage('✅ Signed in — wallet ready on Tempo.', 'success');
    return account;
  } catch (err) {
    walletMode = null;
    account = null;
    console.error('[privy]', err);
    showMessage('❌ ' + ((err && err.message) || 'Sign-in failed'), 'error');
    renderWallet();
    return null;
  } finally {
    if (!(account && walletMode === 'privy')) {
      btn.disabled = false;
      btn.textContent = PRIVY_SIGNIN_LABEL;
      if (createBtn) {
        createBtn.disabled = false;
        createBtn.textContent = PRIVY_CREATE_LABEL;
      }
    }
  }
}

async function connectWallet() {
  try {
    const eth = ensureEthereum();
    // First account read happens HERE — only after an explicit Connect.
    const accounts = await eth.request({ method: 'eth_requestAccounts' });
    if (!accounts || !accounts.length) {
      showMessage('🔒 Wallet is locked or no account is shared. Unlock MetaMask and try again.', 'error');
      return null;
    }
    account = accounts[0];
    walletMode = 'metamask';
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
    showMessage('❌ ' + msg, 'error');
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

// Display-only: middle-truncated address so the connected line never wraps.
// Full address stays available via the title tooltip AND click-to-copy.
function shortAddr(addr) {
  const a = String(addr || '');
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
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

// Clickable, abbreviated address chip that copies the FULL value.
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

// Delegated on #walletInfo so it survives the innerHTML rerenders.
function onWalletInfoCopyClick(e) {
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
  const passkeyBtn = document.getElementById('passkeyBtn');
  const passkeyCreateBtn = document.getElementById('passkeyCreateBtn');
  const fundNote = document.getElementById('passkeyFundNote');
  const dep = document.getElementById('depositBtn');
  const join = document.getElementById('joinBtn');
  if (!info || !connectBtn || !passkeyBtn) return;

  const privyChoice = document.getElementById('privyChoice');

  if (roomIsFree()) { applyFreeRoomUi(); return; }

  if (account && walletMode === 'privy') {
    // Connected — the paths not taken LEAVE the screen (no dulled clutter):
    // sign up / sign in grid gone, MetaMask row gone, Fund takes the row.
    if (privyChoice) privyChoice.style.display = 'none';
    connectBtn.style.display = 'none';
    if (dep) dep.style.gridColumn = '1 / -1';
    info.innerHTML =
      `<span class="adv-only">🟢 Connected · Wallet: ${addrChip(account)}<br>Network: Tempo</span>` +
      `<span class="simple-only">🟢 Signed in — your balance is ready.<br>` +
      `<details class="addr-details"><summary>account details</summary>` +
      `Account address (tap to copy): ${addrChip(account)}</details></span>`;
    if (fundNote) {
      fundNote.style.display = 'block';
      fundNote.innerHTML =
        `<span class="adv-only">Fund this wallet by sending <strong>${tokenSymbol()}</strong> on ` +
        '<strong>Tempo</strong> to the address above (tap it to copy).</span>' +
        '<span class="simple-only">Add funds any time — 1 credit costs $' +
        String(perCreditUsd()) + '. Your account details are just above.</span>';
    }
    if (dep) { dep.style.display = ''; dep.disabled = false; }
    if (join && joinBtnState === 'idle') setJoinState('idle');
    return;
  }

  if (fundNote) fundNote.style.display = 'none';
  if (dep) { dep.style.display = ''; dep.style.gridColumn = ''; }
  if (passkeyCreateBtn) passkeyCreateBtn.style.display = '';
  if (privyChoice) privyChoice.style.display = '';
  connectBtn.style.display = '';

  if (account && walletMode === 'metamask') {
    // Same rule the other way: the Privy grid leaves; the MetaMask chip
    // stays as the one connected-state indicator.
    if (privyChoice) privyChoice.style.display = 'none';
    connectBtn.textContent = '🟢 🦊 Connected';
    connectBtn.disabled = true;
    info.innerHTML =
      `<span class="adv-only">🟢 Connected · Wallet: ${addrChip(account)}<br>Network: Tempo (MetaMask)</span>` +
      `<span class="simple-only">🟢 Signed in — your balance is ready.<br>` +
      `<details class="addr-details"><summary>account details</summary>` +
      `Account address (tap to copy): ${addrChip(account)}</details></span>`;
    if (dep) dep.disabled = false;
    if (join && joinBtnState === 'idle') setJoinState('idle');
    return;
  }

  connectBtn.disabled = !hasWallet;
  const MW = getMegaWallet();
  const privyReady = !!(MW && MW.configured);
  passkeyBtn.disabled = !privyReady;
  if (passkeyCreateBtn) passkeyCreateBtn.disabled = !privyReady;
  if (!hasWallet) {
    connectBtn.textContent = '🦊 No MetaMask detected';
    info.innerHTML =
      '<span class="adv-only">No injected wallet — sign in with email or passkey above, or install MetaMask.</span>' +
      '<span class="simple-only">Sign in with email or passkey above to get started.</span>';
  } else {
    connectBtn.textContent = '🦊 Connect MetaMask';
    info.textContent = '';
  }
  // Fund shows the connected address; useless before any wallet exists.
  if (dep) dep.disabled = !hasWallet && !privyReady;
  // Join stays enabled while disconnected — clicking it runs the Privy sign-in
  // (the primary path). The state machine owns it outside idle.
  if (join && joinBtnState === 'idle') setJoinState('idle');
}

// Read the wallet's on-chain balance on Tempo and preview it as "Remaining".
async function refreshBalance() {
  if (!account || mySeatId) return;
  try {
    const res = await fetch(`/api/balance/${account}?room=${encodeURIComponent(streamRoomId)}`);
    const data = await res.json();
    if (!res.ok) return;
    const tickPrice = parseFloat(CONFIG.passkeyTickPrice || CONFIG.tickPrice || '0.001') || 0.001;
    const ticks = Math.floor(parseFloat(data.spendable || '0') / tickPrice);
    showMeter(data.available, '0', ticks * (CONFIG.passkeyTickSeconds || 1));
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
async function fundWallet() {
  if (!account) {
    const MW = getMegaWallet();
    if (MW && MW.configured) await connectPrivyWallet('login');
    else await connectMetaMask();
  }
  if (!account) return;
  showMessage(
    `<span class="adv-only">💧 Send <strong>${tokenSymbol()}</strong> on <strong>Tempo</strong> to ${addrChip(account)}<br>` +
    `<a class="addr" href="${CONFIG.explorerUrl}/address/${account}" target="_blank" rel="noopener">View on explorer</a></span>` +
    `<span class="simple-only">➕ Add funds by sending money to your account: ${addrChip(account)}<br>` +
    `1 credit costs $${perCreditUsd()} in this room.</span>` +
    `<p style="margin-top:10px;font-size:0.85rem;">Balance updates automatically once the transfer lands.</p>`,
    'success'
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
  // it). Failing clean with no money moved is the only safe behavior.
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
          'error'
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
  setJoinState('busy', '⏳ Requesting session terms…');
  const r = await fetch('/api/join/mpp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, address: account, room: streamRoomId, ...stingerSelections() })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = data.available != null
      ? ` (available ${data.available} ${data.tokenSymbol || tokenSymbol()})`
      : '';
    throw new Error((data.hint || data.error || 'Cannot join') + detail);
  }
  onJoinSuccess(data);
}

// Unified metered join (fallback: MetaMask + servers without the MPP meter):
// fetch session terms, authorize the session cap with ONE approve, then the
// server pulls per tick via transferFrom.
async function joinSeatMetered(username) {
  const SEL_APPROVE = '0x095ea7b3'; // approve(address,uint256)

  setJoinState('busy', '⏳ Requesting session terms…');
  const first = await fetch('/api/join/passkey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, address: account, room: streamRoomId, ...stingerSelections() })
  });

  const terms = await first.json().catch(() => ({}));
  if (!first.ok) {
    const detail = terms.available != null
      ? ` (available ${terms.available} ${terms.tokenSymbol || tokenSymbol()})`
      : '';
    throw new Error((terms.hint || terms.error || 'Cannot join') + detail);
  }
  if (terms.useRewardCredit) {
    setJoinState('busy', '⏳ Joining with earned balance…');
    const paid = await fetch('/api/join/passkey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        address: account,
        room: streamRoomId,
        useRewardCredit: true,
      }),
    });
    const data = await paid.json();
    if (paid.ok && data.success) {
      onJoinSuccess(data);
    } else {
      throw new Error(data.reason || data.error || 'Reward join was not accepted');
    }
    return;
  }
  if (!terms.needsApprove) {
    throw new Error('Unexpected join response');
  }

  setJoinState('busy', walletMode === 'privy'
    ? '⏳ Authorizing session…'
    : '⏳ Approve in MetaMask…');
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

  setJoinState('busy', '⏳ Confirming seat…');
  const paid = await fetch('/api/join/passkey', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Modular-Payment': b64encode(payment)
    },
    body: JSON.stringify({ username, address: account, room: streamRoomId, ...stingerSelections() })
  });
  const data = await paid.json();
  if (paid.ok && data.success) {
    onJoinSuccess(data);
  } else {
    throw new Error(data.reason || data.error || 'Join was not accepted');
  }
}

async function joinSeat() {
  const username = document.getElementById('username').value.trim();

  if (!username) {
    showMessage('Please enter a username', 'error');
    return;
  }
  if (joinBtnState !== 'idle') return;

  // Clear the previous attempt's result — a stale error next to a freshly
  // spinning button reads as an instant failure.
  const msgBox = document.getElementById('message');
  if (msgBox) msgBox.className = 'join-message';

  setJoinState('busy');

  try {
    // Privy is the PRIMARY path: an unconnected click runs the sign-in modal
    // right here, shows the connected state, then continues straight into the
    // seat authorization. MetaMask users connect via the secondary button
    // first, which sets walletMode below.
    if (roomIsFree()) {
      // Free room: no wallet, no chain, no session — straight to the seat.
      await joinSeatMpp(username);
      return;
    }
    if (!account) {
      // "Connecting your balance", not "signing in" — a Twitch/X-signed-in
      // viewer IS signed in; this step is about money, and saying "sign in"
      // twice made the two look broken.
      setJoinState('busy', '🔐 Connecting your balance…');
      const addr = await connectPrivyWallet('auto');
      if (!addr) {
        setJoinState('idle');
        return;
      }
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
    // Joining reserves the session cap — that's the "cost" a viewer must
    // cover when the revert says their balance can't.
    await showTxError('', error, { need: CONFIG && CONFIG.maxSession });
  } finally {
    // Success hands the button to the camera states (awaiting-camera →
    // go-live → live); only reset to idle when no seat was granted.
    if (!mySeatId) setJoinState('idle');
  }
}

// ─── Inline camera-publish stage ────────────────────────────────────────
// Vdo.ninja's official IFRAME API — see public/index.html for the full notes.
const VDO_ORIGIN = 'https://vdo.ninja';
let lastJoinData = null;
let cameraLiveFired = false;
let camFallbackTimer = null;
let camErrorTimer = null;
let camMsgBound = false;

function onJoinSuccess(data) {
  mySeatId = data.seatId;
  lastJoinData = data;
  const sym = data.paymentTokenSymbol || tokenSymbol();
  // Bind this WS to the seat so closing the tab instantly frees + refunds it.
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'register_seat', seatId: mySeatId }));
  }
  setSessionUi(true);
  if (!data.free) showMeter(data.remaining, '0', data.secondsLeft);
  if (data.free) {
    showMessage("✅ You're in — this room is FREE. Allow camera access above, then hit GO LIVE.", 'success');
    startCameraStage(data);
    setJoinState('awaiting-camera');
    return;
  }
  const txLink = data.payment && data.payment.transaction
    ? ` · <a class="addr" href="${CONFIG.explorerUrl}/tx/${data.payment.transaction}" target="_blank">authorization tx</a>`
    : '';
  const meterNote =
    `${data.tickPrice} ${sym} every ${data.tickSeconds}s while live (silent after authorize)`;
  const refundNote = `Unspent ${sym} stays in your wallet when you leave.`;
  showMessage(
    `✅ Authorized! Allow camera access above, then hit GO LIVE on the same button. Metering
    (${meterNote}) starts when you're live; ${refundNote}${txLink}`,
    'success'
  );
  startCameraStage(data);
  setJoinState('awaiting-camera');
}

function startCameraStage(data) {
  // LiveKit rooms publish via the SDK — the vdo iframe path never runs.
  if (isLivekitRoom()) return void startLivekitCameraStage(data);
  cameraLiveFired = false;
  const stage = document.getElementById('cameraStage');
  const pub = document.getElementById('camPublisher');
  const det = document.getElementById('camDetector');
  const retryBtn = document.getElementById('camRetryBtn');

  retryBtn.classList.remove('show');
  setCamStatus('', 'Requesting camera…');
  document.getElementById('camHint').textContent =
    location.protocol === 'https:' || location.hostname === 'localhost'
      ? 'Your camera preview is below. (On a phone you must use https.)'
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
    document.getElementById('camHint').textContent =
      'Camera preview showing? Hit GO LIVE above to start.';
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
      document.getElementById('camHint').textContent =
        'Camera connected. Hit GO LIVE above to start your stream.';
    }
  }
}

function setCamStatus(cls, text) {
  const s = document.getElementById('camStatus');
  s.className = 'cam-status' + (cls ? ' ' + cls : '');
  document.getElementById('camStatusText').textContent = text;
}

// Tell the server the camera is live -> the tile appears and the meter starts.
function fireCameraReady(source) {
  if (cameraLiveFired || !mySeatId) return;
  cameraLiveFired = true;
  clearTimeout(camFallbackTimer);
  clearTimeout(camErrorTimer);
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'camera_ready', seatId: mySeatId }));
  }
  console.log(`[camera] camera_ready fired via ${source}`);
  // MPP seats: the meter is client-driven — start streaming paid ticks now.
  // The first tick opens the escrow channel (one silent wallet transaction).
  if (lastJoinData && lastJoinData.paymentMode === 'mpp_session') {
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
  const staleMsg = document.getElementById('message');
  if (staleMsg) staleMsg.className = 'join-message';
  // Detector self-view has done its job; tear it down to save bandwidth.
  const det = document.getElementById('camDetector');
  det.src = 'about:blank';
}

// Leave instantly — same as closing the tab. `quiet` skips the friendly
// goodbye message so failure paths can keep their own error on screen.
async function leaveStream(quiet) {
  const seatId = mySeatId;
  if (!seatId) return;
  setJoinState('busy', '⏳ Leaving…');
  // Stop reacting to this seat locally right away so the meter stops instantly.
  mySeatId = null;
  stopMppTicks(true); // close the channel → unspent deposit refunds from escrow
  teardownCameraStage();
  try {
    await fetch(`/api/leave/${seatId}`, { method: 'POST' });
  } catch (e) {
    console.warn('leave request failed (server still drops seat on disconnect)', e);
  }
  setJoinState('idle');
  setSessionUi(false);
  if (!quiet) {
    showMessage(
      roomIsFree()
        ? '👋 You left the stream.'
        : '👋 You left the stream. Unspent balance remains in your wallet.',
      'success'
    );
  }
  // Back to pre-join: show the wallet's available balance as "Remaining".
  refreshBalance();
}

// Manual fallback button.
function goLive() { fireCameraReady('manual'); }

// Stop publishing + hide the stage (seat ended).
function teardownCameraStage() {
  clearTimeout(camFallbackTimer);
  clearTimeout(camErrorTimer);
  teardownLivekit();
  // Live slot over (leave/kick/removal all land here): drop the real-time
  // host feed, bring the delayed spectate embed back.
  unmountHostFeed();
  mountStreamPreview();
  const stage = document.getElementById('cameraStage');
  const pub = document.getElementById('camPublisher');
  const det = document.getElementById('camDetector');
  const leaveBtn = document.getElementById('leaveBtn');
  if (pub) pub.src = 'about:blank';
  if (det) det.src = 'about:blank';
  if (stage) stage.classList.remove('show');
  if (leaveBtn) leaveBtn.classList.remove('show');
  cameraLiveFired = false;
}

// Rebuild the camera stage after a permission failure.
function retryCamera() {
  if (isLivekitRoom()) {
    teardownLivekit();
    if (lastJoinData) setTimeout(() => startLivekitCameraStage(lastJoinData), 200);
    return;
  }
  const pub = document.getElementById('camPublisher');
  const det = document.getElementById('camDetector');
  pub.src = 'about:blank';
  det.src = 'about:blank';
  if (lastJoinData) setTimeout(() => startCameraStage(lastJoinData), 200);
}

function showMessage(html, type) {
  const msgBox = document.getElementById('message');
  msgBox.innerHTML = html;
  msgBox.className = 'join-message ' + type + ' show';
}

// ─── Init (runs after all state is initialized) ──────────────────────────
function initWallet() {
  const eth = getProvider();
  hasWallet = !!eth;
  if (eth && typeof eth.on === 'function') {
    try {
      // Reflect account/network changes once a wallet is connected.
      eth.on('accountsChanged', (accs) => {
        if (walletMode === 'privy') return;
        account = (accs && accs[0]) || null;
        if (account) walletMode = 'metamask';
        renderWallet();
        if (account) refreshBalance();
      });
      eth.on('chainChanged', () => { /* user can re-trigger via actions */ });
    } catch (e) {
      console.warn('wallet listener setup failed', e);
    }
  }
  // Note: account stays null here on purpose — we only read it on Connect.
  renderWallet();
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
}

function mountStreamPreview() {
  const wrap = document.getElementById('streamPreview');
  const mount = document.getElementById('streamPreviewMount');
  if (!wrap || !mount) return;
  const channel = CONFIG && CONFIG.twitchChannel;
  if (!channel) {
    wrap.style.display = 'none';
    syncPreviewIdle();
    return;
  }
  if (!mount.querySelector('iframe')) {
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
  // Watch-to-earn hint straight from room config (the rewards WS refines it
  // later, but this keeps the hint independent of wallet registration).
  const drops = document.getElementById('streamPreviewDrops');
  if (drops && CONFIG && CONFIG.rewardsEnabled) drops.style.display = '';
  wrap.style.display = '';
  syncPreviewIdle();
}

function hideStreamPreview() {
  const wrap = document.getElementById('streamPreview');
  const mount = document.getElementById('streamPreviewMount');
  if (mount) mount.innerHTML = ''; // iframe removed → guaranteed silent
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
  const attachIfHost = (track, participant) => {
    if (participant.identity !== hostIdentity) return;
    console.log('[livekit] host feed: attaching', track.kind);
    if (track.kind === 'video') track.attach(video);
    if (track.kind === 'audio') {
      const a = track.attach();
      a.style.display = 'none';
      mount.appendChild(a);
      audioEls.push(a);
    }
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
  const onSub = (track, pub, participant) => attachIfHost(track, participant);
  lkRoom.on(lk.RoomEvent.TrackSubscribed, onSub);
  lkHostFeedCleanup = () => {
    try { lkRoom && lkRoom.off(lk.RoomEvent.TrackSubscribed, onSub); } catch { /* down */ }
    audioEls.forEach((a) => a.remove());
  };
  wrap.style.display = '';
  syncPreviewIdle();
}

// ─── LiveKit transport (flag-gated; vdo stays the default, untouched) ───────
// Joiner publish path for rooms with transport === 'livekit'. Same UI state
// machine as vdo: stage → camera preview → GO LIVE → live. The vdo iframes
// are simply never created for these rooms.
let lkRoom = null;
let lkLocalVideo = null;

function isLivekitRoom() {
  return CONFIG && CONFIG.transport === 'livekit';
}

async function startLivekitCameraStage(data) {
  cameraLiveFired = false;
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
    const tokRes = await fetch('/api/livekit/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: streamRoomId, role: 'publisher', seatId: data.seatId }),
    });
    const tok = await tokRes.json().catch(() => ({}));
    if (!tokRes.ok || !tok.token) throw new Error(tok.error || `token failed (${tokRes.status})`);

    const lk = await import('livekit-client');
    lkRoom = new lk.Room({
      adaptiveStream: true,
      // simulcast for smooth degradation (phase 3 requirement, on by default)
      publishDefaults: { simulcast: true },
    });
    await lkRoom.connect(tok.url || (CONFIG && CONFIG.livekitUrl), tok.token);
    await lkRoom.localParticipant.enableCameraAndMicrophone();

    // Local self-view in the SAME frame the vdo iframe used.
    const frame = pub ? pub.parentElement : stage.querySelector('.cam-frame');
    if (frame && !lkLocalVideo) {
      lkLocalVideo = document.createElement('video');
      lkLocalVideo.muted = true;
      lkLocalVideo.playsInline = true;
      lkLocalVideo.className = 'lk-self'; // sized by join.css, stays IN the frame
      frame.appendChild(lkLocalVideo);
    }
    const camPub = [...lkRoom.localParticipant.videoTrackPublications.values()][0];
    if (camPub && camPub.track && lkLocalVideo) camPub.track.attach(lkLocalVideo);

    // Phase-3 payoff: auto-reconnect + connection-quality signals.
    lkRoom.on(lk.RoomEvent.ConnectionStateChanged, (state) => {
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
    lkRoom.on(lk.RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant !== lkRoom.localParticipant) return;
      renderLkQuality(String(quality));
      reportLkQuality(String(quality), data.seatId);
    });

    // Published — same UX beat as the vdo detector firing.
    if (joinBtnState === 'awaiting-camera') {
      setJoinState('go-live');
      setCamStatus('', 'Camera ready — hit GO LIVE');
      document.getElementById('camHint').textContent =
        'Camera connected over LiveKit. Hit GO LIVE above to start your stream.';
    }
  } catch (err) {
    console.error('[livekit] publish failed:', err);
    setCamStatus('error', 'Camera failed — ' + (err?.message || 'unknown'));
    retryBtn.classList.add('show');
  }
}

function teardownLivekit() {
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
  fetch('/api/seat/quality', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatId, quality: q }),
  }).catch(() => { /* cosmetic signal — never block on it */ });
}

// ─── Letter mode: record → preview → pay flat → one-shot upload ─────────────
// Recorded clips sidestep the broadcast delay entirely: the sender watches
// the delayed embed and sees their letter pop up like any other spectator.
let letterState = 'idle'; // idle | recording | preview | sending
let letterRecorder = null;
let letterChunks = [];
let letterBlob = null;
let letterStream = null;
let letterCountdown = null;
let letterDurationS = 0;
let myLetterId = null;
let letterFrames = [];
let letterFrameTimer = null;

function lettersCfg() {
  return CONFIG && CONFIG.letters && CONFIG.letters.enabled ? CONFIG.letters : null;
}

function initLetterUi() {
  const btn = document.getElementById('letterBtn');
  if (!btn) return;
  const cfg = lettersCfg();
  if (!cfg) {
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';
  // Short label — "· up to 10s" pushed the button onto two wrapped lines on
  // mobile, and the recorder stage states the cap the moment it opens.
  btn.textContent = parseFloat(cfg.price) > 0
      ? `📼 Send a MegaChat — ${fmtAmount(cfg.price)}`
      : '📼 Send a MegaChat — FREE';
}

function setLetterStatus(text) {
  const el = document.getElementById('letterStatus');
  if (el) el.textContent = text || '';
}

function letterButtons({ record, redo, send }) {
  const show = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.style.display = on ? '' : 'none';
  };
  show('letterRecordBtn', record);
  show('letterRedoBtn', redo);
  show('letterSendBtn', send);
}

async function openLetterStage() {
  const cfg = lettersCfg();
  if (!cfg) return;
  const stage = document.getElementById('letterStage');
  const video = document.getElementById('letterVideo');
  try {
    letterStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    showMessage('❌ Camera/mic access is needed to record a letter.', 'error');
    return;
  }
  stage.style.display = '';
  video.srcObject = letterStream;
  video.muted = true;
  video.controls = false;
  video.play().catch(() => {});
  letterState = 'idle';
  letterBlob = null;
  letterButtons({ record: true, redo: false, send: false });
  setLetterStatus(`Up to ${cfg.maxSeconds}s. Flat price ${cfg.price} ${tokenSymbol()} — your MegaChat plays once on stream.`);
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
  if (video) {
    video.srcObject = null;
    video.src = '';
  }
  if (stage) stage.style.display = 'none';
  letterState = 'idle';
}

function pickRecorderMime() {
  const candidates = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
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

  const mime = pickRecorderMime();
  if (!mime) {
    showMessage('❌ This browser cannot record video (no MediaRecorder).', 'error');
    return;
  }
  letterChunks = [];
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
    video.src = URL.createObjectURL(letterBlob);
    video.muted = false;
    video.controls = true;
    recordBtn.textContent = '⏺ Record';
    letterButtons({ record: false, redo: true, send: true });
    setLetterStatus(`${letterDurationS}s take — happy with it? Send for ${cfg.price} ${tokenSymbol()}.`);
  };
  letterRecorder.start();
  letterState = 'recording';
  letterButtons({ record: true, redo: false, send: false });
  let left = cfg.maxSeconds;
  recordBtn.textContent = `⏹ Stop (${left}s)`;
  letterCountdown = setInterval(() => {
    left -= 1;
    recordBtn.textContent = `⏹ Stop (${left}s)`;
    if (left <= 0 && letterRecorder && letterRecorder.state === 'recording') {
      try { letterRecorder.stop(); } catch { /* noop */ }
    }
  }, 1000);
}

async function redoLetter() {
  const video = document.getElementById('letterVideo');
  letterBlob = null;
  letterState = 'idle';
  video.src = '';
  video.srcObject = letterStream;
  video.muted = true;
  video.controls = false;
  video.play().catch(() => {});
  letterButtons({ record: true, redo: false, send: false });
  setLetterStatus('Rolling again — hit Record when ready.');
}

async function sendLetter() {
  const cfg = lettersCfg();
  if (!cfg || !letterBlob || letterState === 'sending') return;
  const username = (document.getElementById('username').value || '').trim();
  if (!username) {
    showMessage('Pick a username first — it labels your MegaChat on stream.', 'error');
    return;
  }
  const letterIsFree = !(parseFloat(cfg.price) > 0);
  if (!account && !letterIsFree) {
    const MW = getMegaWallet();
    if (MW && MW.configured) await connectPrivyWallet('login');
    else await connectMetaMask();
    if (!account) return;
  }
  letterState = 'sending';
  setLetterStatus(letterIsFree ? 'Sending…' : `Paying ${cfg.price} ${tokenSymbol()}…`);
  try {
    // Free letters skip the payment session entirely — plain fetch, no wallet.
    // The stub must still quack like a session: close() gets called after
    // submit, and a missing method threw right there, killing the upload
    // ("Sending…" then silence).
    // Paid ones ride a one-voucher session at the flat price (same rails as ticks).
    const session = letterIsFree
      ? { fetch: (u, i) => fetch(u, i), close: async () => {} }
      : await buildMppManager(cfg.price);
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
          ...stingerSelections(),
        }),
      },
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.letterId) {
      throw new Error(data.error || `MegaChat submit failed (${resp.status})`);
    }
    session.close().catch(() => { /* nothing unspent; channel just closes */ });
    myLetterId = data.letterId;
    // Frames ride ahead of the clip so an AI review has them at hand.
    if (letterFrames.length) {
      await fetch(`/api/letter/frames/${data.letterId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frames: letterFrames }),
      }).catch(() => { /* review falls back to transcript-only */ });
    }
    setLetterStatus('Uploading your clip…');
    const up = await fetch(data.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': letterBlob.type || 'video/webm' },
      body: letterBlob,
    });
    const upData = await up.json().catch(() => ({}));
    if (!up.ok) throw new Error(upData.error || 'Upload failed');
    closeLetterStage();
    // overlayLive: false = the streamer's OBS overlay isn't connected, so the
    // clip HOLDS in the queue — saying "on stream shortly" there was a lie
    // that cost a solo tester their clip.
    const held = upData.overlayLive === false
      ? '<br><span style="font-size:0.85em;opacity:0.85">Heads up: the stream overlay isn\'t online yet — your MegaChat is safely queued and plays the moment it connects.</span>'
      : '';
    showMessage(
      (upData.status === 'reviewing'
        ? '🔎 MegaChat sent — quick automated review (a few seconds), then it queues.'
        : upData.status === 'pending_approval'
          ? '📮 MegaChat sent — the streamer approves MegaChats before they play. You were charged; rejects auto-refund.'
          : '📮 MegaChat sent! It will pop up on stream shortly — watch the preview above (it runs on a slight delay).') + held,
      'success',
    );
  } catch (err) {
    letterState = 'preview';
    // The person is looking at the RECORDING STAGE, not the page banner —
    // a blank status line here read as "nothing happened". Show the reason
    // right where their eyes are; the banner still carries the full story.
    setLetterStatus('❌ ' + shortTxReason(err?.message) + ' — your take is still here, try Send again.');
    await showTxError('MegaChat failed', err, { need: cfg && cfg.price });
  }
}

// ─── Identity (minted by Privy sign-in, server-verified) ────────────────────
// No chooser here anymore: the header pill opens Privy's modal, which covers
// Twitch / X / Google / email / passkey in ONE step, and the server mints the
// handle from that verified session. This just reflects the result.
async function initAuthUi() {
  const who = document.getElementById('authIdentity');
  if (!who) return;
  const prefill = (name) => {
    const input = document.getElementById('username');
    // Never clobber something the viewer typed themselves.
    if (input && !input.value && name) input.value = name;
  };
  try {
    const me = await (await fetch('/api/auth/me')).json();
    const identity = me.identity || null;
    if (identity) {
      who.style.display = '';
      who.innerHTML = `🟢 Signed in as <strong>@${identity.handle}</strong>`;
      prefill(identity.handle);
      return;
    }
    // No server handle (e.g. the mint is failing) but a Privy session exists —
    // still greet them by name and prefill it. Being signed in must never
    // look like being anonymous.
    const MW = getMegaWallet();
    if (MW && MW.authenticated && MW.displayName) {
      who.style.display = '';
      who.innerHTML = `🟢 Signed in as <strong>@${MW.displayName}</strong>`;
      prefill(MW.displayName);
      return;
    }
    who.style.display = 'none';
  } catch { /* identity optional */ }

  const welcome = new URLSearchParams(location.search).get('welcome');
  if (welcome) {
    showMessage(`✅ Handle <strong>@${welcome}</strong> is yours — it's your display name and your megachat.xyz/${welcome} link.`, 'success');
  }
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
    const demo = document.getElementById('demoBanner');
    if (demo && CONFIG && CONFIG.isDemo) demo.style.display = '';
  } catch (err) {
    console.error('Failed to load config', err);
    const lbl = document.getElementById('priceLabel');
    if (lbl) {
      lbl.textContent = (err && err.message) || 'Failed to load room';
    }
    showMessage(
      'Could not load room. Open http://localhost:3000 (not 127.0.0.1) and refresh.',
      'error',
    );
  }
  initWallet();
}

// ─── Pass C: watch-to-earn (ported verbatim from public/rewards.js) ──────
function initRewardsClient(wsUrl) {
  let wallet = null;
  let rws = null;
  let cfg = null;
  let reconnectTimer = null;

  function getRoomId() {
    return window.__streamRoomId || 'default';
  }

  function connect() {
    if (abort.signal.aborted) return;
    try {
      rws = new WebSocket(wsUrl);
    } catch (e) {
      console.warn('[rewards] ws connect failed', e);
      return;
    }

    rws.addEventListener('open', () => {
      sendVisibility();
      registerWallet();
    });

    rws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      switch (msg.type) {
        case 'rewards_config':
          cfg = msg;
          updateLabel();
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

    rws.addEventListener('close', () => {
      reconnectTimer = setTimeout(connect, 3000);
    });

    rws.addEventListener('error', () => { /* close handler will retry */ });
  }

  function send(obj) {
    if (rws && rws.readyState === 1) {
      try { rws.send(JSON.stringify(obj)); } catch { /* ignore */ }
    }
  }

  function registerWallet() {
    if (wallet) {
      send({ type: 'rewards_register', wallet, roomId: getRoomId() });
    }
  }

  function sendVisibility() {
    send({ type: 'rewards_visibility', visible: document.visibilityState === 'visible' });
  }

  function setWallet(addr) {
    if (!addr) return;
    wallet = addr;
    registerWallet();
  }

  function updateLabel() {
    // Watch-to-earn hint on the spectate surface (drops accrue while the
    // tab is visible and a wallet is connected — same rules as always).
    const drops = document.getElementById('streamPreviewDrops');
    if (drops) drops.style.display = cfg && cfg.enabled ? '' : 'none';
    const el = document.getElementById('earnedRow');
    if (!el || !cfg) return;
    if (!cfg.enabled) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    const label = el.querySelector('span');
    if (label) {
      label.textContent = cfg.dryRun
        ? 'earned toward join (sim)'
        : 'earned toward join';
    }
  }

  function renderEarned(msg) {
    if (cfg && cfg.enabled === false) return;
    const meter = document.getElementById('meter');
    if (meter) meter.classList.add('show');
    const el = document.getElementById('rewardsEarned');
    if (el) {
      const sym = msg.symbol || 'USDC';
      const amount = msg.joinBalance != null ? msg.joinBalance : (msg.earnedSession != null ? msg.earnedSession : '0');
      el.textContent = `${amount} ${sym}` + (msg.capped ? ' (cap)' : '');
    }
  }

  document.addEventListener('visibilitychange', sendVisibility, { signal: abort.signal });

  window.addEventListener('wallet:connected', (e) => {
    if (e.detail && e.detail.account) setWallet(e.detail.account);
  }, { signal: abort.signal });

  window.addEventListener('stream:room', () => registerWallet(), { signal: abort.signal });

  if (window.ethereum) {
    window.ethereum.request({ method: 'eth_accounts' })
      .then((accts) => { if (accts && accts[0]) setWallet(accts[0]); })
      .catch(() => {});
    window.ethereum.on && window.ethereum.on('accountsChanged', (accts) => {
      if (accts && accts[0]) setWallet(accts[0]);
    });
  }

  connect();

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
          ws.send(JSON.stringify({ type: 'register_seat', seatId: mySeatId }));
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
        showMessage('▶ Your MegaChat is on stream RIGHT NOW — the preview above shows it after a slight delay.', 'success');
        return;
      }
      if (msg.type === 'letter_queued' && msg.letterId === myLetterId) {
        if (msg.status === 'queued') {
          showMessage(
            msg.overlayLive === false
              ? "✅ Review passed — your MegaChat is queued. The stream overlay isn't online yet; it plays the moment it connects."
              : '✅ Review passed — your MegaChat is queued and will pop up on stream shortly.',
            'success',
          );
        } else if (msg.status === 'pending_approval') {
          showMessage(
            msg.flagged
              ? '🕵️ The automated review flagged your MegaChat — the streamer will approve or reject it (rejects refund).'
              : '📮 Your MegaChat awaits the streamer\'s approval.',
            'success',
          );
        }
        return;
      }
      if (!mySeatId) return;
      if (msg.type === 'meter_update' && msg.seatId === mySeatId) {
        showMeter(msg.remaining, msg.spent, msg.secondsLeft);
      } else if (msg.type === 'seat_removed' && msg.seatId === mySeatId) {
        document.getElementById('meterTime').textContent = '0:00';
        // Every way a seat can end gets its own message — a viewer should
        // never have to guess whether they left, got kicked, or broke.
        if (msg.reason === 'out_of_funds') {
          showMessage('⚠️ Out of funds — your seat ended. Deposit more USDC and rejoin.', 'error');
        } else if (msg.reason === 'kicked') {
          showMessage(
            '🚫 The streamer removed you from the stream. You were only charged for the time you were on camera — the rest stays in your wallet.',
            'error'
          );
        } else if (msg.reason === 'payment_stalled') {
          showMessage(
            '⚠️ Your payment ticks stopped reaching the server, so the seat ended. Unspent balance stays in your wallet — rejoin when your connection is stable.',
            'error'
          );
        } else if (msg.reason === 'not_found') {
          // We reconnected after the server's grace expired.
          showMessage(
            '⚠️ Connection was down too long — your seat ended and unused balance was returned. Rejoin when ready.',
            'error'
          );
        }
        stopMppTicks(true); // server already settles on kick; close is a no-op race
        teardownCameraStage();
        mySeatId = null;
        setJoinState('idle');
      }
    };
  };
  connectSeatWs();

  // Deliberate exits (tab close / navigate away) still free the seat
  // instantly: the WS close alone now has a reconnect grace on the server,
  // so fire an explicit leave beacon.
  window.addEventListener('pagehide', (e) => {
    if (mySeatId && !e.persisted) {
      try { navigator.sendBeacon(`/api/leave/${mySeatId}`); } catch { /* best effort */ }
    }
  }, { signal: abort.signal });

  // Same handlers the original page bound via inline onclick attributes.
  const on = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn, { signal: abort.signal });
  };
  on('connectBtn', connectMetaMask);
  on('passkeyBtn', () => connectPrivyWallet('login'));
  on('passkeyCreateBtn', () => connectPrivyWallet('register'));
  on('depositBtn', fundWallet);
  // ONE button through the whole flow: Join Stream → (connect/authorize) →
  // Waiting for camera → Go Live → You're LIVE.
  on('joinBtn', onJoinButtonClick);
  on('camRetryBtn', retryCamera);
  // Wrapped: the click MouseEvent must not land in leaveStream's `quiet` arg.
  on('leaveBtn', () => leaveStream());
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
  // Privy session can land after first paint — re-render the identity line so
  // a returning viewer sees their name without a refresh.
  window.addEventListener('megawallet:changed', () => { void initAuthUi(); }, { signal: abort.signal });

  // Letter mode controls (button hidden unless the room enables letters).
  on('letterBtn', () => void openLetterStage());
  on('letterRecordBtn', toggleLetterRecording);
  on('letterRedoBtn', () => void redoLetter());
  on('letterSendBtn', () => void sendLetter());
  on('letterCancelBtn', closeLetterStage);
  // Click-to-copy the connected address (delegated: the chip is re-injected
  // whenever renderWallet rewrites #walletInfo).
  on('walletInfo', onWalletInfoCopyClick);

  const usernameEl = document.getElementById('username');
  if (usernameEl) {
    usernameEl.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') joinSeat();
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
    clearTimeout(wsReconnectTimer);
    // ws always points at the CURRENT socket (reconnects rebind it).
    try { ws.close(); } catch { /* ignore */ }
  };
}
