#!/usr/bin/env node
/**
 * docs:gitbook-check — is the repo side ready for GitBook Git Sync?
 *
 * Dry-run validator, no network. Asserts:
 *   1. .gitbook.yaml parses and points at a root whose README.md and
 *      SUMMARY.md exist (a minimal YAML reader — the file has four keys).
 *   2. Every SUMMARY.md entry resolves to a file.
 *   3. Every markdown page under docs/ is listed in SUMMARY.md (non-page
 *      directories — .gitbook, _snippets — are exempt; GitBook does not show
 *      an unlisted page).
 *   4. Every image referenced from a page lives under docs/.gitbook/assets
 *      (anything else does not resolve in GitBook). A page the handbook pass
 *      did not author WARNS; an authored page FAILS.
 *   5. No public page links into the internal half. Internal is what
 *      docs-summary.mjs says it is (one set), so the two never disagree.
 *   6. Every deep-link slug in web/lib/docs-slugs.json names a page that
 *      SUMMARY.md lists, so a renamed page fails here instead of 404ing.
 *   7. Relative links between pages resolve.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInternalPath } from './docs-summary.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const NON_PAGE_DIRS = new Set(['.gitbook', '_snippets']);
const toPosix = (p) => p.split(path.sep).join('/');

let errors = 0, warnings = 0;
const fail = (m) => { errors++; console.log(`  FAIL  ${m}`); };
const warn = (m) => { warnings++; console.log(`  warn  ${m}`); };
const ok = (m) => console.log(`  ok    ${m}`);

const manifest = fs.existsSync(path.join(DOCS, '.docs-manifest.json'))
  ? JSON.parse(fs.readFileSync(path.join(DOCS, '.docs-manifest.json'), 'utf8')) : { authored: [] };
const authored = new Set(manifest.authored || []);

// ── 1. .gitbook.yaml ─────────────────────────────────────────────────────
const yamlPath = path.join(ROOT, '.gitbook.yaml');
if (!fs.existsSync(yamlPath)) fail('.gitbook.yaml is missing at the repo root');
else {
  const y = fs.readFileSync(yamlPath, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  const top = {}; let section = null;
  for (const line of y) {
    const m = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
    if (!m) { fail(`.gitbook.yaml: cannot read line "${line}"`); continue; }
    const [, indent, key, val] = m;
    if (!indent) { section = key; top[key] = val.trim() === '' ? {} : val.trim(); }
    else if (section && typeof top[section] === 'object') top[section][key] = val.trim();
  }
  const root = String(top.root || '').replace(/^\.\//, '').replace(/\/+$/, '');
  if (root !== 'docs') fail(`.gitbook.yaml root is "${top.root}", expected ./docs/`);
  else ok('.gitbook.yaml root → ./docs/');
  const readme = top.structure?.readme || 'README.md', summary = top.structure?.summary || 'SUMMARY.md';
  for (const f of [readme, summary]) {
    if (!fs.existsSync(path.join(DOCS, f))) fail(`.gitbook.yaml structure names ${f}, which does not exist under docs/`);
  }
  if (top.redirects !== undefined && top.redirects !== '{}' && typeof top.redirects !== 'object') fail('.gitbook.yaml redirects is not a map');
  ok('.gitbook.yaml structure → README.md + SUMMARY.md');
}

// ── pages and SUMMARY ─────────────────────────────────────────────────────
function listPages(dir = DOCS, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (rel === '' && NON_PAGE_DIRS.has(e.name)) continue; out.push(...listPages(path.join(dir, e.name), r)); }
    else if (e.name.endsWith('.md') && r !== 'SUMMARY.md') out.push(r);
  }
  return out;
}
const pages = new Set(listPages());
const summaryText = fs.existsSync(path.join(DOCS, 'SUMMARY.md')) ? fs.readFileSync(path.join(DOCS, 'SUMMARY.md'), 'utf8') : '';
const listed = new Set();
for (const m of summaryText.matchAll(/^\s*[*-]\s+\[[^\]]*\]\(([^)]+)\)/gm)) {
  const t = decodeURI(m[1]).replace(/^\.\//, '');
  listed.add(t);
  if (!pages.has(t)) fail(`SUMMARY.md lists ${t}, which does not exist`);
}
for (const p of pages) if (!listed.has(p)) fail(`orphan: ${p} is not in SUMMARY.md (GitBook will not show it)`);
if (!errors) ok(`${pages.size} pages, all listed, all resolve`);

// ── links, images, the boundary ───────────────────────────────────────────
const LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
let imageHits = 0, boundaryHits = 0, deadHits = 0;
for (const page of pages) {
  const src = fs.readFileSync(path.join(DOCS, page), 'utf8');
  const dir = path.posix.dirname(page);
  let inFence = false;
  for (const line of src.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    for (const m of line.matchAll(LINK_RE)) {
      const isImage = m[0].startsWith('!');
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const clean = target.split('#')[0];
      if (!clean) continue;
      const resolved = toPosix(path.posix.normalize(path.posix.join(dir, clean)));
      if (isImage) {
        if (!resolved.startsWith('.gitbook/assets/')) {
          imageHits++;
          (authored.has(page) ? fail : warn)(`${page}: image ${target} is not under docs/.gitbook/assets (will not resolve in GitBook)`);
        }
        continue;
      }
      if (resolved.endsWith('.md') && !pages.has(resolved)) {
        deadHits++;
        (authored.has(page) ? fail : warn)(`${page}: dead link → ${target}`);
        continue;
      }
      if (resolved.endsWith('.md') && !isInternalPath(page) && isInternalPath(resolved)) {
        boundaryHits++;
        fail(`${page} (public) links into the internal half → ${target}`);
      }
    }
  }
}
if (!imageHits) ok('no image outside docs/.gitbook/assets');
if (!boundaryHits) ok('no public page links into the internal half');
if (!deadHits) ok('every relative link resolves');

// ── slugs ─────────────────────────────────────────────────────────────────
const slugPath = path.join(ROOT, 'web', 'lib', 'docs-slugs.json');
if (!fs.existsSync(slugPath)) fail('web/lib/docs-slugs.json is missing');
else {
  const slugs = JSON.parse(fs.readFileSync(slugPath, 'utf8'));
  let bad = 0;
  for (const [slug, file] of Object.entries(slugs)) {
    if (!listed.has(file)) { bad++; fail(`slug "${slug}" → ${file} is not a SUMMARY.md entry`); }
    else if (isInternalPath(file)) { bad++; fail(`slug "${slug}" → ${file} deep-links into the internal half`); }
  }
  if (!bad) ok(`${Object.keys(slugs).length} deep-link slugs resolve to public SUMMARY entries`);
}

console.log(`\ndocs:gitbook-check: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
process.exit(errors ? 1 : 0);
