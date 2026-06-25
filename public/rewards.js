// ─── Pass C: watch-to-earn (isolated client) ─────────────────────────────────
//
// Self-contained. Opens its OWN WebSocket, tracks the connected wallet + tab
// focus (Page Visibility API), and shows "earned this session" next to the
// spend meter. It never touches the Pass A / Pass B join code.
(function () {
  'use strict';

  let wallet = null;
  let ws = null;
  let cfg = null;

  function connect() {
    try {
      const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${wsProto}//${location.host}`);
    } catch (e) {
      console.warn('[rewards] ws connect failed', e);
      return;
    }

    ws.addEventListener('open', () => {
      sendVisibility();
      registerWallet();
    });

    ws.addEventListener('message', (event) => {
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
          break; // ignore A/B traffic
      }
    });

    ws.addEventListener('close', () => {
      // Reconnect so earning resumes after a blip.
      setTimeout(connect, 3000);
    });

    ws.addEventListener('error', () => { /* close handler will retry */ });
  }

  function send(obj) {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
    }
  }

  function registerWallet() {
    if (wallet) send({ type: 'rewards_register', wallet });
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
    const label = el.querySelector('span');
    if (label) {
      label.textContent = cfg.dryRun
        ? 'earned this session (sim)'
        : 'earned this session';
    }
  }

  function renderEarned(msg) {
    const meter = document.getElementById('meter');
    if (meter) meter.classList.add('show'); // reveal so earnings show pre-join
    const el = document.getElementById('rewardsEarned');
    if (el) {
      const amount = msg.earnedSession != null ? msg.earnedSession : '0';
      el.textContent = `${amount} USDC` + (msg.capped ? ' (cap)' : '');
    }
  }

  // Track tab focus.
  document.addEventListener('visibilitychange', sendVisibility);

  // Discover the wallet: react to the main UI connecting, and also pick up an
  // already-authorized account on load.
  window.addEventListener('wallet:connected', (e) => {
    if (e.detail && e.detail.account) setWallet(e.detail.account);
  });

  if (window.ethereum) {
    window.ethereum.request({ method: 'eth_accounts' })
      .then((accts) => { if (accts && accts[0]) setWallet(accts[0]); })
      .catch(() => {});
    window.ethereum.on && window.ethereum.on('accountsChanged', (accts) => {
      if (accts && accts[0]) setWallet(accts[0]);
    });
  }

  connect();
})();
