#!/usr/bin/env node
/**
 * docs:check — the honesty check.
 *
 * Prose has no test suite, so overclaiming creeps back in through the words
 * that sound strongest. This script fails the build when one of those words
 * appears in a handbook page without a citation nearby:
 *
 *   secure · private · guaranteed · always · never · cannot · fully · complete
 *
 * A citation is a backticked source path (`server.js`, `rooms-store.js:485`,
 * `web/lib/api.ts`), a backticked commit sha (`6386a2c`), an explicit
 * `<!-- cite: ... -->`, or the opt-out marker `<!-- uncited-ok -->`, on the
 * same line or within two lines either side.
 *
 * Matching is whitespace- and bullet-insensitive: list markers, blockquote
 * bars and table pipes are stripped before the window is built, so GitBook
 * normalising `-` to `*` or re-indenting a list cannot trigger a hit.
 *
 * Severity follows authorship. Pages listed as `authored` in
 * docs/.docs-manifest.json FAIL on a hit; any other page under docs/ — one the
 * owner wrote from GitBook's editor, or a record that predates the handbook —
 * WARNS and never fails. docs/notes/ is exempt entirely, and SUMMARY.md is a
 * table of contents, not prose.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const MANIFEST = path.join(DOCS, '.docs-manifest.json');
const WINDOW = 2;

const KEYWORDS = /\b(secure(?:ly)?|private(?:ly)?|guarantee[sd]?|always|never|cannot|fully|complete(?:ly)?)\b/gi;
const CITATION = /`[\w./@+-]+\.(?:js|mjs|cjs|ts|tsx|md|json|jsonl|ya?ml|html|css)(?::\d+(?:-\d+)?)?`|`[0-9a-f]{7,40}`|<!--\s*cite:[^>]*-->|<!--\s*uncited-ok\s*-->/i;

const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { authored: [] };
const authored = new Set(manifest.authored || []);

const toPosix = (p) => p.split(path.sep).join('/');

function listPages(dir = DOCS, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (rel === '' && (e.name === '.gitbook' || e.name === 'notes')) continue;
      out.push(...listPages(path.join(dir, e.name), r));
    } else if (e.name.endsWith('.md') && r !== 'SUMMARY.md') {
      out.push(r);
    }
  }
  return out.sort();
}

/** Strip the markup GitBook is free to rewrite, so the window sees prose only. */
function normalise(line) {
  return line
    .replace(/^\s*(?:>\s*)*/, '')                 // blockquote bars
    .replace(/^\s*(?:[*+•-]|\d+[.)])\s+/, '')    // list markers
    .replace(/^\s*\|/, '').replace(/\|\s*$/, '') // table edges
    .replace(/\s+/g, ' ')
    .trim();
}

let errors = 0, warnings = 0;
const report = [];
const advisory = {};

for (const page of listPages()) {
  const lines = fs.readFileSync(path.join(DOCS, page), 'utf8').split(/\r?\n/).map(normalise);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const line = lines[i];
    if (!line) continue;
    // A heading is a label, not a claim.
    if (/^#{1,6}\s/.test(line)) continue;
    const hits = [...line.matchAll(KEYWORDS)].map((m) => m[1]);
    if (!hits.length) continue;
    const lo = Math.max(0, i - WINDOW), hi = Math.min(lines.length - 1, i + WINDOW);
    const window = lines.slice(lo, hi + 1).join('\n');
    if (CITATION.test(window)) continue;
    const severity = authored.has(page) ? 'error' : 'warn';
    if (severity === 'error') errors++; else warnings++;
    const msg = `${page}:${i + 1}  "${[...new Set(hits)].join('", "')}" with no citation within ${WINDOW} lines`;
    if (severity === 'error') report.push(`  FAIL  ${msg}`);
    else (advisory[page] ||= []).push(msg);
  }
}

// Failures in full. Advisory hits — pages this pass did not write — as one
// line per page unless --verbose, so the number that matters is readable.
for (const r of report) console.log(r);
const verbose = process.argv.includes('--verbose');
for (const [page, lines] of Object.entries(advisory)) {
  if (verbose) for (const l of lines) console.log(`  warn  ${l}`);
  else console.log(`  warn  ${page}: ${lines.length} advisory hit${lines.length === 1 ? '' : 's'} (not authored by the handbook pass; --verbose to list)`);
}
console.log(`\ndocs:check: ${errors} uncited claim${errors === 1 ? '' : 's'} in authored pages, ${warnings} advisory in other pages`);
process.exit(errors ? 1 : 0);
