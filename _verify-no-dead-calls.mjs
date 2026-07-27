/**
 * VERIFY — no route calls a module function that does not exist.
 *
 * `bounty-routes.js` called `watermark.issueCode()`, which the playback-bound
 * watermark redesign had deleted. The whole air-session route threw on its
 * first real use, so the bounty mechanic was dead the moment a streamer went
 * live — and every gate missed it, because gates create air sessions through
 * `store.createAirSession()` directly rather than through the HTTP route.
 *
 * JavaScript will not tell you about this until the line runs. This checks
 * statically, so the next deletion cannot leave a caller behind.
 */
import { readFileSync } from 'fs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.error(`  FAIL  ${n}${x ? ' — ' + x : ''}`); }
};

function exportsOf(file) {
  const s = readFileSync(file, 'utf8');
  const names = [
    ...[...s.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]),
    ...[...s.matchAll(/export\s+(?:const|let|class)\s+(\w+)/g)].map((m) => m[1]),
    ...[...s.matchAll(/export\s*\{([^}]+)\}/g)]
      .flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop())),
  ];
  return new Set(names.filter(Boolean));
}

/** callerFile → { alias: moduleFile } */
const graph = {
  'bounty-routes.js': {
    watermark: 'bounty-watermark.js',
    store: 'bounty-store.js',
    escrow: 'bounty-escrow.js',
    clips: 'bounty-clips.js',
    verifier: 'bounty-verifier.js',
  },
  'bounty-escrow.js': {
    store: 'bounty-store.js',
    clips: 'bounty-clips.js',
  },
  'bounty-store.js': {
    evidence: 'bounty-evidence.js',
  },
};

/** Comments discuss deleted functions by name — scanning them reports code
 *  that does not exist as if it were still being called. */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

let dead = [];
for (const [caller, mods] of Object.entries(graph)) {
  const src = stripComments(readFileSync(caller, 'utf8'));
  for (const [alias, file] of Object.entries(mods)) {
    const ex = exportsOf(file);
    const re = new RegExp(`\\b${alias}\\.(\\w+)\\s*\\(`, 'g');
    for (const m of src.matchAll(re)) {
      if (!ex.has(m[1])) dead.push(`${caller}: ${alias}.${m[1]}() is not exported by ${file}`);
    }
  }
}

ok('no route or module calls a function that does not exist',
  dead.length === 0, dead.join(' | ') || 'checked 3 callers across 6 modules');

// The specific regression, pinned so it cannot come back silently.
const routes = stripComments(readFileSync('bounty-routes.js', 'utf8'));
ok('the deleted watermark.issueCode() caller is gone', !/watermark\.issueCode/.test(routes));
// Read the RAW file here — `routes` has had its comments stripped, so
// asserting on a comment against it can never pass.
ok('...and the air-session route explains why no code is issued at open',
  /NO CODE IS ISSUED HERE/.test(readFileSync('bounty-routes.js', 'utf8')));

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
