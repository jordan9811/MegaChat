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
    if (q && /^[a-z0-9-]{1,32}$/i.test(q)) return q.toLowerCase();
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
  window.__streamRoomId = streamRoomId;
  window.dispatchEvent(new CustomEvent('stream:room'));
  const earnedRow = document.getElementById('earnedRow');
  if (earnedRow) {
    earnedRow.style.display = (CONFIG.rewards && CONFIG.rewards.enabled) ? '' : 'none';
  }
  if (CONFIG.roomName) {
    document.title = CONFIG.roomName + ' — Join';
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

function updatePriceDisplay() {
  if (!CONFIG) return;
  const sym = tokenSymbol();
  const amt = document.getElementById('priceAmount');
  const lbl = document.getElementById('priceLabel');
  // One meter on Tempo — every wallet mode streams at the same per-second rate.
  const tickPrice = CONFIG.passkeyTickPrice || CONFIG.tickPrice;
  const tickSec = CONFIG.passkeyTickSeconds || 1;
  if (amt) amt.textContent = `${tickPrice} ${sym}`;
  if (lbl) {
    lbl.textContent =
      `${tickPrice} ${sym} / ${tickSec}s · cap ${CONFIG.maxSession} ${sym} · Tempo`;
  }
}

function formatTimeLeft(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function showMeter(remaining, spent, secondsLeft) {
  const sym = tokenSymbol();
  const box = document.getElementById('meter');
  box.classList.add('show');
  document.getElementById('meterRemaining').textContent = `${remaining} ${sym}`;
  document.getElementById('meterSpent').textContent = `${spent} ${sym}`;
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

const JOIN_BTN_STATES = {
  idle: { label: '🎬 Join Stream', disabled: false },
  busy: { label: '⏳ Processing…', disabled: true },
  'awaiting-camera': { label: '⏳ Waiting for camera…', disabled: true },
  'go-live': { label: '🎥 Go Live', disabled: false },
  live: { label: "🔴 You're LIVE", disabled: true },
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
  // busy / awaiting-camera / live: disabled anyway — ignore stray clicks.
}

async function connectMetaMask() {
  walletMode = 'metamask';
  return connectWallet();
}

const PRIVY_SIGNIN_LABEL = '🔐 Sign in';
const PRIVY_CREATE_LABEL = '✨ Sign up — email or passkey';

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

  if (account && walletMode === 'privy') {
    connectBtn.disabled = true;
    passkeyBtn.disabled = true;
    passkeyBtn.textContent = '🟢 Signed in';
    if (passkeyCreateBtn) passkeyCreateBtn.style.display = 'none';
    connectBtn.textContent = '🦊 Connect MetaMask';
    info.innerHTML = `🟢 Connected · Wallet: ${addrChip(account)}<br>Network: Tempo`;
    if (fundNote) {
      fundNote.style.display = 'block';
      fundNote.innerHTML =
        `Fund this wallet by sending <strong>${tokenSymbol()}</strong> on ` +
        '<strong>Tempo</strong> to the address above (tap it to copy).';
    }
    if (dep) { dep.style.display = ''; dep.disabled = false; }
    if (join && joinBtnState === 'idle') setJoinState('idle');
    return;
  }

  if (fundNote) fundNote.style.display = 'none';
  if (dep) dep.style.display = '';
  if (passkeyCreateBtn) passkeyCreateBtn.style.display = '';

  if (account && walletMode === 'metamask') {
    connectBtn.textContent = '🟢 🦊 Connected';
    connectBtn.disabled = true;
    passkeyBtn.disabled = true;
    if (passkeyCreateBtn) passkeyCreateBtn.disabled = true;
    info.innerHTML = `🟢 Connected · Wallet: ${addrChip(account)}<br>Network: Tempo (MetaMask)`;
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
      'No injected wallet — sign in with email or passkey above, or install MetaMask.';
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
    `💧 Send <strong>${tokenSymbol()}</strong> on <strong>Tempo</strong> to ${addrChip(account)}<br>` +
    `<a class="addr" href="${CONFIG.explorerUrl}/address/${account}" target="_blank" rel="noopener">View on explorer</a>` +
    `<p style="margin-top:10px;font-size:0.85rem;">Balance updates automatically once the transfer lands.</p>`,
    'success'
  );
  refreshBalance();
  for (const delay of [5000, 12000]) setTimeout(refreshBalance, delay);
}

// Unified metered join (both wallet modes): fetch session terms, authorize
// the session cap with ONE wallet action, then confirm the seat.
// Phase 2 note: the authorize step is a plain ERC-20 approve for now (the
// proven fallback); the MPP session channel replaces it in the next phase.
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
    if (!account) {
      setJoinState('busy', '🔐 Signing in…');
      const addr = await connectPrivyWallet('auto');
      if (!addr) {
        setJoinState('idle');
        return;
      }
    }

    await ensureTempoChain();
    // ONE metered flow for both wallet modes on Tempo.
    await joinSeatMetered(username);
  } catch (error) {
    console.error('Error:', error);
    showMessage('❌ ' + (error.message || 'Connection error. Try again.'), 'error');
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
  showMeter(data.remaining, '0', data.secondsLeft);
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
  setJoinState('live');
  setCamStatus('live', "You're LIVE on stream");
  document.getElementById('camHint').textContent =
    'Leaving (button or closing the tab) stops the meter. Unspent balance stays in your wallet.';
  document.getElementById('camRetryBtn').classList.remove('show');
  // Now live — offer an explicit Leave button (same effect as a tab close).
  document.getElementById('leaveBtn').classList.add('show');
  // Detector self-view has done its job; tear it down to save bandwidth.
  const det = document.getElementById('camDetector');
  det.src = 'about:blank';
}

// Leave instantly — same as closing the tab.
async function leaveStream() {
  const seatId = mySeatId;
  if (!seatId) return;
  const leaveBtn = document.getElementById('leaveBtn');
  leaveBtn.disabled = true;
  // Stop reacting to this seat locally right away so the meter stops instantly.
  mySeatId = null;
  teardownCameraStage();
  try {
    await fetch(`/api/leave/${seatId}`, { method: 'POST' });
  } catch (e) {
    console.warn('leave request failed (server still drops seat on disconnect)', e);
  }
  leaveBtn.disabled = false;
  setJoinState('idle');
  showMessage(
    '👋 You left the stream. Unspent balance remains in your wallet.',
    'success'
  );
  // Back to pre-join: show the wallet's available balance as "Remaining".
  refreshBalance();
}

// Manual fallback button.
function goLive() { fireCameraReady('manual'); }

// Stop publishing + hide the stage (seat ended).
function teardownCameraStage() {
  clearTimeout(camFallbackTimer);
  clearTimeout(camErrorTimer);
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

async function init() {
  try {
    await loadConfig();
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

  const connectSeatWs = () => {
    if (abort.signal.aborted) return;
    ws = new WebSocket(wsUrl);

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
      const delay = Math.min(15000, 1000 * 2 ** Math.min(wsRetries, 4))
        + Math.floor(Math.random() * 400);
      wsRetries += 1;
      console.log(`[ws] connection lost — retrying in ${delay}ms`);
      wsReconnectTimer = setTimeout(connectSeatWs, delay);
    };

    // Live meter + seat lifecycle updates from the server.
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!mySeatId) return;
      if (msg.type === 'meter_update' && msg.seatId === mySeatId) {
        showMeter(msg.remaining, msg.spent, msg.secondsLeft);
      } else if (msg.type === 'seat_removed' && msg.seatId === mySeatId) {
        document.getElementById('meterTime').textContent = '0:00';
        if (msg.reason === 'out_of_funds') {
          showMessage('⚠️ Out of funds — your seat ended. Deposit more USDC and rejoin.', 'error');
        } else if (msg.reason === 'not_found') {
          // We reconnected after the server's grace expired.
          showMessage(
            '⚠️ Connection was down too long — your seat ended and unused balance was returned. Rejoin when ready.',
            'error'
          );
        }
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
  on('leaveBtn', leaveStream);
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
