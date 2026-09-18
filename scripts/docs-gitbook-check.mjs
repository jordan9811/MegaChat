#!/usr/bin/env node
/**
 * docs:gitbook-check — is the repo side ready for GitBook Git Sync?
 *
 * Dry-run validator, no network. Asserts:
 *   1. The two files that actually govern site-level Git Sync parse and
 *      agree: gitbook-docs.yaml at the repo root (the site, and the directory
 *      each space maps to) and, inside that directory, the space's own
 *      .gitbook.yaml (content root, landing page, sidebar, redirects).
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

/**
 * A strict reader for the YAML subset these two configs use: comments,
 * `key: value` maps nested by indentation, `- ` sequences of maps, plain and
 * quoted scalars, booleans, and `{}`. Anything else — an anchor, a flow
 * collection, a block scalar, a tab — is reported as an error naming the
 * line, never silently mis-read: a validator that mis-reads a config is
 * worse than no validator. Exported so it can be exercised directly.
 */
export function parseYaml(text, label = 'yaml') {
  const errs = [];
  const root = {};
  const stack = [{ indent: 0, container: root, parent: null, key: null }];
  const scalar = (v, ln) => {
    if (v === '{}') return {};
    if (v === '[]') return [];
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null' || v === '~') return null;
    if (/^-?\d+$/.test(v)) return Number(v);
    const q = v.match(/^'([^']*)'$/) || v.match(/^"([^"]*)"$/);
    if (q) return q[1];
    if (/^[[{&*!|>]/.test(v)) { errs.push(`${label} line ${ln}: unsupported YAML construct "${v}"`); return null; }
    return v;
  };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const rawLine = lines[i];
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue;
    if (rawLine.includes('\t')) { errs.push(`${label} line ${ln}: tab character (YAML forbids tabs for indentation)`); continue; }
    const ind = rawLine.match(/^ */)[0].length;
    let body = rawLine.slice(ind).replace(/\s+#.*$/, '').trim();
    if (!body) continue;
    const isItem = /^-\s+/.test(body);

    while (stack.length > 1 && stack[stack.length - 1].indent !== null && ind < stack[stack.length - 1].indent) stack.pop();
    const frame = stack[stack.length - 1];
    if (frame.indent === null) {
      // A key whose block starts here — unless this line is no deeper than
      // the frame that key itself sits in, in which case it had no block at
      // all and the key's value is empty.
      const outer = stack[stack.length - 2];
      if (outer && outer.indent !== null && ind <= outer.indent) {
        frame.parent[frame.key] = null;
        stack.pop();
        i--;
        continue;
      }
      frame.indent = ind;
      frame.container = isItem ? [] : {};
      frame.parent[frame.key] = frame.container;
    }
    if (ind !== frame.indent) { errs.push(`${label} line ${ln}: unexpected indentation`); continue; }

    let target = frame.container;
    if (isItem) {
      if (!Array.isArray(target)) { errs.push(`${label} line ${ln}: list item where a mapping was expected`); continue; }
      const lead = body.match(/^-(\s+)/)[1].length;
      const obj = {};
      target.push(obj);
      stack.push({ indent: ind + 1 + lead, container: obj, parent: null, key: null });
      body = body.slice(1 + lead);
      target = obj;
    } else if (Array.isArray(target)) { errs.push(`${label} line ${ln}: mapping where a list item was expected`); continue; }

    const m = body.match(/^([A-Za-z$][\w$-]*):(?:\s+(.*))?$/);
    if (!m) { errs.push(`${label} line ${ln}: cannot read "${body}"`); continue; }
    const [, key, valRaw] = m;
    const val = (valRaw ?? '').trim();
    if (val === '') stack.push({ indent: null, container: null, parent: target, key });
    else target[key] = scalar(val, ln);
  }
  return { data: root, errs };
}

// ── 1a. gitbook-docs.yaml — the SITE config ───────────────────────────────
// Site-level Git Sync reads this from the Git Sync PROJECT DIRECTORY, left as
// ./ here, so it belongs at the repo root; its absence is the literal
// "gitbook-docs.yaml does not exist on this branch" sync failure. Schema:
// https://api.gitbook.com/gitbook-docs.yaml
const SITE_YAML = 'gitbook-docs.yaml';
let mappedDir = null;
const sitePath = path.join(ROOT, SITE_YAML);
if (!fs.existsSync(sitePath)) {
  fail(`${SITE_YAML} is missing at the repo root — site-level Git Sync fails with "gitbook-docs.yaml does not exist on this branch"`);
} else {
  const { data, errs } = parseYaml(fs.readFileSync(sitePath, 'utf8'), SITE_YAML);
  errs.forEach(fail);
  const site = data.site;
  if (!site || typeof site !== 'object' || Array.isArray(site)) fail(`${SITE_YAML}: no "site" block`);
  else {
    if (!site.title) fail(`${SITE_YAML}: site.title is required`);
    if (!Array.isArray(site.structure) || !site.structure.length) fail(`${SITE_YAML}: site.structure must be a non-empty list`);
    else {
      const spaces = site.structure.filter((n) => n && n.type === 'space');
      if (spaces.length !== site.structure.length) fail(`${SITE_YAML}: site.structure holds a node that is not a space — this repo maps one space and nothing else`);
      if (spaces.length !== 1) fail(`${SITE_YAML}: expected exactly one space, found ${spaces.length}`);
      const defaults = spaces.filter((s) => s.default === true);
      if (defaults.length !== 1) fail(`${SITE_YAML}: exactly one top-level space must carry "default: true" (found ${defaults.length}) — a site with no sections needs one`);
      for (const s of spaces) {
        for (const k of ['type', 'key', 'title', 'path']) if (!s[k]) fail(`${SITE_YAML}: space is missing the required field "${k}"`);
        if (s.key && s.key !== 'docs') {
          fail(`${SITE_YAML}: space key is "${s.key}", expected "docs" — the key is the space's permanent identity; changing it does not rename the space, it creates a NEW one with a new ID and detaches the old`);
        }
        const dir = s.content && s.content.directory;
        if (!dir) { fail(`${SITE_YAML}: space "${s.key}" has no content.directory`); continue; }
        if (String(dir).includes('..')) { fail(`${SITE_YAML}: content.directory "${dir}" escapes the project directory`); continue; }
        mappedDir = String(dir).replace(/^\.?\//, '').replace(/\/+$/, '');
        if (!fs.existsSync(path.join(ROOT, mappedDir))) { fail(`${SITE_YAML}: content.directory "${dir}" does not exist`); mappedDir = null; }
        else ok(`${SITE_YAML} → site "${site.title}", space "${s.key}" ← ${mappedDir}/`);
      }
    }
  }
}
// Everything below this point validates docs/ specifically, so a remapped
// space would leave the rest of this check grading the wrong tree.
if (mappedDir && mappedDir !== 'docs') {
  fail(`${SITE_YAML}: the space maps ${mappedDir}/, but the rest of this check is written against docs/ — update both together`);
  mappedDir = null;
}

// ── 1b. the SPACE config, inside the mapped directory ─────────────────────
// Paths inside it resolve from the mapped directory, not the repo root, so
// the old `root: ./docs/` would now mean docs/docs/ and sync an empty space.
if (fs.existsSync(path.join(ROOT, '.gitbook.yaml'))) {
  fail('.gitbook.yaml at the repo root configures a SPACE, not the site; under site-level sync it belongs in that space\'s mapped directory');
}
if (mappedDir) {
  const spaceYamlPath = path.join(ROOT, mappedDir, '.gitbook.yaml');
  let contentRoot = path.join(ROOT, mappedDir);
  let readme = 'README.md', summary = 'SUMMARY.md';
  if (!fs.existsSync(spaceYamlPath)) {
    ok(`${mappedDir}/.gitbook.yaml absent — GitBook's defaults apply (root ./, README.md, SUMMARY.md)`);
  } else {
    const { data, errs } = parseYaml(fs.readFileSync(spaceYamlPath, 'utf8'), `${mappedDir}/.gitbook.yaml`);
    errs.forEach(fail);
    const declared = String(data.root ?? './').replace(/^\.\//, '').replace(/\/+$/, '');
    contentRoot = path.join(ROOT, mappedDir, declared);
    const shown = toPosix(path.relative(ROOT, contentRoot)) || '.';
    if (declared === mappedDir) {
      fail(`${mappedDir}/.gitbook.yaml root is "${data.root}", which resolves to ${shown}/ — paths resolve from the MAPPED DIRECTORY, not the repo root; use "./"`);
    } else if (!fs.existsSync(contentRoot)) {
      fail(`${mappedDir}/.gitbook.yaml root "${data.root}" resolves to ${shown}/, which does not exist`);
    } else ok(`${mappedDir}/.gitbook.yaml root → ${shown}/`);
    if (data.structure && typeof data.structure === 'object' && !Array.isArray(data.structure)) {
      readme = data.structure.readme || readme;
      summary = data.structure.summary || summary;
    }
    if (data.redirects !== undefined && (data.redirects === null || typeof data.redirects !== 'object' || Array.isArray(data.redirects))) {
      fail(`${mappedDir}/.gitbook.yaml redirects is not a map`);
    }
  }
  let missing = 0;
  for (const [what, f] of [['landing page', readme], ['sidebar', summary]]) {
    const p = path.join(contentRoot, String(f).replace(/^\.\//, ''));
    if (!fs.existsSync(p)) { missing++; fail(`the space's ${what} "${f}" does not exist at ${toPosix(path.relative(ROOT, p))}`); }
  }
  if (!missing) ok(`space structure → ${readme} + ${summary}`);
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
