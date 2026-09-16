#!/usr/bin/env node
/**
 * docs:sync — currency by construction.
 *
 * Docs rot because the code they describe moves and nothing notices. This
 * script makes that structural, in two ways:
 *
 *  1. CITATION HASHES. Every backticked source citation in an authored page
 *     (`server.js`, `rooms-store.js:485`, `bounty-claim.config.js:240-300`)
 *     names a section of the repo. The SEMANTIC content of that section —
 *     whitespace collapsed, list markers stripped, blank lines dropped — is
 *     hashed and stored in docs/.docs-manifest.json. A later run reports every
 *     page whose cited sections have changed since the last sync. A bare file
 *     cite hashes the whole file; `:N` hashes N±2 lines; `:A-B` hashes A..B.
 *
 *  2. SOURCE-EMBEDDED REGIONS. A page may hold
 *
 *        <!-- source:web/lib/api.ts#Room -->
 *        ...
 *        <!-- /source -->
 *
 *     and `--write` replaces everything between the markers with the current
 *     text of that symbol (from its `export` line to the next top-level
 *     declaration) as a fenced code block. `#L10-L40` selects a line range
 *     instead. Contracts therefore cannot drift from the code silently.
 *     Comparison is on normalised text, so GitBook re-indenting a page does
 *     not read as drift; the markers are HTML comments, which is the one
 *     assumption about GitBook's normaliser this design makes.
 *
 *  3. SNIPPETS. `<!-- snippet:NAME -->` … `<!-- /snippet -->` is refreshed
 *     from docs/_snippets/NAME.md, so a notice that appears on many pages is
 *     edited in one place (the pre-launch hint, removed at launch).
 *
 * Modes:  default   report drift, exit 1 if any
 *         --write   refresh regions and snippets, record hashes, exit 0
 *
 * Only pages listed as `authored` in the manifest are touched. docs/notes/
 * and every page the pass did not write are never read or written.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const MANIFEST = path.join(DOCS, '.docs-manifest.json');
const SNIPPETS = path.join(DOCS, '_snippets');
const write = process.argv.includes('--write');

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
manifest.sources ||= {};
const authored = manifest.authored || [];

const CITE_RE = /`([\w./@+-]+\.(?:js|mjs|cjs|ts|tsx|md|json|jsonl|ya?ml|html|css))(?::(\d+)(?:-(\d+))?)?`/g;
const REGION_RE = /<!--\s*source:([^\s#]+)(?:#([^\s]+))?\s*-->([\s\S]*?)<!--\s*\/source\s*-->/g;
const SNIPPET_RE = /<!--\s*snippet:([\w-]+)\s*-->([\s\S]*?)<!--\s*\/snippet\s*-->/g;

const normalise = (text) => text
  .split(/\r?\n/)
  .map((l) => l.replace(/^\s*(?:[*+•-]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim())
  .filter(Boolean)
  .join('\n');
const sha = (text) => crypto.createHash('sha1').update(normalise(text)).digest('hex').slice(0, 16);
const langOf = (file) => ({ ts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', md: 'markdown', yaml: 'yaml', yml: 'yaml', html: 'html', css: 'css' })[path.extname(file).slice(1)] || '';

/**
 * Resolve a cited path: repo root first (source files), then docs/ (a page
 * naming another page), then the citing page's own directory.
 */
function readRepo(rel, fromDir = null) {
  for (const base of [ROOT, DOCS, fromDir].filter(Boolean)) {
    const p = path.join(base, rel);
    if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) return fs.readFileSync(p, 'utf8').split(/\r?\n/);
  }
  return null;
}

/** The section a citation names, as text — or null when the file is missing. */
function citedSection(file, a, b, fromDir = null) {
  const lines = readRepo(file, fromDir);
  if (!lines) return null;
  if (!a) return lines.join('\n');
  const A = Number(a), B = b ? Number(b) : null;
  const lo = B ? A : Math.max(1, A - 2), hi = B ? B : A + 2;
  return lines.slice(lo - 1, hi).join('\n');
}

/** A symbol's block: its declaration line to the next top-level declaration. */
function symbolBlock(lines, name) {
  const decl = new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:type|interface|function|const|let|class|enum)\\s+${name}\\b`);
  const start = lines.findIndex((l) => decl.test(l));
  if (start < 0) return null;
  // Take a leading JSDoc block, if the line above closes one.
  let from = start;
  if (start > 0 && /^\s*\*\/\s*$/.test(lines[start - 1])) {
    let k = start - 1;
    while (k > 0 && !/^\s*\/\*\*/.test(lines[k])) k--;
    from = k;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^(?:export\s|\/\*\*|\/\/ ─|const |function |class |type |interface )/.test(lines[i])) { end = i; break; }
  }
  while (end > start && lines[end - 1].trim() === '') end--;
  return { from: from + 1, to: end, text: lines.slice(from, end).join('\n') };
}

function renderRegion(file, anchor) {
  const lines = readRepo(file);
  if (!lines) return `> **source missing:** \`${file}\` is not in the repo.`;
  let block;
  const range = anchor && anchor.match(/^L(\d+)-L?(\d+)$/);
  if (range) block = { from: Number(range[1]), to: Number(range[2]), text: lines.slice(Number(range[1]) - 1, Number(range[2])).join('\n') };
  else if (anchor) block = symbolBlock(lines, anchor);
  else block = { from: 1, to: lines.length, text: lines.join('\n') };
  if (!block) return `> **symbol missing:** \`${anchor}\` is no longer declared in \`${file}\`.`;
  return `\`\`\`${langOf(file)}\n// ${file} — ${anchor || 'whole file'} (lines ${block.from}–${block.to}), embedded by docs:sync\n${block.text}\n\`\`\``;
}

let drift = 0;
const notes = [];

for (const page of authored) {
  const p = path.join(DOCS, page);
  if (!fs.existsSync(p)) { notes.push(`  missing authored page: ${page}`); continue; }
  let text = fs.readFileSync(p, 'utf8');
  const before = text;

  // 1. citation hashes
  const seen = {};
  for (const m of text.matchAll(CITE_RE)) {
    const [, file, a, b] = m;
    const key = `${file}${a ? ':' + a : ''}${b ? '-' + b : ''}`;
    if (seen[key] !== undefined) continue;
    const section = citedSection(file, a, b, path.dirname(p));
    // A `.json`/`.jsonl` name that is not in the repo is a runtime data file
    // (rooms.json, bounty-ledger.jsonl — gitignored, written under DATA_DIR),
    // named in the docs as a thing, not cited as a source. Not drift.
    if (section === null && /\.jsonl?$/.test(file)) continue;
    seen[key] = section === null ? 'MISSING' : sha(section);
  }
  const prev = manifest.sources[page] || {};
  for (const [key, hash] of Object.entries(seen)) {
    if (hash === 'MISSING') { drift++; notes.push(`  ${page}: cites ${key}, which does not exist`); continue; }
    if (prev[key] === undefined) { if (!write) notes.push(`  ${page}: new citation ${key} (not yet recorded)`); }
    else if (prev[key] !== hash) { drift++; notes.push(`  ${page}: cited section CHANGED — ${key}`); }
  }
  if (write) manifest.sources[page] = seen;

  // 2. embedded regions
  text = text.replace(REGION_RE, (whole, file, anchor, body) => {
    const fresh = renderRegion(file, anchor);
    if (normalise(body) !== normalise(fresh)) {
      if (!write) { drift++; notes.push(`  ${page}: embedded region ${file}${anchor ? '#' + anchor : ''} is stale`); return whole; }
      notes.push(`  ${page}: refreshed ${file}${anchor ? '#' + anchor : ''}`);
    }
    return `<!-- source:${file}${anchor ? '#' + anchor : ''} -->\n${fresh}\n<!-- /source -->`;
  });

  // 3. snippets
  text = text.replace(SNIPPET_RE, (whole, name, body) => {
    const sp = path.join(SNIPPETS, `${name}.md`);
    if (!fs.existsSync(sp)) { drift++; notes.push(`  ${page}: snippet ${name} has no source file`); return whole; }
    const fresh = fs.readFileSync(sp, 'utf8').trim();
    if (normalise(body) !== normalise(fresh)) {
      if (!write) { drift++; notes.push(`  ${page}: snippet ${name} is stale`); return whole; }
      notes.push(`  ${page}: re-stamped snippet ${name}`);
    }
    return `<!-- snippet:${name} -->\n${fresh}\n<!-- /snippet -->`;
  });

  if (write && text !== before) fs.writeFileSync(p, text);
}

if (write) fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
for (const n of notes) console.log(n);
console.log(write
  ? `docs:sync --write: ${authored.length} pages synced, manifest updated`
  : `docs:sync: ${drift} drift${drift === 1 ? '' : 's'} across ${authored.length} authored pages`);
process.exit(write ? 0 : (drift ? 1 : 0));
