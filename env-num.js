/**
 * ENV NUMBERS — one reader for every numeric environment variable.
 *
 * WHY THIS EXISTS. Four config modules each carried their own
 * `num = (v, d) => Number.isFinite(Number(v)) ? Number(v) : d`, and
 * Number('') is 0, which is finite. So a variable that exists with an empty
 * value (a cleared Railway variable) read as 0 instead of the default:
 * LK_DAILY_BUDGET_MIN='' switched the LiveKit cost breaker's daily budget off.
 * Beside it, `Number(process.env.X || d)` read '' correctly but turned a
 * non-number into NaN, and every comparison against NaN is false, so
 * LK_BREAKER_BLOCK_AT='95%' switched the hard block off as well.
 *
 * THE RULE
 *   unset, '' or whitespace   the fallback. Unset means unset.
 *   not a finite number       the fallback, and ONE warning naming the
 *                             variable (never its value).
 *   '0'                       0. Gates set several variables to an explicit 0
 *                             on purpose; 0 is a value, not an absence.
 *   { min } given             a value from 0 up to the floor is raised to the
 *                             floor, and a negative value is unusable (the
 *                             fallback); either way, one warning. 0 is raised
 *                             too, so give `min` only to a variable whose 0
 *                             means nothing of its own: an interval, where 0
 *                             is a 1 ms timer. A variable whose 0 documents
 *                             "off" is read without `min`, and keeps its 0.
 *
 * READ AT CALL TIME. Static imports evaluate before server.js runs
 * process.loadEnvFile(), so a config object built at import time misses a
 * value that lives only in .env. This reads process.env when it is called;
 * when that is stays the caller's choice.
 */

const warned = new Set();

function warnOnce(name, message) {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(`[env] ${name} ${message}`);
}

/**
 * @param {string} name      the variable's NAME (the value is never logged)
 * @param {number} fallback  what an unset or unusable value reads as
 * @param {{ min?: number }} [opts]
 * @returns {number}
 */
export function envNum(name, fallback, { min } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    warnOnce(name, 'is set but is not a number; using the default');
    return fallback;
  }
  if (min !== undefined && n < 0) {
    warnOnce(name, 'is negative; using the default');
    return fallback;
  }
  if (min !== undefined && n < min) {
    warnOnce(name, `is below its floor; using ${min}`);
    return min;
  }
  return n;
}
