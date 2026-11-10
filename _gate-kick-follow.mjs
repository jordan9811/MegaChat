/**
 * GATE — Follow my stream on Kick (owner, 2026-11-09).
 *
 * A room that follows a Kick channel behaves like one following Twitch:
 *   K1 the Kick slug is stored, links and @ are cleaned off
 *   K2 offline, the channel's title is offered on the manage page (On Kick: …)
 *   K3 going live on Kick opens a paused room and lights it on the board
 *   K4 a name the owner typed is kept; the title is only offered beside it
 *   K5 the stream ending marks the room as ended (the close rules take over)
 *   K6 a Twitch room on the same server is untouched by Kick's answers
 * Against a fake Kick API (token + channels), so nothing leaves the machine.
 * Discriminates: the same steps on the previous follow loop (Twitch only)
 * never open the Kick room — K3 is the line that fails there.
 */
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startGateServer } from './_gate-helpers.mjs'

let pass = 0, fail = 0
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  PASS  ${n}${x ? '  (' + x + ')' : ''}`) } else { fail++; console.log(`  FAIL  ${n}${x ? '  (' + x + ')' : ''}`) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 10000, step = 300) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step) } return null }

// Fake Kick: id.kick.com token + api.kick.com channels, one live switch.
const kick = { live: false, title: 'Late night Kick chats' }
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  res.setHeader('Content-Type', 'application/json')
  if (u.pathname === '/oauth/token') return res.end(JSON.stringify({ access_token: 'fake', expires_in: 3600 }))
  if (u.pathname === '/public/v1/channels') {
    const slug = u.searchParams.get('slug')
    if (slug !== 'kickstreamer') return res.end(JSON.stringify({ data: [] }))
    return res.end(JSON.stringify({ data: [{ broadcaster_user_id: 1, slug, stream_title: kick.title, stream: { is_live: kick.live, viewer_count: kick.live ? 12 : 0 } }] }))
  }
  res.statusCode = 404; res.end('{}')
})
await new Promise((r) => fake.listen(3389, r))
const FAKE = 'http://127.0.0.1:3389'

const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-gate-kick-'))
const srv = await startGateServer({
  port: 3388, label: 'kick-follow', dataDir,
  bountyAuth: { handles: ['kickowner'] },
  env: { KICK_CLIENT_ID: 'gate', KICK_CLIENT_SECRET: 'gate', KICK_ID_BASE: FAKE, KICK_API_BASE: FAKE + '/public/v1', FOLLOW_POLL_MS: '600', FOLLOW_OFF_CONFIRM_MS: '1500', KEEP_ORPHAN_ROOMS: 'true' },
})
const APP = 'http://localhost:3388'
try {
  const headers = { 'Content-Type': 'application/json', ...srv.headers('kickowner') }
  const made = await fetch(`${APP}/api/dashboard/create`, { method: 'POST', headers, body: JSON.stringify({ name: 'My Typed Name', config: { kickChannel: 'https://kick.com/KickStreamer', twitchAuto: true, unlisted: false } }) }).then((r) => r.json())
  const id = made.roomId || made.room?.id
  const room = () => fetch(`${APP}/api/dashboard/rooms/${id}`, { headers }).then((r) => r.json())
  let r = await room()
  ok('K1 the Kick slug is stored, link and case cleaned off', r.room?.kickChannel === 'kickstreamer', String(r.room?.kickChannel))
  // Paused to start, so going live has something to open.
  await fetch(`${APP}/api/dashboard/rooms/${id}/stop`, { method: 'POST', headers })

  r = await until(async () => { const x = await room(); return x.follow?.title ? x : null })
  ok('K2 offline, the channel title is offered and says Kick', r?.follow?.title === kick.title && r?.follow?.platform === 'kick', JSON.stringify(r?.follow))

  kick.live = true
  const opened = await until(async () => { const x = await room(); return x.room?.active ? x : null }, 8000)
  ok('K3 going live on Kick opens the paused room', !!opened, String(opened?.room?.active))
  const board = await fetch(`${APP}/api/rooms/public`).then((x) => x.json())
  const card = (board.rooms || []).find((x) => x.id === id)
  ok('K3 ...and it is on air on the board', card?.twitchLive === true && card?.kickChannel === 'kickstreamer', JSON.stringify(card && { on: card.twitchLive, kick: card.kickChannel }))
  ok('K4 the typed name is kept; the title is only offered', opened?.room?.name === 'My Typed Name' && opened?.follow?.title === kick.title, opened?.room?.name)

  kick.live = false
  const ended = await until(async () => { const x = await room(); return x.follow?.state === 'ended' ? x : null }, 8000)
  ok('K5 the stream ending reads as ended', !!ended, String(ended?.follow?.state))

  const tw = await fetch(`${APP}/api/dashboard/create`, { method: 'POST', headers, body: JSON.stringify({ name: 'Twitch Side', config: { twitchChannel: 'sometwitchchan', twitchAuto: true } }) }).then((x) => x.json())
  const twId = tw.roomId || tw.room?.id
  await sleep(1500)
  const twRoom = await fetch(`${APP}/api/dashboard/rooms/${twId}`, { headers }).then((x) => x.json())
  ok('K6 a Twitch room is untouched by Kick (no Twitch API here: no answer, no change)', twRoom.follow?.platform === 'twitch' && twRoom.follow?.state == null, JSON.stringify(twRoom.follow))
} finally {
  srv.child.kill()
  fake.close()
}
console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
