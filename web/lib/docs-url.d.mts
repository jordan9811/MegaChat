/** See docs-url.mjs. Slugs are the keys of docs-slugs.json. */
export type DocsSlug =
  | 'docs'
  | 'live-seats'
  | 'megachats'
  | 'create-room-and-layout'
  | 'obs-setup'
  | 'follow-my-stream'
  | 'guest-whitelist'
  | 'bounty-program'
  | 'recent-rooms'
  | 'platform-support'
  | 'verification'
  | 'money'

/** The configured docs origin with no trailing slash, or null when unset. */
export function docsBase(): string | null

/** GitBook page path for a docs/ file path (README.md folds into its section). */
export function docsPath(file: string): string

/**
 * URL for a registered slug, the docs root when no slug is given, or null
 * when NEXT_PUBLIC_DOCS_URL is unset or the slug is not in the registry.
 */
export function docsUrl(slug?: DocsSlug | null): string | null

export const DOCS_SLUGS: Record<DocsSlug, string>
