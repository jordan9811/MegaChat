# MegaChat interface audit

Evidence: production captures from 2026-09-02 at 390, 768, and 1440px; Lighthouse and axe output in `baseline/`; task-flow captures in `baseline/tasks/`; source inspection; and the reference captures in `references/`. This is a UI audit, not a claim about backend behavior.

## System-level findings

1. **Seven page palettes prevent the product from feeling designed as one system.** Landing, board, Create Room, Join, Bounty, Account, and How It Works each redefine ground, text, accent, scrollbar, and often typography. Violates P5/P14. Linear and Luma show how one restrained shell can support differently expressive pages without changing the interaction grammar.
2. **Black is doing the work that hierarchy should do.** Most app surfaces differ by only a few luminance points, so users rely on borders and uppercase labels to parse the page. Violates P5/P15 in practice even where contrast technically passes. Dilum's reference solves density with distinct surface zones before glow.
3. **Actions do not have a stable visual rank.** Filled Sign in buttons, row CTAs, primary page actions, and selected controls repeatedly compete. Violates P4/P12. Stripe and Raycast reserve high-contrast fill for the immediate next action.
4. **The component geometry swings between zero-radius hard boxes and generic rounded primitives.** The overhaul pages are nearly all square while unused shared components are soft glass cards. Violates P3/P14. The fix is a small 4/8/12px scale, not bubble buttons.
5. **Typography has too many near-duplicate sizes and too much uppercase tracking.** The landing alone renders 16 sizes and Create Room 14. Violates P1/P9. The fix is a compact Plus Jakarta Sans UI ladder with Archivo only on the landing hero.

## Create Room

**Lead lens:** polished tech. **Current result:** functionally close, visually the weakest load-bearing page.

1. The three feature choices, their nested settings, the preview, and the submit area carry nearly equal weight; the eye has no decisive top-to-bottom path. P4/P12. Reference: Luma's create flow uses one work column and progressively disclosed detail.
2. Large black regions and repeated outlined boxes make a correct configuration feel unfinished and harsh. P5/P14. Reference: Dilum separates chassis, active work surface, and state surface.
3. The preview consumes substantial space but contributes little to completion; it should verify the current configuration, not behave like a competing hero. P12.
4. Advanced controls need a stable information architecture. MegaChats, Open mic, Drops, access, money, and stream settings should be reachable without scanning a long undifferentiated sheet. P2/P13.
5. The final action is too far from the decision context and competes with header chrome. P4/P10.

**Must preserve:** Paid by default; MegaChats on; Open mic off; Drops off; editable prefilled room name; `megachat.fun/` plus a green editable handle; typeable rate with plus/minus controls; the exact label `Advanced settings`; Save as defaults beside final setup; no fake enabled behavior for unfinished features.

**What Jordan likely dislikes:** it looks assembled from individually styled controls instead of designed as one instrument panel. This matches the known gripe exactly; the missing nuance was that dense settings are acceptable when the route through them is obvious.

## Join Room / Record a MegaChat

**Lead lens:** Nerve-like digital futurism. **Current result:** the product's namesake action is visually secondary.

1. Join Stream outranks Send a MegaChat through fill and size. P4/P12. The primary action must be the recorded MegaChat wherever it is available.
2. The page reads as a black settings form rather than a live place with watchers, a feed, or tension. P8. Reference: Twitch live surfaces keep the media state visible while the action panel changes.
3. Raw `USDC.e / 1s`, chain labels, and cap syntax force translation. P6/P9. Show `$0.001/s`, a common clip total, and maximum spend first; put rails under an advanced disclosure.
4. Emoji icons and multiple full-width actions make the page feel provisional. P3/P14 and A11.
5. Meter changes and send completion lack strong state feedback. P7/P11. Reference: PrizePicks confirms the exact object that changed without moving the whole layout.

**What Jordan likely dislikes:** it looks like generic wallet plumbing wrapped around video. That was not named in the known gripes, but it follows directly from the raw payment register and action hierarchy.

## Account

**Lead lens:** polished tech. **Current result:** too sparse to function as a control center.

1. Signed-out state is almost empty and offers no preview of what an account controls. P11/P13.
2. Room defaults are not presented as the same canonical controls used in Create Room. P14.
3. Identity, funding, defaults, and active-room management do not form a clear hierarchy. P2/P13.
4. The profile menu lost a direct Account entry in earlier revisions; the global route must remain visible from the profile control. P13.
5. The page lacks a useful live or recent-state object, so it fails the L3 sniff test. P8.

**What Jordan likely dislikes:** the route exists but does not yet feel like a finished product surface. This is a stronger diagnosis than the generic known gripe set, which did not call Account out specifically.

## Bounty

**Lead lens:** arcade/street. **Current result:** strongest app page conceptually, but its table and actions need system alignment.

1. Multiple filled row actions compete with the page action. P4. Make the entire row the selection target and reserve fill for recording or funding the selected bounty.
2. Loading is a generic slab rather than row-shaped skeletons. P11.
3. Stacked money bars are useful but need the same yellow/blue/green/red semantic set and same legend grammar everywhere. P5/P6.
4. Streamer identity needs consistent platform thumbnail treatment and a platform sub-icon without turning each row into a social card. P8/P14.
5. The page needs a recent pledge or live claim signal to pass the digital-live lens. P7/P8.

**Copy to retain:** `Your favorite streamer doesn't even know you. Be more than a username.` Supporting copy may draw from the previously banked critique lines, but only one line should lead the page.

**What Jordan likely dislikes:** CTA repetition and generic table chrome diminish the sharp headline and money mechanic. This was not explicit in the known gripes, but it is visible in the baseline action census.

## How It Works

**Lead lens:** polished tech. **Current result:** accurate information presented like a document.

1. The page has no single visual model that explains viewer to streamer to audience. P9/P12.
2. Twelve icon-plus-copy blocks repeat the same weight and invite skimming past everything. A9/P4.
3. Protocol terms appear before the user has the simple model. P9. Put rails under `Under the hood`.
4. The fixed-width pipeline diagram clips at 390px and its scroll region is not keyboard focusable. P10/P15; this is the baseline axe serious violation.
5. Streamer and fan paths are not visually separated soon enough. P13.

**What Jordan likely dislikes:** the content is explanatory but not intuitive; the page asks users to read instead of letting them see the transaction. This matches the known Word-document gripe.

## App board

**Lead lens:** arcade/street. **Current result:** preserve the overall browse deck; repair consistency defects only.

1. Bounty cards collapse to near-zero height at 768 and 1440 despite existing in the DOM. P11. This is the highest-priority regression.
2. The sparse state loses too much visual scaffolding at desktop widths. P11/P12.
3. The header and global nav use a separate type and color grammar from the landing and app forms. P1/P14.
4. Rate chips expose raw payment notation in some states. P6.
5. One overflow route still points toward legacy UI in the audited source. P13.

**Preserve:** board architecture, featured room hierarchy, bounty rail, carousel behavior, and real-data empty-state logic. No invented live rooms.

## Landing

**Lead lens:** arcade/street. **Current result:** preserve hero; tighten the handoff below it.

1. The hero and film are the strongest branded moment and should not be redesigned.
2. Below-hero sections use inconsistent vertical rhythms and too many tracked uppercase labels. P1/P2/P9.
3. Raw rates in the board table require translation. P6.
4. Two display-scale statements compete for the role of page climax. P12.
5. The transition from story to live app needs one repeated, unmistakable action rather than several similar prompts. P4/P13.

**Preserve:** hero film, `Skip the chat. Be the stream.`, and the browse deck. The logo is unresolved and outside this run; no logo asset or treatment is approved by this plan.

## Priority order

Create Room -> Join Room -> Account -> Bounty -> How It Works -> app consistency fixes -> landing token alignment only. This follows user impact, baseline defects, and the run spec. Nothing in this audit authorizes production implementation before the Phase 3 direction checkpoint.
