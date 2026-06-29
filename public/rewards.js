// ─── Optional rewards client (isolated — never touches join/meter core) ───────
(function () {
  'use strict';

  let wallet = null;
  let ws = null;
  let cfg = null;

  function getRoomId() {
    return window.__streamRoomId || 'default';
  }

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
          break;
      }
    });

    ws.addEventListener('close', () => {
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

  document.addEventListener('visibilitychange', sendVisibility);

  window.addEventListener('wallet:connected', (e) => {
    if (e.detail && e.detail.account) setWallet(e.detail.account);
  });

  window.addEventListener('stream:room', () => registerWallet());

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
