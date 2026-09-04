# Ideal paths, streamer tasks T5-T10 (signed in, local)

Baseline walk of the six streamer tasks against `http://localhost:3211` (prod build, bounty flag on), signed in as the pre-claimed dev identity `devstreamer` via `dev-auth.mjs` cookies. Headless Chromium 1440x900 through Playwright 1.62.1 (npx cache), one fresh browser context per task. Every step below was actually executed; where a claim is inferred rather than observed it says so.

Screenshots: `ideal-paths-local-screens/` (recon `00-*`, then `T5-*` .. `T10-*`, numbered in walk order).

An "ideal path" here is the fewest clicks that actually reach completion for someone who already knows the site. Typing and reloads are not clicks. Target seconds assume that person.

## State this walk left behind

devstreamer now owns four rooms (it owned none at the start):

| id | link | name | notes |
|---|---|---|---|
| e79475b3 | none | devstreamer test room | first Create from the landing path; came out with no handle even though the form showed `megachat.fun/devstreamer` (observed once, not reproduced) |
| 949dad0f | /devstreamer | devstreamer test room | second Create, same form |
| a6d9652c | /devstreamer_2 | Renamed by T7 | free room, created by T6-B, renamed by T7 |
| 853ff9f7 | /devstreamer_3 | My Stream | created by T8's "Start new room" |

Account defaults are left saved (from T6-C: a free-room snapshot). There is no way to delete rooms, so they stay.

## Cross-cutting findings (affect several tasks)

1. **"Create room" on `/dashboard?new=1` silently resets the form.** The POST returns 201 and the room exists, but the page stays on `?new=1` and re-renders a blank create form: no confirmation, no redirect, no links. Every create entry on the site (`Create a room` on the landing, the `Open a room` tile on /app, `Open a new room` in the chip menu, `Open the create form` on /account) points at `?new=1`, so this hits the mainstream path. Creating from `/dashboard` without the query (the managing view's `Start new room`) lands on the managing dashboard correctly (T8). Root cause is visible in `web/components/dashboard-shell.tsx`: the `?new=1` effect calls `switchRoom()` the moment `mode` becomes `managing`, which is exactly what a successful create does. Screens: `T5-diag-after-create-click.png`, `T6-B-03-after-create.png`.
2. **Getting to a room you own always goes through the chip menu.** `@devstreamer ▼` → `Your room` → `/dashboard`, which auto-opens the *newest* room. There is no rooms list on /app, /account or the room page; if you own several rooms you land in the wrong one and need `Switch room`.
3. **No save feedback in the managing dashboard.** Settings autosave (PUT after ~1 s) but nothing on screen changes; the only hint is the card subtitle "Changes save automatically while you stream." Confirming a change means reloading.
4. **Two different "defaults" surfaces with different copy.** `/account` shows saved defaults but cannot edit or save them; the dashboard's `Defaults` tab has a `Save current create-form as my defaults` button that actually snapshots the room being managed.
5. **No delete, no end-stream, no OBS one-click.** Rooms can only be paused (`Accepting joins` switch). `OBS_ONECLICK` is off on this server, so the only OBS affordance is a copyable URL plus a text guide.

---

## T5 · Create a room and finish setup

Start: `/?stay=1`

**Ideal path (observed): 4 clicks, target 30 s**

1. Scroll to the bottom of the landing page and click **Create a room** (the CTA sits ~2600 px down; the top bar only has `Enter app`). → `/dashboard?new=1`, the create page, with the link prefilled as `megachat.fun/devstreamer`, MegaChats ON, Paid.
2. Click **Create room** (bottom of the left column; naming is optional, the server names it "My Stream"). → POST 201, then the form silently resets (finding 1). Nothing tells you the room exists.
3. Click the **@devstreamer ▼** chip.
4. Click **Your room**. → `/dashboard` managing view: "Managing devstreamer test room", `Accepting joins` ON, Share links card with Viewer + OBS URLs. That is "setup finished": there is no wizard and nothing further is required.

Optional +1 click: click `Name your room`, type a name, Enter, before step 2.

Alternative (partly inferred): `Enter app` → chip → `Your room` → for a zero-room account `/dashboard` shows the create form directly (observed in recon) and Create from a non-`?new=1` URL lands on the managing view (observed in T8). Also 4 clicks, and it avoids the reset, but the combination was not observed on a zero-room account.

Confusion events:
- Landing has no create CTA above the fold; the nearest visible action is `Enter app`.
- The silent reset after Create (finding 1). A person who does not know the room exists will click Create again and get a second room; that is exactly what happened in this walk (two rooms, and the first lost its handle).
- The create page says "Nothing charges anyone until you go live" but has no go-live control, and the managing view has no "live" state either.

Screens: `T5-01` .. `T5-04`, `T5-diag-after-create-click`, `T5-07` .. `T5-09`.

---

## T6 · Set default channel settings from three entry points

Start: `/account`. Each entry point was attempted in order, with defaults cleared (via the UI `Clear defaults` button) before B and C so each save is verifiable.

### T6-A · from Account (3 clicks, target 15 s, success with confusion)

The `/account` page's "Default room settings" section is display-only: it shows "No defaults saved yet" and one control, `Open the create form` (`Clear defaults` appears once something is saved). There is no editor and no save here.

Road 1, as the page suggests: `Open the create form` → `/dashboard?new=1` → the only defaults control is the checkbox **Save this setup as my defaults**. Ticking it saves nothing (`/api/account/defaults` still null); it only fires when you also click **Create room**, which creates a room as a side effect and then resets the form (finding 1). Not a defaults path, it is a create path.

Road 2, the one that works without creating a room (requires owning a room):
1. Click **Your room** (Elsewhere list) → `/dashboard` managing view.
2. Click the **Defaults** tab.
3. Click **Save current create-form as my defaults** → "✓ Saved — new rooms start from this setup", a "Saved defaults" summary appears (Price / second 0.001 USDC, Session cap 2 USDC, Transport vdo.ninja, MegaChats On, Join Stream Off, Stinger sounds On). `/account` then shows the same rows plus `Clear defaults`.

Confusion: the button says "create-form" but what it saved was the managed room's configuration; /account says defaults "are saved from the create form", which is only true of Road 1; an Account page that lists defaults but cannot set them.

Screens: `T6-A-01` .. `T6-A-08`.

### T6-B · from Create Room (2 clicks, target 15 s, success with no feedback)

Start on `/dashboard?new=1`.
1. Tick **Save this setup as my defaults** (I also clicked `Free` first so the saved values are distinguishable: 3 clicks in the walk).
2. Click **Create room** → PUT `/api/account/defaults` 200 (passkeyTickPrice "0"), then POST create 201, then the silent reset. `/account` afterwards shows "Price / second: Free room".

Confusion: no on-screen sign that defaults were saved or that a room was created; saving defaults is impossible without creating a room; the saved blob also carried `twitchChannel: "dev:devstreamer"`, prefilled from the linked account without the form saying so.

Screens: `T6-B-01` .. `T6-B-04`.

### T6-C · from a live room (4 clicks, target 20 s, success but on the wrong room)

Start on the room page `/devstreamer` (what a viewer sees). It carries no owner controls at all: display name, sign-in, wallet, `Send a MegaChat`, entrance/exit sounds, and the account chip. Dead end on the page itself.

1. Click the **@devstreamer ▼** chip.
2. Click **Your room** → `/dashboard` auto-opens the *newest* room ("My Stream", `/devstreamer_2`), not `/devstreamer`, the room I came from.
3. Click the **Defaults** tab.
4. Click **Save current create-form as my defaults** → saved (passkeyTickPrice "0", the free room's values).

Confusion: the live room's own page cannot reach its settings; the dashboard lands you in a different room than the one you were looking at, so the "defaults" snapshot is of the wrong room; correcting that costs `Switch room` + a pick (+2 clicks).

Screens: `T6-C-01` .. `T6-C-05`.

---

## T7 · Change one setting on a room you own and confirm it stuck

Start: `/app`

**Ideal path (observed): 3 clicks with a room you own, target 20 s; 5 clicks / ~45 s counting room creation (the case for a fresh account).**

Creation from /app, if needed (4 clicks, observed pieces): **Open a room** tile → **Create room** → silent reset → chip → **Your room**.

With a room:
1. Click the **@devstreamer ▼** chip.
2. Click **Your room** → managing view of the newest room.
3. Click into **Room name**, replace the text ("Renamed by T7"). A PUT to `/api/dashboard/rooms/:id` fires ~1 s after typing stops. Nothing on screen acknowledges it.
4. Reload (`/dashboard`): the field shows "Renamed by T7" and the header reads "Managing Renamed by T7". Confirmed via `/api/dashboard/my-rooms` as well.

Confusion: no saved/saving indicator (finding 3), so "confirm it stuck" genuinely requires the reload.

Screens: `T7-01` .. `T7-05`.

---

## T8 · Delete a room, then create a new one

Start: `/app`

**Blocked at "delete". Path up to the block: 2 clicks. Creating a new room from there: +2 clicks, target 25 s for the create half.**

1. Click the **@devstreamer ▼** chip.
2. Click **Your room** → managing view. Searched all 48 visible controls, opened both disclosures (`Advanced — fine-tuning`, `OBS setup guide`), and checked the Account and Defaults tabs and `/account`: nothing matching delete / remove / archive / close. The server has no delete route either (`rooms-store.js` has `deleteRoom`, but nothing calls it from `dashboard-routes.js`). The only lifecycle control is the `Accepting joins` switch (pause).

Second half, which works:
3. Click **Start new room** (managing header) → create page on `/dashboard` (no `?new=1`), link prefilled `devstreamer_3`.
4. Click **Create room** → lands on the managing view "Managing My Stream", Share links for `/devstreamer_3`. This is the one create entry that does not reset.

Missing: any delete-room control or endpoint. Also missing: a way to tell one "My Stream" from another once several exist (the chip menu only offers "Your room").

Screens: `T8-01` .. `T8-05`.

---

## T9 · End a stream, then start a new one

Start: `/app`

**Ideal path (observed): 4 clicks with a room, target 20 s; 6 clicks / ~30 s counting creation. Success only under the reading "end = pause the room".**

1. Click the **@devstreamer ▼** chip.
2. Click **Your room** → managing view. There is no `End stream`, `Stop`, `Go live` or `Start stream` control. The candidates are the **Accepting joins** switch (header of MegaChat Settings) and `Start new room`, which creates another room.
3. Click the **Accepting joins** switch → label flips to **Paused**, POST `/rooms/:id/stop` 200. Share links card says "Room is paused — links keep working when you resume." The viewer page (`/devstreamer_3`) shows "This room is not accepting new joins right now." under the (still enabled) `Send a MegaChat — FREE` button.
4. Click the switch again → **Accepting joins**, POST `/rooms/:id/start` 200.

Confusion: nothing is called a stream or says live/ended; the switch is a bare pill whose meaning is the small label beside it; `Start new room` reads like "start a new stream" but opens the create page; the paused viewer page still headlines "Put your face on the stream. Pay by the second." The Co-host booth (camera) card never appeared because every room came out on the vdo.ninja transport (the create page has no transport control; "Video connection: Automatic").

Screens: `T9-01` .. `T9-04`.

---

## T10 · Add the room to OBS

Start: `/app`

**Ideal path (observed): 3 clicks with a room, target 15 s; 5 clicks / ~25 s counting creation.**

1. Click the **@devstreamer ▼** chip.
2. Click **Your room** → managing view; the **Share links** card is top-right with rows Viewer / OBS / Host cam.
3. Click the copy icon on the **OBS** row (aria "Copy OBS link"). Clipboard: `http://localhost:3211/devstreamer_3/overlay`. The icon swaps to a check for 1.5 s. Opening that URL redirects to `/overlay?room=853ff9f7` and renders.

Not present: the one-click `Add it to OBS for me` panel (`OBS_ONECLICK` is off, `/api/config` reports `obsOneClick:false`). Present: an `OBS setup guide` disclosure with five text steps (Browser Source ~340x620, control audio via OBS, monitoring, hardware acceleration, keep the dashboard open).

Confusion: the copy control is an unlabeled icon; the chip menu's "Your room link" is the viewer link, not the overlay; the setup guide's suggested source size (340x620) contradicts the one-click component's full-canvas rule when that feature is on.

Screens: `T10-01` .. `T10-06`.

---

## Summary table

| task | ideal clicks (with a room) | clicks for a fresh account | target s | outcome |
|---|---:|---:|---:|---|
| T5 create + finish setup | 4 | 4 | 30 | success; silent reset after Create, room found via chip → Your room |
| T6-A defaults from Account | 3 | 3 (needs a room) | 15 | success via dashboard Defaults tab; /account itself cannot save |
| T6-B defaults from Create Room | 2 | 2 | 15 | success; requires creating a room; zero feedback |
| T6-C defaults from a live room | 4 | 4 | 20 | success but lands in the wrong room; room page has no owner controls |
| T7 change a setting, verify | 3 | 5 | 45 | success; no save indicator, reload required |
| T8 delete, then create | n/a | 2 + 2 | 25 | blocked: no delete control or API; create via Start new room works |
| T9 end, then start | 4 | 6 | 30 | success only as pause/resume; no stream controls exist |
| T10 add to OBS | 3 | 5 | 25 | success: copy OBS URL; no one-click on this server |

Creation clicks for a fresh account (used above): `Open a room` tile → `Create room` → chip → `Your room` = 4, from /app.

## Screenshot index

- `00-recon-*` signed-in recon of `/?stay=1`, `/app`, `/account`, `/dashboard`, `/dashboard?new=1`, `/demo`
- `T5-01-landing-top`, `T5-02-landing-create-cta-scrolled`, `T5-03-create-form`, `T5-04-create-form-named`, `T5-diag-after-create-click` (the reset), `T5-07-chip-menu-open`, `T5-08/09-dashboard-managing`
- `T6-A-01..08`, `T6-B-01..04`, `T6-C-01..05`
- `T7-01..05`
- `T8-01..05`
- `T9-01..04` (`T9-03` is the viewer page while paused)
- `T10-01..06` (`T10-06` is the overlay URL rendered)
