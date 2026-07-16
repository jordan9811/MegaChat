/**
 * OAuth identity — "Continue with Twitch / X". IDENTITY ONLY: reserves the
 * platform username as the viewer's MegaChat handle (collision → editable
 * suggestion before claiming). No watch-time verification, no platform
 * drops (roadmap).
 *
 * Credentials come from .env (TWITCH_CLIENT_ID/SECRET, X_CLIENT_ID/SECRET).
 * When absent the endpoints answer 503 and the UI renders disabled buttons —
 * nothing is faked. Endpoint bases are env-overridable so gates can run a
 * local mock IdP through the REAL code path.
 */
import { createHmac, randomBytes, createHash } from 'crypto';
import { claimIdentity, getIdentity, suggestHandle } from './identity-store.js';

const PROVIDERS = {
  twitch: {
    clientId: () => process.env.TWITCH_CLIENT_ID || '',
    clientSecret: () => process.env.TWITCH_CLIENT_SECRET || '',
    authBase: () => process.env.TWITCH_AUTH_BASE || 'https://id.twitch.tv/oauth2',
    apiBase: () => process.env.TWITCH_API_BASE || 'https://api.twitch.tv/helix',
    scope: '', // identity comes from /users with the app token; no scopes needed
    pkce: false,
  },
  x: {
    clientId: () => process.env.X_CLIENT_ID || '',
    clientSecret: () => process.env.X_CLIENT_SECRET || '',
    authBase: () => process.env.X_AUTH_BASE || 'https://twitter.com/i/oauth2',
    tokenBase: () => process.env.X_TOKEN_BASE || 'https://api.twitter.com/2/oauth2',
    apiBase: () => process.env.X_API_BASE || 'https://api.twitter.com/2',
    scope: 'users.read tweet.read',
    pkce: true, // X mandates PKCE
  },
};

const SECRET = () =>
  process.env.AUTH_SECRET || process.env.MPP_SECRET_KEY || 'megachat-dev-secret';

const sign = (payload) =>
  createHmac('sha256', SECRET()).update(payload).digest('base64url');

function setCookie(res, name, value, { maxAge = 600, httpOnly = true } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'SameSite=Lax',
  ];
  if (httpOnly) parts.push('HttpOnly');
  res.append('Set-Cookie', parts.join('; '));
}

function readCookies(req) {
  const out = {};
  for (const pair of String(req.headers.cookie || '').split(';')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

/** value.sig cookies — tamper-evident, stateless. */
const seal = (obj) => {
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${payload}.${sign(payload)}`;
};
const unseal = (sealed) => {
  const [payload, sig] = String(sealed || '').split('.');
  if (!payload || !sig || sign(payload) !== sig) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
};

/**
 * The signed-in identity behind a request, or null. Exported because the
 * dashboard needs to answer "is this handle reserved by THIS person?" — the
 * cookie seal lives here, so the reader does too.
 */
export function readIdentityFromRequest(req) {
  const sess = unseal(readCookies(req).mc_identity);
  if (!sess) return null;
  return getIdentity(sess.provider, sess.platformId);
}

/**
 * Where to send someone after a successful sign-in. ONLY same-origin relative
 * paths: anything else (absolute URL, protocol-relative //evil.com, a
 * backslash Windows/browsers may normalise to /) is dropped on the floor.
 * Without this an attacker could hand out /auth/x?returnTo=https://evil.com
 * and borrow our OAuth flow as a phishing springboard.
 */
function safeReturnTo(raw) {
  const s = String(raw || '');
  if (!s.startsWith('/')) return null;   // must be relative to us
  if (s.startsWith('//')) return null;   // protocol-relative → offsite
  if (s.includes('\\')) return null;     // normalisation tricks
  if (s.startsWith('/auth/')) return null; // don't bounce back into the flow
  return s.slice(0, 512);
}

/**
 * The join page shows a "handle is yours" toast off ?welcome=; nowhere else
 * reads it, and the header chip flipping to @handle already says the same
 * thing there — so don't litter every other URL with a dead param.
 */
function withWelcome(back, handle) {
  if (!back.startsWith('/join')) return back;
  return `${back}${back.includes('?') ? '&' : '?'}welcome=${encodeURIComponent(handle)}`;
}

export function attachAuth(app, { log = console } = {}) {
  const configured = (p) => !!(PROVIDERS[p].clientId() && PROVIDERS[p].clientSecret());
  const redirectUri = (req, p) => `${req.protocol}://${req.get('host')}/auth/${p}/callback`;

  app.get('/api/auth/providers', (req, res) => {
    res.json({
      twitch: configured('twitch'),
      x: configured('x'),
      kick: false, // coming soon
      tiktok: false, // coming soon
    });
  });

  app.get('/api/auth/me', (req, res) => {
    const sess = unseal(readCookies(req).mc_identity);
    if (!sess) return res.json({ identity: null });
    const identity = getIdentity(sess.provider, sess.platformId);
    res.json({ identity: identity ? {
      provider: identity.provider, username: identity.username, handle: identity.handle,
    } : null });
  });

  app.post('/api/auth/logout', (req, res) => {
    setCookie(res, 'mc_identity', '', { maxAge: 0 });
    res.json({ ok: true });
  });

  // ── Start ──────────────────────────────────────────────────────────────────
  app.get('/auth/:provider', (req, res) => {
    const p = req.params.provider;
    const cfg = PROVIDERS[p];
    if (!cfg) return res.status(404).json({ error: 'Unknown provider' });
    if (!configured(p)) {
      return res.status(503).json({ error: `${p} login is not configured on this server` });
    }
    // Come back to whichever page the login button was clicked on. The
    // explicit param wins; Referer is the fallback for a bare /auth/x hit.
    let backTo = safeReturnTo(req.query.returnTo);
    if (!backTo) {
      try { backTo = safeReturnTo(new URL(req.get('referer') || '').pathname); } catch { /* no referer */ }
    }
    const state = randomBytes(16).toString('base64url');
    // Sealed alongside the state, so the destination is tamper-evident too.
    setCookie(res, `mc_oauth_${p}`, seal({ state, t: Date.now(), back: backTo || '/' }));
    const params = new URLSearchParams({
      client_id: cfg.clientId(),
      redirect_uri: redirectUri(req, p),
      response_type: 'code',
      scope: cfg.scope,
      state,
    });
    if (cfg.pkce) {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      setCookie(res, `mc_pkce_${p}`, seal({ verifier }));
      params.set('code_challenge', challenge);
      params.set('code_challenge_method', 'S256');
    }
    res.redirect(302, `${cfg.authBase()}/authorize?${params}`);
  });

  // ── Callback → identity → handle suggestion page ─────────────────────────
  app.get('/auth/:provider/callback', async (req, res) => {
    const p = req.params.provider;
    const cfg = PROVIDERS[p];
    if (!cfg || !configured(p)) return res.status(404).send('Unknown provider');
    const cookies = readCookies(req);
    const st = unseal(cookies[`mc_oauth_${p}`]);
    if (!st || st.state !== req.query.state || Date.now() - st.t > 10 * 60_000) {
      return res.status(400).send('OAuth state mismatch — start again from the join page.');
    }
    if (!req.query.code) return res.status(400).send('Missing authorization code.');
    try {
      let username, platformId;
      if (p === 'twitch') {
        const tokenRes = await fetch(`${cfg.authBase()}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: cfg.clientId(),
            client_secret: cfg.clientSecret(),
            code: String(req.query.code),
            grant_type: 'authorization_code',
            redirect_uri: redirectUri(req, p),
          }),
        });
        const token = await tokenRes.json();
        if (!tokenRes.ok || !token.access_token) throw new Error(token.message || 'token exchange failed');
        const userRes = await fetch(`${cfg.apiBase()}/users`, {
          headers: { Authorization: `Bearer ${token.access_token}`, 'Client-Id': cfg.clientId() },
        });
        const users = await userRes.json();
        const u = users?.data?.[0];
        if (!u) throw new Error('could not read Twitch user');
        username = u.login;
        platformId = u.id;
      } else {
        const pk = unseal(cookies[`mc_pkce_${p}`]);
        if (!pk) throw new Error('missing PKCE verifier');
        const tokenRes = await fetch(`${cfg.tokenBase()}/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + Buffer.from(`${cfg.clientId()}:${cfg.clientSecret()}`).toString('base64'),
          },
          body: new URLSearchParams({
            code: String(req.query.code),
            grant_type: 'authorization_code',
            redirect_uri: redirectUri(req, p),
            code_verifier: pk.verifier,
          }),
        });
        const token = await tokenRes.json();
        if (!tokenRes.ok || !token.access_token) throw new Error(token.error_description || 'token exchange failed');
        const userRes = await fetch(`${cfg.apiBase()}/users/me`, {
          headers: { Authorization: `Bearer ${token.access_token}` },
        });
        const me = await userRes.json();
        if (!me?.data?.username) throw new Error('could not read X user');
        username = me.data.username;
        platformId = me.data.id;
      }

      // Land back where the login button was clicked, not on a random room's
      // checkout page. The header chip flipping to @handle is the receipt.
      const back = safeReturnTo(st.back) || '/';
      // Already claimed → straight back in. Otherwise show the picker with
      // the first free suggestion (spec: collision → suffix picker).
      const existing = getIdentity(p, platformId);
      if (existing) {
        setCookie(res, 'mc_identity', seal({ provider: p, platformId }), { maxAge: 30 * 86400 });
        return res.redirect(302, withWelcome(back, existing.handle));
      }
      const pending = seal({
        provider: p, platformId: String(platformId), username, back, t: Date.now(),
      });
      setCookie(res, 'mc_pending_identity', pending);
      const suggested = suggestHandle(username);
      res.send(pickerHtml(p, username, suggested));
    } catch (err) {
      log.warn(`[auth] ${p} callback failed:`, err.message);
      res.status(502).send(`Sign-in with ${p} failed: ${err.message}`);
    }
  });

  // ── Claim (from the picker) ────────────────────────────────────────────────
  app.post('/api/auth/claim', (req, res) => {
    const pending = unseal(readCookies(req).mc_pending_identity);
    if (!pending || Date.now() - pending.t > 10 * 60_000) {
      return res.status(400).json({ error: 'No pending sign-in — start again' });
    }
    try {
      const identity = claimIdentity({
        provider: pending.provider,
        platformId: pending.platformId,
        username: pending.username,
        handle: (req.body && req.body.handle) || pending.username,
      });
      setCookie(res, 'mc_pending_identity', '', { maxAge: 0 });
      setCookie(res, 'mc_identity', seal({ provider: identity.provider, platformId: identity.platformId }), { maxAge: 30 * 86400 });
      res.json({
        ok: true,
        identity: { provider: identity.provider, username: identity.username, handle: identity.handle },
        // Carried from the sealed pending cookie: back to wherever they started.
        next: withWelcome(safeReturnTo(pending.back) || '/', identity.handle),
      });
    } catch (err) {
      res.status(err.code === 'handle_taken' ? 409 : 400).json({ error: err.message });
    }
  });

  log.log('[auth] OAuth identity attached — twitch:'
    + (configured('twitch') ? 'ready' : 'not configured')
    + ' x:' + (configured('x') ? 'ready' : 'not configured'));
}

/** Minimal dark claim page — posts to /api/auth/claim then returns to /join. */
function pickerHtml(provider, username, suggested) {
  const safe = (s) => String(s).replace(/[<>&"]/g, '');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Claim your handle</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{background:#17121f;color:#eee;font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#221a30;border:1px solid #3a2d52;border-radius:16px;padding:28px;max-width:380px;width:90%}
h1{font-size:1.15rem;margin:0 0 6px}p{color:#a99cc2;font-size:.85rem;line-height:1.5}
input{width:100%;box-sizing:border-box;background:#161022;color:#fff;border:1px solid #3a2d52;border-radius:10px;padding:10px 12px;font-size:1rem;margin:12px 0}
button{width:100%;background:#e91e8c;color:#fff;border:0;border-radius:10px;padding:12px;font-weight:700;font-size:1rem;cursor:pointer}
.err{color:#ff6ab8;font-size:.85rem;min-height:1.2em}</style></head><body>
<div class="card">
<h1>Welcome, ${safe(username)} 👋</h1>
<p>Your ${safe(provider)} account is verified. Claim your permanent MegaChat handle — it becomes your display name and your megachat link.</p>
<input id="h" value="${safe(suggested)}" maxlength="20" autocomplete="off" spellcheck="false">
<div class="err" id="err"></div>
<button id="go">Claim handle</button>
</div>
<script>
document.getElementById('go').onclick = async () => {
  const r = await fetch('/api/auth/claim', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ handle: document.getElementById('h').value }) });
  const d = await r.json().catch(()=>({}));
  if (r.ok) location.href = d.next || '/';
  else document.getElementById('err').textContent = d.error || 'Claim failed';
};
</script></body></html>`;
}
