# MegaChat UI overhaul plan

Status: Phase 3 local checkpoint. No production page has been changed by this plan. The comparison lab is at `/dashboard/design-system` in the isolated `feat/ui-overhaul` worktree.

## Product rule

The interface should feel like a broadcast instrument that happens to be fun, not an arcade skin placed on a form. Every screen combines:

- **Arcade/street:** scale, stakes, money moments, and decisive calls to action.
- **Polished tech:** one path, disciplined controls, clear money language, and predictable component behavior.
- **Digital futurism:** live state, media, meters, and purposeful motion without faux-HUD clutter.

The logo is unresolved and outside this run. No palette decision depends on a logo, and no logo asset is changed or proposed here.

## Three blended directions

### 01 Signal Deck

A dark outer chassis around stepped blue-teal work surfaces. Powder blue owns primary actions and selection; yellow owns money; green owns live/verified state; red-pink is reserved for recording or destructive state. The Create Room form remains dominant and the live preview verifies the result.

Why it leads: it fixes black-on-black harshness without becoming a light SaaS product, keeps money trustworthy, and leaves enough energy for live moments. It also transfers cleanly to every load-bearing page.

Core tokens: page `#07151c`; shell `#0e2832`; panel `#153540`; sunk `#0a1e26`; primary `#76c8f1`; money `#ffd45a`; live `#61e5ad`; danger `#ff6b7a`.

### 02 Broadcast OS — selected

A deeper blue-black live console with configuration on the left and the broadcast preview on the right. The composition keeps the task path conventional while giving the live result enough visual authority. It is the strongest Nerve-oriented option and the selected system direction.

Tradeoff: it is more immersive but less efficient for long configuration work. It should influence live surfaces even if Signal Deck wins the system.

Core tokens: page `#060c14`; shell `#0a1421`; panel `#101e2e`; sunk `#07111c`; primary `#63baff`; money `#f8d66b`; live `#57e7b9`; recording `#ff4f7b`.

### 03 Game Tape

A powder-blue equipment panel inside a dark broadcast chassis. Deep cyan actions, ochre money text on light surfaces, bright yellow money inside dark live surfaces, and stronger graphic rails produce the clearest arcade read.

Tradeoff: it is the fastest to scan but risks feeling like an admin tool if the live stage and money moments are not expressive enough. It is the best source for the Bounty board and selected high-energy moments rather than the safest whole-site default.

Core tokens: page `#090e12`; shell `#d8e5e7`; panel `#eef4f2`; sunk `#cedde0`; primary `#087f9f`; money text `#8a6100`; money fill `#eebd24`; live `#25bd7c`; danger `#e75062`.

## Shared token layer

### Typography

Plus Jakarta Sans is the UI family at 400/500/600/700/800. Archivo remains exclusive to the landing hero display. The UI ladder is 11, 12, 13, 14, 16, 18, 22, 28, 36, and 48px; each page uses no more than seven steps. Body and labels are sentence case. Uppercase tracking is limited to status, coordinate, and table-header text of two words or fewer.

### Spacing

Use 4, 8, 12, 16, 24, 32, 48, 64, and 96px. Component interiors use 8/12/16; component gaps use 16/24; app sections use 48. Desktop content uses a 24px minimum gutter and a 1560px maximum shell.

### Geometry

Use 4px for controls, 8px for cards, and 12px for large shells. Broadcast OS may tighten these to 2/5/8; Game Tape to 2/4/6. Pills are prohibited for text controls. Only live dots and avatars may be circular.

### Motion

Hover changes one property in 120-150ms with no more than 2px travel. State transitions complete within 250ms. Entrance motion completes within 600ms and runs once. Infinite motion is limited to a live signal or on-air dot and is disabled under reduced-motion preferences.

### Color grammar

- Primary blue: the single filled action, selected segmented state, focus ring.
- Yellow: prices, spend, locked value, and money changes.
- Green: on air, verified, paid, successful.
- Red/pink: recording, stop, destructive, failed. Never neutral decoration.
- Blue hatch: contested or shared bounty value, always paired with a legend.
- Surfaces, not glow, create depth.

## Canonical components

### Actions

One filled primary button per viewport. Secondary actions are outline. Destructive actions use a low-fill red treatment until final confirmation. Header Sign in never competes with a body primary. Minimum desktop height is 40px; minimum compact/mobile hit area is 44px.

### Fields

Labels sit above 40-44px inputs. Hints explain consequences, not restate labels. Money inputs use tabular numerals. The rate control always supports direct entry plus minus/plus adjustment.

### Segmented controls

Segments share one outer border and internal dividers; only the active segment fills. They are used for short mutually exclusive decisions such as Paid/Free and AI only/AI then me, never for navigation between unrelated pages.

### Module rows

MegaChats, Open mic, and Drops are compact enable rows. Only an enabled module exposes its essential controls. Further detail belongs in Advanced settings. State is shown by a square check control plus explicit On/Off text, not color alone.

### Advanced settings

A stable left rail groups MegaChats, Open mic, Drops, Who gets in, Money, and Stream. Selecting a group updates only the adjacent panel. This prevents a long undifferentiated form while preserving access to every existing field.

### Status and money

Status tags use a dot only for a live state. Money uses yellow text and aligned tabular numerals. Every per-second rate has a nearby human total. Bounty bars repeat the exact colors in their adjacent legend.

### Media preview

The preview is evidence, not a second primary action. Its internal Send a MegaChat treatment is outlined in Create Room. On Join Room, where recording is the task, that same action becomes the sole primary.

### Dialogs

Dialogs use one title, one short consequence line, one primary, and one cancel action. Dangerous actions require a second explicit confirmation but no decorative warning theater.

## Create Room flow

1. **Identity:** editable prefilled room name, `megachat.fun/` plus green editable handle, and Paid selected by default.
2. **What runs:** MegaChats on by default; Open mic off; Drops off. Enabled modules reveal only immediate configuration.
3. **Advanced settings:** grouped navigation instead of a wall of controls. The label remains exactly `Advanced settings`.
4. **Launch:** Save as my defaults, password, a compact configuration summary in implementation, and one Create room primary.
5. **Preview:** reflects pricing and enabled features without outranking the launch action.

## Page implementation plan

### Create Room

Build the selected direction against the real state model without changing defaults or server behavior. Replace page-local styling with tokens and canonical controls. Preserve all numeric bounds and shallow-merge safeguards. Add a compact final summary and keep unfinished Follow my stream behavior explicitly unavailable.

### Join Room / Record a MegaChat

Use Broadcast OS's media-first composition under the selected token system. Make Send a MegaChat the sole primary. Keep live media visible while the recorder opens. Replace raw chain notation with simple `$rate/s`, clip total, and maximum spend; move network detail under `Under the hood`. Add purposeful recording, verification, payment, and sent states.

### Account

Create four clear regions: identity, balance/funding, room defaults, and recent/active rooms. Reuse the exact Create Room controls for defaults. Ensure the profile dropdown always exposes Account and Sign out. Signed-out state previews what the page manages before asking for authentication.

### Bounty

Retain the headline `Your favorite streamer doesn't even know you. Be more than a username.` Use a ranked leaderboard with real platform thumbnails where available and a small platform sub-icon. Keep total, locked, and contested values separate with matching bar segments and legend. Make rows the target and reserve the filled action for funding or recording the selected bounty.

### How It Works

Replace the document-like icon grid with one visual transaction model and two short paths: For fans and For streamers. Explain MegaChat first; move USDC, payment-channel, and network detail under `Under the hood`. Keep the diagram responsive and keyboard accessible.

### App board

Preserve the current board architecture. Fix the desktop bounty-card collapse, normalize rate language, align tokens/type/chrome, and remove any legacy-route leak. Do not invent active rooms or alter the real-count reflow.

### Landing

Preserve the hero film, hero copy, and browse deck. Apply only token, spacing, typography, and money-language alignment below the hero where the audit proves a defect. Do not redesign the hero and do not resolve or change the logo.

## Preserve checklist

- Landing hero film and `Skip the chat. Be the stream.`
- Current app browse-deck architecture and real-data behavior.
- Same-domain, same-tab landing-to-app flow; logo click returns to landing once logo direction is settled separately.
- No login wall for browsing or pricing.
- Express `/<handle>` room links remain plain anchors.
- Room defaults and server bounds stay unchanged.
- `server.js`, payment, meter, passkey, WebSocket, overlay, stingers, LiveKit, bounty backend, escrow, verifier, and API routes stay untouched.

## Build order and gates

Create Room -> Join Room -> Account -> Bounty -> How It Works -> app consistency fixes -> landing alignment. Each page gets desktop-first implementation, browser screenshots, interaction checks, accessibility checks, then the relevant existing gates. No commit, push, deployment, or production overwrite occurs without Jordan's explicit approval.

## Phase 3 decision

Selected direction: **Broadcast OS as the system**, with configuration on the left and preview on the right. Borrow Game Tape's stronger money/data treatment for Bounty and Signal Deck's brighter stepped surfaces where dense settings need more calm. This is a coherent remix, not three page themes: tokens and components remain canonical while page composition follows the job.
