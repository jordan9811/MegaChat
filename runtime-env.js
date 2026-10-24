/**
 * runtime-env.js — ONE answer to "is this production?" and "what seals a
 * session?" (OPEN-ISSUES K7, 2026-10-24).
 *
 * WHY THIS EXISTS. auth.js fell back to the literal 'megachat-dev-secret'
 * whenever AUTH_SECRET and MPP_SECRET_KEY were both unset, with no production
 * check at all. That literal is in the public repo, so on a production box
 * without either variable anyone could seal a sign-in cookie for any account.
 * And production was detected two ways: server.js by `--prod` (how `npm start`
 * runs it, Railway included), overlay-key.js by NODE_ENV — which Railway does
 * not set. NODE_ENV only ever read 'production' there because Next's router
 * server sets it during `nextApp.prepare()` when it is unset
 * (next/dist/server/lib/router-server.js), so it is false before prepare and
 * true after: a side effect of a dependency, not a signal.
 *
 * isRailway()     RAILWAY_ENVIRONMENT / RAILWAY_ENVIRONMENT_NAME is set
 *                 (Railway injects them into every service). This is "is
 *                 this a DEPLOYED box", a narrower question than
 *                 isProduction(): every gate runs `server.js --prod` on this
 *                 machine, so a switch that must never work on a deployed box
 *                 but must keep working in gates (the auto-approving identity
 *                 stub, audit harness-8) keys on this, not on isProduction().
 * isProduction()  `--prod` in argv (the server's own switch, primary) OR
 *                 isRailway() (so a changed start command cannot drop the
 *                 box back to dev behaviour) OR NODE_ENV === 'production'
 *                 (additive only; nothing here relies on it).
 * sessionSecret() AUTH_SECRET || MPP_SECRET_KEY when set. Otherwise, in
 *                 production, a random secret generated once per process
 *                 (sessions then do not survive a restart, which is the
 *                 honest cost of a missing variable) and ONE error naming the
 *                 variable. Outside production, the dev constant as before.
 *                 It NEVER returns the dev constant in production.
 *
 * READ LAZILY, ON PURPOSE. Static imports evaluate before server.js runs
 * `process.loadEnvFile()`, so a value read at import time would miss a secret
 * that lives in .env. Every call re-reads the environment; only the per-boot
 * fallback is held.
 *
 * No imports beyond crypto, no route side effects: overlay-key.js imports this
 * for isProduction() without pulling in auth.js.
 */
import { randomBytes } from 'crypto';

export const isRailway = () =>
  !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME);

export const isProduction = () =>
  process.argv.includes('--prod')
  || isRailway()
  || process.env.NODE_ENV === 'production';

const DEV_SECRET = 'megachat-dev-secret';
let bootSecret = null;

/** The secret that seals session and OAuth-state cookies (auth.js). Never logged. */
export function sessionSecret() {
  const s = process.env.AUTH_SECRET || process.env.MPP_SECRET_KEY;
  if (s) return s;
  if (!isProduction()) return DEV_SECRET;
  if (!bootSecret) {
    bootSecret = randomBytes(32).toString('hex');
    console.error('[auth] AUTH_SECRET (or MPP_SECRET_KEY) is not set in production — sessions are sealed with a per-boot secret and will not survive a restart; set AUTH_SECRET');
  }
  return bootSecret;
}
