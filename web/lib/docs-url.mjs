/**
 * Docs deep links — the one place the app knows where the handbook lives.
 *
 * `NEXT_PUBLIC_DOCS_URL` is the GitBook space (or the custom domain in front
 * of it). Next inlines NEXT_PUBLIC_* at BUILD time, so this is a build
 * setting, not a runtime one. When it is unset every call returns null and
 * every surface that would have rendered a docs link renders nothing — no
 * placeholder, no `#`, no broken link. That absence is asserted by
 * _gate-docs-link.mjs, which imports THIS module rather than a copy of it.
 *
 * Slugs, not paths: a surface asks for `docsUrl('obs-setup')` and the
 * registry (docs-slugs.json) says which page that is. docs:gitbook-check
 * cross-checks every registry entry against docs/SUMMARY.md, so a renamed
 * page fails the check instead of 404ing in production.
 *
 * Plain JS with a .d.mts beside it, like obs-client.mjs, so the Node gate can
 * import the real thing.
 */
import slugs from './docs-slugs.json' with { type: 'json' };

/** The configured docs origin with no trailing slash, or null when unset. */
export function docsBase() {
  const raw = process.env.NEXT_PUBLIC_DOCS_URL;
  if (!raw || !String(raw).trim()) return null;
  return String(raw).trim().replace(/\/+$/, '');
}

/**
 * A GitBook page path from a docs/ file path: `features/obs-setup.md` →
 * `features/obs-setup`, and a section's `README.md` is the section itself.
 * ASSUMPTION: with Git Sync, GitBook page URLs follow file paths (it can be
 * told otherwise per page in its editor). CONNECTING-GITBOOK.md says to
 * confirm one deep link after the first sync.
 */
export function docsPath(file) {
  return String(file)
    .replace(/\.md$/, '')
    .replace(/(^|\/)README$/, '')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * The URL for a registered slug, the docs root when no slug is given, or
 * null when docs are not configured or the slug is unknown. An unknown slug
 * is null rather than a guess: a surface should never link a page that the
 * registry — and therefore docs:gitbook-check — does not know about.
 */
export function docsUrl(slug) {
  const base = docsBase();
  if (!base) return null;
  if (slug === undefined || slug === null || slug === '') return base;
  const file = slugs[slug];
  if (file === undefined) return null;
  const p = docsPath(file);
  return p ? `${base}/${p}` : base;
}

export { slugs as DOCS_SLUGS };
