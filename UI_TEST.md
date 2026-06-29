# UI test — editorial neon-noir overhaul

Automated gate: `npm run gate:ui-a`

## Visual system

- [ ] Light/dark toggle (top-right) switches theme without reload
- [ ] Typography: Space Grotesk headings, Inter body — clear size hierarchy
- [ ] Light mode: warm off-white base, accent only on price + primary CTA
- [ ] Dark mode: deep ink base, subtle cyan glow on price + primary CTA
- [ ] No gradient “Start trial” buttons, no neon everywhere

## Dashboard (`/dashboard`)

### Entry
- [ ] Hero zone with top padding — nothing flush to viewport edge
- [ ] **Create room** / **Manage** tabs

### Create form
- [ ] Short labels: Charge interval (sec), Max spend, Max seats, Payment token
- [ ] Long text only in (?) tooltips — no helper paragraphs under fields
- [ ] Room password in the config grid (not a separate block)
- [ ] **Create room** button at bottom of form — prominent primary
- [ ] No JOIN/OBS links until after successful create
- [ ] After create: links animate in below button as compact rows + copy icons
- [ ] Inline toast near create button (not top green banner)

### Manage
- [ ] Unlock with room ID + password
- [ ] Single toggle: **Accepting joins** ⟷ **Paused**
- [ ] Config auto-saves on change (no Save button)
- [ ] **On camera** section below controls; ghost kick on hover
- [ ] Rewards optional section still works

## Join page (`/`)

- [ ] Hero: “Put your face on the stream. Pay by the second.”
- [ ] Price block with accent amount
- [ ] MetaMask / Passkey ghost buttons; primary **Join on camera**
- [ ] Passkey + MetaMask join flows unchanged
- [ ] Meter, rewards row, camera stage unchanged functionally

## Global

- [ ] `/favicon.svg` loads (no 404)
- [ ] `/overlay` unchanged (not restyled)
- [ ] Mobile responsive at ~375px width
- [ ] Console clean on load (no TDZ errors)

## Regression

- [ ] Create room with password → manage view
- [ ] Copy icons copy JOIN + overlay URLs
- [ ] Pause toggle stops new joins; kick removes viewer
- [ ] Passkey per-second join + MetaMask Gateway join still work
