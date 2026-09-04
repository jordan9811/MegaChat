# UI overhaul baseline: Lighthouse + axe

Captured 2026-09-02 against the live site https://megachat.fun, signed out, fresh profile, no cookies.

- Lighthouse 13.4.1, run twice per page: `--preset=desktop` and the default mobile preset (simulated throttling, Moto G Power class), categories performance / accessibility / best-practices only, headless Chrome. Single run per cell, so treat perf as +/- a few points.
- axe-core 4.13.0 via @axe-core/playwright, headless Chromium, each page loaded at 1440x900 and 390x844 (mobile emulation), default ruleset, after `load` + network idle + 2.5s settle. Table counts are the higher of the two viewports; per-viewport detail is in the rule lists and the raw JSON.
- Raw JSON: `lighthouse/<page>-<desktop|mobile>.json`, `axe/<page>-<1440|390>.json`, plus `_summary.json` in each folder.

## Scores

Perf is the Lighthouse performance score per form factor. a11y and best practices are the Lighthouse category scores from the mobile run (desktop noted in parentheses only where it differs). axe columns are violation counts by impact.

| page | path | perf mobile | perf desktop | a11y | best practices | axe critical | axe serious | axe moderate | axe minor |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| landing | `/?stay=1` | 62 | 96 | 100 | 77 | 0 | 0 | 1 | 0 |
| app | `/app` | 60 | 92 | 100 | 77 | 0 | 0 | 0 | 0 |
| create-room | `/dashboard?new=1` | 64 | 92 | 98 | 73 | 0 | 0 | 3 | 0 |
| bounty | `/bounty` | 63 | 84 | 100 | 77 | 0 | 0 | 0 | 0 |
| account | `/account` | 62 | 92 | 100 | 77 | 0 | 0 | 0 | 0 |
| how-it-works | `/how-it-works` | 58 | 99 | 100 | 77 | 0 | 1 | 0 | 0 |
| join | `/demo` | 47 | 96 | 98 | 77 | 0 | 0 | 4 | 0 |
| roadmap | `/roadmap` | 63 | 90 | 94 | 77 | 0 | 1 | 1 | 0 |

All 16 Lighthouse runs completed without a runtime error.

## axe critical and serious violations

- **serious** `scrollable-region-focusable` on **how-it-works** @ 390px (1 node): Scrollable region must have keyboard access. Targets: `.mt-8`
- **serious** `color-contrast` on **roadmap** @ 1440px (1 node): Elements must meet minimum color contrast ratio thresholds. Targets: `.bg-primary\/20`
- **serious** `color-contrast` on **roadmap** @ 390px (1 node): Elements must meet minimum color contrast ratio thresholds. Targets: `.bg-primary\/20`

## axe moderate and minor violations (reference only, not counted above)

- moderate `region` on landing @ 1440px (4 nodes)
- moderate `region` on landing @ 390px (4 nodes)
- moderate `landmark-one-main` on create-room @ 1440px (1 node)
- moderate `page-has-heading-one` on create-room @ 1440px (1 node)
- moderate `region` on create-room @ 1440px (24 nodes)
- moderate `landmark-one-main` on create-room @ 390px (1 node)
- moderate `page-has-heading-one` on create-room @ 390px (1 node)
- moderate `region` on create-room @ 390px (24 nodes)
- moderate `landmark-no-duplicate-banner` on join @ 1440px (1 node)
- moderate `landmark-one-main` on join @ 1440px (1 node)
- moderate `landmark-unique` on join @ 1440px (1 node)
- moderate `region` on join @ 1440px (5 nodes)
- moderate `landmark-no-duplicate-banner` on join @ 390px (1 node)
- moderate `landmark-one-main` on join @ 390px (1 node)
- moderate `landmark-unique` on join @ 390px (1 node)
- moderate `region` on join @ 390px (4 nodes)
- moderate `heading-order` on roadmap @ 1440px (1 node)
- moderate `heading-order` on roadmap @ 390px (1 node)

## What drives each Lighthouse score

Lab Core Web Vitals per form factor, plus the weighted audits failing in best-practices and accessibility (mobile run).

- **landing**
  - mobile: FCP 3.1 s, LCP 16.5 s, TBT 280 ms, CLS 0.001
  - best-practices failing: third-party-cookies (2 cookies found), inspector-issues
  - accessibility failing: none
  - desktop: FCP 0.6 s, LCP 1.3 s, TBT 20 ms, CLS 0
- **app**
  - mobile: FCP 2.1 s, LCP 12.0 s, TBT 490 ms, CLS 0
  - best-practices failing: third-party-cookies (2 cookies found), inspector-issues
  - accessibility failing: none
  - desktop: FCP 0.7 s, LCP 1.9 s, TBT 40 ms, CLS 0.001
- **create-room**
  - mobile: FCP 1.7 s, LCP 7.3 s, TBT 470 ms, CLS 0
  - best-practices failing: third-party-cookies (2 cookies found), errors-in-console, inspector-issues
  - accessibility failing: landmark-one-main
  - console errors (2): Failed to load resource: the server responded with a status of 401 () | Failed to load resource: the server responded with a status of 401 ()
  - desktop: FCP 0.7 s, LCP 1.6 s, TBT 100 ms, CLS 0
- **bounty**
  - mobile: FCP 1.8 s, LCP 11.6 s, TBT 450 ms, CLS 0
  - best-practices failing: third-party-cookies (2 cookies found), inspector-issues
  - accessibility failing: none
  - desktop: FCP 0.7 s, LCP 2.2 s, TBT 120 ms, CLS 0.104
- **account**
  - mobile: FCP 1.7 s, LCP 8.6 s, TBT 490 ms, CLS 0
  - best-practices failing: third-party-cookies (2 cookies found), inspector-issues
  - accessibility failing: none
  - desktop: FCP 0.6 s, LCP 1.9 s, TBT 50 ms, CLS 0
- **how-it-works**
  - mobile: FCP 1.8 s, LCP 8.7 s, TBT 630 ms, CLS 0
  - best-practices failing: third-party-cookies (2 cookies found), inspector-issues
  - accessibility failing: none
  - desktop: FCP 0.6 s, LCP 0.9 s, TBT 70 ms, CLS 0
- **join**
  - mobile: FCP 3.4 s, LCP 17.6 s, TBT 760 ms, CLS 0
  - best-practices failing: third-party-cookies (2 cookies found), inspector-issues
  - accessibility failing: landmark-one-main
  - desktop: FCP 0.6 s, LCP 1.4 s, TBT 40 ms, CLS 0.033
- **roadmap**
  - mobile: FCP 2.3 s, LCP 11.4 s, TBT 390 ms, CLS 0
  - best-practices failing: third-party-cookies (2 cookies found), inspector-issues
  - accessibility failing: color-contrast, heading-order
  - desktop: FCP 0.7 s, LCP 2.0 s, TBT 70 ms, CLS 0
