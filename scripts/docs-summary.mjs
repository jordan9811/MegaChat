#!/usr/bin/env node
/**
 * docs:summary — MERGE the docs/ tree into docs/SUMMARY.md.
 *
 * SUMMARY.md is GitBook's table of contents: a markdown file that is not
 * listed there does not exist to GitBook. This script keeps the listing
 * complete without ever owning it, because the owner also writes pages from
 * GitBook's editor and those land here through Git Sync:
 *
 *   - every existing entry is PRESERVED — its line, its position, its title,
 *     even if the page is gone (a dead link is repaired when a file with the
 *     same name exists elsewhere under docs/, and warned about otherwise —
 *     never dropped);
 *   - pages missing from the listing are APPENDED to the group their
 *     directory belongs to, in path order, after the entries already there;
 *   - groups that do not exist yet are created: public groups in directory
 *     order, then Notes, then Internal last.
 *
 * `--public-only` prints (or writes with `--out <path>`) a SUMMARY without the
 * Internal group and without Notes, so "publish only the public half later"
 * is one command plus moving one directory. It never touches SUMMARY.md.
 *
 * `--check` exits 1 when SUMMARY.md would change, without writing it.
 *
 * Non-page directories (never listed): docs/.gitbook (assets) and
 * docs/_snippets (shared fragments stamped into pages by docs:sync).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const SUMMARY = path.join(DOCS, 'SUMMARY.md');
const NON_PAGE_DIRS = new Set(['.gitbook', '_snippets']);
// The owner's half. `internal/` is what this pass writes; the others are the
// engineering record that predates it (briefs, decisions, design notes, the
// UI-overhaul audits, the legacy map) and stays where it is because files
// across the repo link to those paths. They are grouped under Internal in the
// table of contents, dropped by --public-only, and treated as internal by
// docs:gitbook-check. Moving them under internal/ later is a `git mv` plus
// removing them from this set.
const INTERNAL_DIRS = new Set(['internal', 'briefs', 'decisions', 'design', 'legacy', 'reference', 'ui-overhaul']);
const NOTES_DIR = 'notes';
export const isInternalPath = (relPath) => {
  const top = relPath.includes('/') ? relPath.split('/')[0] : '';
  // A root-level page other than README.md is a pre-existing engineering doc
  // (pass-b-handoff, run-b-verification, ...): internal.
  return top === '' ? relPath !== 'README.md' : INTERNAL_DIRS.has(top);
};

const args = process.argv.slice(2);
const publicOnly = args.includes('--public-only');
const checkOnly = args.includes('--check');
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : null;

const toPosix = (p) => p.split(path.sep).join('/');

/** Every markdown page under docs/, as posix paths relative to docs/. */
function listPages(dir = DOCS, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) {
      if (rel === '' && NON_PAGE_DIRS.has(e.name)) continue;
      out.push(...listPages(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name));
    } else if (e.isFile() && e.name.endsWith('.md') && !(rel === '' && e.name === 'SUMMARY.md')) {
      out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  }
  return out;
}

function titleOf(relPath) {
  try {
    const src = fs.readFileSync(path.join(DOCS, relPath), 'utf8');
    const m = src.match(/^#\s+(.+?)\s*$/m);
    if (m) return m[1].replace(/\s*\{#.*\}$/, '').trim();
  } catch { /* fall through */ }
  const base = path.basename(relPath, '.md');
  if (base === 'README') {
    const dir = path.basename(path.dirname(relPath));
    return dir === '.' ? 'MegaChat' : humanize(dir);
  }
  return humanize(base);
}

const humanize = (s) => s.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Group a page belongs to, from its top-level directory. */
function groupOf(relPath) {
  const top = relPath.includes('/') ? relPath.split('/')[0] : '';
  if (relPath === 'README.md') return '';    // the ungrouped head: the landing page
  if (top === NOTES_DIR) return 'Notes';
  if (isInternalPath(relPath)) return 'Internal';
  return humanize(top);
}

/**
 * Sort key inside a group: a directory's README sorts as the directory itself
 * (so it lands before its children), `internal/` leads the Internal group,
 * and root-level record files trail it.
 */
function sortKey(relPath) {
  const top = relPath.includes('/') ? relPath.split('/')[0] : '';
  const rank = top === 'internal' ? '0' : top === '' ? '2' : '1';
  return rank + relPath.replace(/\/README\.md$/, '/');
}

// ── parse the existing SUMMARY into groups of verbatim lines ──────────────
// A "group" is a `## Heading` and everything under it; the head group ('')
// is whatever precedes the first heading (the title line and README entry).
function parseSummary(text) {
  const groups = [{ name: '', lines: [] }];
  for (const raw of text.split(/\r?\n/)) {
    const h = raw.match(/^##\s+(.+?)\s*$/);
    if (h) { groups.push({ name: h[1], lines: [] }); continue; }
    groups[groups.length - 1].lines.push(raw);
  }
  return groups;
}

const ENTRY_RE = /^(\s*)[*-]\s+\[([^\]]*)\]\(([^)]+)\)\s*$/;

function entriesIn(groups) {
  const found = new Map(); // path → { group, line index }
  for (const g of groups) {
    g.lines.forEach((line, i) => {
      const m = line.match(ENTRY_RE);
      if (m) found.set(decodeURI(m[3]).replace(/^\.\//, ''), { group: g.name, index: i });
    });
  }
  return found;
}

// ── main ──────────────────────────────────────────────────────────────────
const pages = listPages();
const pageSet = new Set(pages);
const existing = fs.existsSync(SUMMARY) ? fs.readFileSync(SUMMARY, 'utf8') : '# Table of contents\n\n* [MegaChat](README.md)\n';
const groups = parseSummary(existing);
const warnings = [];
let added = 0, repaired = 0;

// 1. repair dead links — same basename elsewhere wins; otherwise keep + warn.
for (const g of groups) {
  g.lines = g.lines.map((line) => {
    const m = line.match(ENTRY_RE);
    if (!m) return line;
    const target = decodeURI(m[3]).replace(/^\.\//, '');
    if (pageSet.has(target)) return line;
    const base = path.basename(target);
    const candidates = pages.filter((p) => path.basename(p) === base);
    if (candidates.length === 1) {
      repaired++;
      return `${m[1]}* [${m[2]}](${candidates[0]})`;
    }
    warnings.push(`kept an entry whose page is missing: ${target}${candidates.length > 1 ? ` (${candidates.length} same-named candidates, not guessing)` : ''}`);
    return line;
  });
}

// 2. append missing pages to their group, creating groups as needed.
const listed = entriesIn(groups);
const missing = pages.filter((p) => !listed.has(p));
const byGroup = new Map();
for (const p of missing) {
  const g = groupOf(p);
  if (!byGroup.has(g)) byGroup.set(g, []);
  byGroup.get(g).push(p);
}

/** Indent so a page nests under its directory's README, when one exists. */
function entryLine(relPath, group) {
  const parts = relPath.split('/');
  // depth 0: top-level file or a group's own README → no indent
  let indent = 0;
  if (parts.length > 1 && !(parts.length === 2 && parts[1] === 'README.md')) {
    // nest one level per ancestor directory that has a README of its own
    for (let d = 0; d < parts.length - 1; d++) {
      const readme = parts.slice(0, d + 1).join('/') + '/README.md';
      if (pageSet.has(readme) || listed.has(readme)) indent++;
    }
    if (parts[parts.length - 1] === 'README.md') indent = Math.max(0, indent - 1);
    if (group === '') indent = 0;
  }
  return `${'  '.repeat(indent)}* [${titleOf(relPath)}](${relPath})`;
}

const orderedGroupNames = () => {
  const names = groups.map((g) => g.name);
  const newNames = [...byGroup.keys()].filter((n) => !names.includes(n));
  const publicNew = newNames.filter((n) => n !== 'Internal' && n !== 'Notes' && n !== '').sort();
  for (const n of publicNew) {
    // insert before Notes/Internal if they exist, else at the end
    const at = groups.findIndex((g) => g.name === 'Notes' || g.name === 'Internal');
    const grp = { name: n, lines: [''] };
    if (at >= 0) groups.splice(at, 0, grp); else groups.push(grp);
  }
  if (newNames.includes('Notes')) {
    const at = groups.findIndex((g) => g.name === 'Internal');
    const grp = { name: 'Notes', lines: [''] };
    if (at >= 0) groups.splice(at, 0, grp); else groups.push(grp);
  }
  if (newNames.includes('Internal')) groups.push({ name: 'Internal', lines: [''] });
};
orderedGroupNames();

for (const [gname, list] of byGroup) {
  const g = groups.find((x) => x.name === gname);
  list.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  // trim trailing blank lines so entries append tightly, then restore one
  while (g.lines.length && g.lines[g.lines.length - 1].trim() === '') g.lines.pop();
  for (const p of list) { g.lines.push(entryLine(p, gname)); added++; }
  g.lines.push('');
}

// 3. render. The Internal group is always emitted last, Notes just before it.
const rank = (g) => (g.name === 'Internal' ? 2 : g.name === 'Notes' ? 1 : 0);
const stable = groups.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i).map((x) => x.g);
const render = (gs) => gs.map((g) => (g.name ? `## ${g.name}\n` : '') + g.lines.join('\n')).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

if (publicOnly) {
  const text = render(stable.filter((g) => g.name !== 'Internal' && g.name !== 'Notes'));
  if (outPath) { fs.writeFileSync(outPath, text); console.log(`docs:summary --public-only → ${toPosix(path.relative(ROOT, outPath))}`); }
  else process.stdout.write(text);
  for (const w of warnings) console.error(`  warn: ${w}`);
  process.exit(0);
}

const next = render(stable);
const changed = next !== existing;
if (checkOnly) {
  console.log(changed ? `docs:summary --check: SUMMARY.md is stale (${added} missing, ${repaired} dead links)` : 'docs:summary --check: SUMMARY.md is current');
  for (const w of warnings) console.error(`  warn: ${w}`);
  process.exit(changed ? 1 : 0);
}
if (changed) fs.writeFileSync(SUMMARY, next);
console.log(`docs:summary: ${added} added, ${repaired} repaired, ${pages.length} pages listed${changed ? '' : ' (no change)'}`);
for (const w of warnings) console.error(`  warn: ${w}`);
