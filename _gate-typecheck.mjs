/**
 * GATE — the web app type-checks, and the one file the type check cannot see
 * has no undefined names (audit web-13, 2026-10-24).
 *
 * THE GAP. `next build` skips type validation (web/next.config.mjs
 * ignoreBuildErrors), eslint is not installed, and web/lib/join-page.ts — the
 * 2,900-line viewer money page — opens with `// @ts-nocheck`, so even a full
 * `tsc -p web` never looks inside it. That is how `perCreditUsd` shipped:
 * called twice, defined nowhere, a ReferenceError in Simple mode with the
 * wallet configured (fixed in bd741f1). Turning build-time checking on would
 * not have caught it (the pragma hides the file from that pass too) and would
 * let a type-only error block Railway from shipping an urgent fix.
 *
 * WHAT IT PROVES
 *   T1  `tsc --noEmit -p web` exits 0 (the project as the editor sees it)
 *   T2  a copy of join-page.ts with the pragma stripped, checked loosely, has
 *       no "cannot find name" / "used before its declaration" error. Only
 *       those codes fail the gate: the file is untyped DOM code and its ~90
 *       other loose-mode errors are noise, not defects.
 *   T3  DISCRIMINATES: the same T2 check on the file as it was before the fix
 *       (`git show bd741f1^:web/lib/join-page.ts`) reports `perCreditUsd`.
 *       If it ever stops doing so, the check has gone blind and the gate
 *       fails rather than passing on nothing.
 *
 * Spends nothing, starts no server, writes only to a temp dir. `--incremental
 * false` keeps tsc from rewriting web/tsconfig.tsbuildinfo in the tree.
 *
 *   node _gate-typecheck.mjs
 */
import { spawnSync, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, 'web');
const TSC = path.join(WEB, 'node_modules', 'typescript', 'bin', 'tsc');
// Cannot find name; ... Did you mean; block-scoped variable used before its
// declaration; variable used before being assigned.
const UNDEFINED_NAME = new Set(['TS2304', 'TS2552', 'TS2448', 'TS2454']);
// The commit before the perCreditUsd fix: the file it held is the known-bad sample.
const KNOWN_BAD_REF = 'bd741f1^';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

// tsc prints each error's file relative to its working directory.
const tsc = (args, cwd = HERE) => spawnSync(process.execPath, [TSC, ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });

/**
 * Type-check one copy of join-page.ts with its pragma stripped. Its '@/'
 * imports resolve to the real web/ tree, bare ones to web/node_modules.
 * Returns the undefined-name errors reported IN THE COPY (an imported
 * module's own errors are not this file's).
 */
function undefinedNamesIn(source, label) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mc-typecheck-'));
  try {
    mkdirSync(path.join(dir, 'lib'));
    const body = source.replace(/^﻿?\s*\/\/\s*@ts-nocheck[^\n]*\n/, '');
    if (body === source) throw new Error(`${label}: no // @ts-nocheck first line to strip`);
    writeFileSync(path.join(dir, 'lib', 'join-page.ts'), body);
    const webPosix = WEB.replace(/\\/g, '/');
    writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        lib: ['dom', 'dom.iterable', 'esnext'], target: 'ES2020', module: 'esnext', moduleResolution: 'bundler',
        strict: false, noImplicitAny: false, skipLibCheck: true, noEmit: true, esModuleInterop: true,
        resolveJsonModule: true, isolatedModules: true, allowJs: true, jsx: 'react-jsx',
        baseUrl: webPosix,
        paths: { '@/*': ['./*'], '*': ['./node_modules/*'] },
        typeRoots: [`${webPosix}/node_modules/@types`],
      },
      files: ['lib/join-page.ts'],
    }, null, 2));
    const r = tsc(['--noEmit', '-p', path.join(dir, 'tsconfig.json'), '--incremental', 'false', '--pretty', 'false'], dir);
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    return out.split(/\r?\n/)
      .map((l) => l.match(/^(.*?join-page\.ts)\((\d+),(\d+)\): error (TS\d+): (.*)$/))
      .filter((m) => m && path.resolve(dir, m[1]) === path.join(dir, 'lib', 'join-page.ts') && UNDEFINED_NAME.has(m[4]))
      .map((m) => `line ${m[2]} ${m[4]} ${m[5]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n── web type check ──');
{
  const r = tsc(['--noEmit', '-p', WEB, '--incremental', 'false', '--pretty', 'false']);
  const errors = `${r.stdout || ''}${r.stderr || ''}`.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
  ok('T1. tsc --noEmit -p web exits 0', r.status === 0,
    r.status === 0 ? '0 errors' : `${errors.length} errors, first: ${errors.slice(0, 3).join(' | ')}`);
}

console.log('\n── join-page.ts with its @ts-nocheck stripped ──');
{
  const now = undefinedNamesIn(readFileSync(path.join(WEB, 'lib', 'join-page.ts'), 'utf8'), 'working tree');
  ok('T2. the working-tree join-page.ts has no undefined names', now.length === 0,
    now.length ? now.slice(0, 5).join(' | ') : 'none');
}
{
  let old = null;
  try {
    old = execFileSync('git', ['show', `${KNOWN_BAD_REF}:web/lib/join-page.ts`], { cwd: HERE, encoding: 'utf8', maxBuffer: 1 << 26 });
  } catch (e) {
    ok(`T3. the known-bad sample (${KNOWN_BAD_REF}) can be read`, false, e.message.split('\n')[0]);
  }
  if (old != null) {
    const hits = undefinedNamesIn(old, KNOWN_BAD_REF);
    ok(`T3. the same check reports the shipped perCreditUsd bug in ${KNOWN_BAD_REF} (it discriminates)`,
      hits.some((h) => /perCreditUsd/.test(h)), hits.length ? hits.join(' | ') : 'no undefined names found: the check is blind');
  }
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
