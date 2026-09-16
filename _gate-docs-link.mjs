/**
 * GATE — the docs link renders nowhere until it is configured, and everywhere
 * it should once it is.
 *
 * NEXT_PUBLIC_DOCS_URL is a BUILD-time setting (Next inlines NEXT_PUBLIC_*),
 * so the honest proof of "renders nowhere when unset" is against a build, not
 * a running server. This gate has two layers:
 *
 *   A. The real helper, imported from web/lib/docs-url.mjs — not a copy of
 *      it (the A4 lesson in OPEN-ISSUES: a gate that asserts against its own
 *      re-implementation passes when the shipped code is reverted). With the
 *      variable unset every call is null; with it set, every registered slug
 *      resolves under the base and an unknown slug is null, not a guess.
 *   B. Every registry slug names a page docs/SUMMARY.md lists, and every
 *      surface that renders a docs link does so through docsUrl() behind a
 *      null check — asserted on the source, so a surface cannot ship a bare
 *      `href="#"` placeholder or an unguarded call.
 *
 * `--built <dir>`: the third layer, against a real web/.next. Pass the .next
 * directory of a build made WITHOUT the variable and the gate asserts no
 * server chunk carries a docs href; pass one made WITH it set to the fixture
 * URL and it asserts the fixture appears. REPORT-DOCS.md records both runs.
 */
import fs from 'node:fs';
import path from 'node:path';

const FIXTURE = 'https://docs.example.test/megachat';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${x ? `  (${x})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? `  (${x})` : ''}`); }
};

console.log('\n── docs link ─────────────────────────────────────────────');

// ── A. the real helper, both states ─────────────────────────────────────
delete process.env.NEXT_PUBLIC_DOCS_URL;
const mod = await import('./web/lib/docs-url.mjs');
const slugs = mod.DOCS_SLUGS;

ok('A1 unset: the docs root is null', mod.docsUrl() === null);
ok('A2 unset: every registered slug is null',
  Object.keys(slugs).every((s) => mod.docsUrl(s) === null), `${Object.keys(slugs).length} slugs`);
ok('A3 unset: an unknown slug is null, not a guess', mod.docsUrl('no-such-page') === null);

process.env.NEXT_PUBLIC_DOCS_URL = FIXTURE + '/';
ok('A4 set: the root is the base with no trailing slash', mod.docsUrl() === FIXTURE, mod.docsUrl());
ok('A5 set: a feature slug resolves under the base',
  mod.docsUrl('obs-setup') === `${FIXTURE}/features/obs-setup`, mod.docsUrl('obs-setup'));
ok('A6 set: a section README folds into its section path',
  mod.docsUrl('verification') === `${FIXTURE}/verification`, mod.docsUrl('verification'));
ok('A7 set: the "docs" slug is the root itself', mod.docsUrl('docs') === FIXTURE);
ok('A8 set: an unknown slug is STILL null — never a guessed URL', mod.docsUrl('no-such-page') === null);
ok('A9 set: whitespace-only is treated as unset', (process.env.NEXT_PUBLIC_DOCS_URL = '   ', mod.docsUrl() === null));
delete process.env.NEXT_PUBLIC_DOCS_URL;

// ── B. the registry against SUMMARY, and the surfaces against the guard ──
const summary = fs.readFileSync(path.join('docs', 'SUMMARY.md'), 'utf8');
const listed = new Set([...summary.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]));
const unlisted = Object.entries(slugs).filter(([, f]) => !listed.has(f));
ok('B1 every registry slug names a SUMMARY.md entry', unlisted.length === 0,
  unlisted.length ? unlisted.map(([s, f]) => `${s}→${f}`).join(', ') : `${listed.size} listed`);

const SURFACES = [
  'web/components/site-footer.tsx',
  'web/components/product-shell.tsx',
  'web/components/account/account-page.tsx',
  'web/components/landing/landing.tsx',
  'web/app/how-it-works/page.tsx',
  'web/app/join/page.tsx',
  'web/components/create-room/layout-editor.tsx',
  'web/components/account/guest-whitelist.tsx',
];
for (const f of SURFACES) {
  const src = fs.readFileSync(f, 'utf8');
  const calls = (src.match(/docsUrl\(/g) || []).length;
  // Every render use is `{docsUrl(...) ? <a href={docsUrl(...) as string}` —
  // the call inside the href is the second of a guarded pair, so the count
  // of guards must be at least half the count of calls.
  const guards = (src.match(/\{docsUrl\([^)]*\)\s*\?/g) || []).length;
  ok(`B2 ${path.basename(f)}: renders the docs link only behind a null check`,
    calls > 0 && guards * 2 >= calls, `${guards} guard(s), ${calls} call(s)`);
  ok(`B3 ${path.basename(f)}: no placeholder href for the docs link`,
    !/href=["']#["']/.test(src) && !/docs\.example|gitbook\.io/.test(src));
}

// ── C. optional: a real build ────────────────────────────────────────────
const builtIdx = process.argv.indexOf('--built');
if (builtIdx > 0) {
  const dir = process.argv[builtIdx + 1];
  const expect = process.argv.includes('--expect-present');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|html)$/.test(e.name)) files.push(p); } };
  walk(path.join(dir, 'server'));
  const hits = files.filter((p) => fs.readFileSync(p, 'utf8').includes(FIXTURE));
  if (expect) ok('C1 built WITH the fixture: the docs href is in the server bundle', hits.length > 0, `${hits.length} file(s)`);
  else ok('C1 built WITHOUT the variable: no docs href anywhere in the server bundle', hits.length === 0, `${files.length} files scanned`);
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
