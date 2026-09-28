'use client'

// ECHO DETECTOR — is this page's mic sending back the voice this page plays?
//
// 2026-09-26, live: the streamer "echoing to myself" — a guest's device was
// sending his own voice back — and, on speakers, guests who can hear
// themselves. The howl guard (howl-guard.ts) stops a loop that RUNS AWAY; this
// catches the steady echo that does not, and names it, so the person who can
// fix it (headphones, or the other tab playing the stream) is told.
//
// HOW. Every 20ms, the loudness of what this page PLAYS of the other side (the
// reference) and of what its mic SENDS (a clone of the processed mic track).
// Speech rises and falls; if the mic's loudness keeps following the
// reference's at one fixed delay, the reference is getting into the mic. Once
// a second the two are correlated over the last 8s at every delay up to
// `maxLagS`: the streamer's booth looks under a second (speakers into the mic),
// a guest's page up to 30s (a stream tab playing the show back). Talking over
// each other and taking turns do not follow each other — only a leak does.
// It reports only when the same delay wins again on fresh audio, and clears
// only after half a minute of the other side talking with no echo (EchoJudge).

export type EchoFinding = { lagS: number; r: number }
export type EchoDetector = { stop: () => void; state: 'on' | 'off' }

const FRAME_S = 0.02
const WINDOW_S = 8
const MIN_ACTIVE = 0.15 // the reference must be talking for this share of the window compared
const TOL_FRAMES = 3 // the same delay, ±60ms

const PROCESSOR = `
class EchoEnvelope extends AudioWorkletProcessor {
  constructor() {
    super();
    this.n = Math.round(sampleRate * ${FRAME_S});
    this.acc = [0, 0]; this.cnt = 0;
    this.hp = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
    this.a = Math.exp(-2 * Math.PI * 150 / sampleRate); // one-pole high-pass: hum and rumble out
    this.out = []; // [refDb, micDb] pairs, posted once a second
  }
  process(inputs) {
    const len = (inputs[0] && inputs[0][0] && inputs[0][0].length) || (inputs[1] && inputs[1][0] && inputs[1][0].length) || 128;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < 2; c++) {
        const ch = inputs[c] && inputs[c][0];
        const x = ch ? ch[i] : 0;
        const h = this.hp[c];
        const y = this.a * (h.y + x - h.x); h.x = x; h.y = y;
        this.acc[c] += y * y;
      }
      if (++this.cnt === this.n) {
        this.out.push(10 * Math.log10(this.acc[0] / this.n + 1e-12), 10 * Math.log10(this.acc[1] / this.n + 1e-12));
        this.acc[0] = 0; this.acc[1] = 0; this.cnt = 0;
        if (this.out.length >= ${Math.round(2 / FRAME_S) /* one second of [ref, mic] pairs */}) { this.port.postMessage(new Float32Array(this.out)); this.out = []; }
      }
    }
    return true;
  }
}
registerProcessor('mc-echo-envelope', EchoEnvelope);
`

function percentile(a: Float32Array | number[], p: number) {
  const s = Array.from(a).sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]
}

/**
 * The best delay at which the mic follows the reference, over the last `win`
 * frames of each — and, when `atLag` is given, how well it follows at that one
 * delay (the delay already reported). Exported pure: the gate and the
 * simulation drive exactly this.
 *
 * It matches ONSETS, not loudness: the frame-to-frame change of each envelope
 * above its silence floor. Speech has a rhythm, so two unrelated voices'
 * loudness lines up at some delay by chance; where each starts and stops much
 * less so. `active` is how much the reference was talking in the stretch that
 * lines up with the mic at that delay — silence there is no evidence either
 * way. Works with the history it has: short delays from the first seconds,
 * long ones once the history covers them.
 */
export function bestLag(ref: Float32Array, mic: Float32Array, win: number, maxLag: number, atLag = -1): LagScan {
  const n = mic.length
  const cap = Math.min(maxLag, ref.length - win - 1)
  const none: LagScan = { lag: 0, lagS: 0, r: 0, active: 0, rAt: 0, activeAt: 0 }
  if (n < win + 1 || cap < Math.min(maxLag, 25)) return none
  // Floors: a quiet room is not speech. Values below the floor + 6dB count as
  // silence, so two quiet stretches never "follow" each other.
  const rf = percentile(ref.subarray(ref.length - win - cap - 1), 0.1) + 6
  const mf = percentile(mic.subarray(n - win - 1), 0.1) + 6
  const clipRef = (i: number) => Math.max(0, ref[i] - rf)
  const b = new Float32Array(win)
  for (let i = 0; i < win; i++) b[i] = Math.max(0, mic[n - win + i] - mf) - Math.max(0, mic[n - win + i - 1] - mf)
  let mb = 0
  for (let i = 0; i < win; i++) mb += b[i]
  mb /= win
  let vb = 0
  for (let i = 0; i < win; i++) vb += (b[i] - mb) * (b[i] - mb)
  const activeOf = (lag: number) => {
    const off = ref.length - win - lag
    let k = 0
    for (let i = 0; i < win; i++) if (ref[off + i] - rf > 4) k++
    return k / win
  }
  if (vb <= 1e-6) return { ...none, active: activeOf(0), activeAt: atLag >= 0 && atLag <= cap ? activeOf(atLag) : 0 }
  const a = new Float32Array(win)
  let best = { lag: 0, r: -1 }
  let rAt = 0
  for (let lag = 0; lag <= cap; lag++) {
    const off = ref.length - win - lag
    let ma = 0
    for (let i = 0; i < win; i++) { a[i] = clipRef(off + i) - clipRef(off + i - 1); ma += a[i] }
    ma /= win
    let va = 0, cov = 0
    for (let i = 0; i < win; i++) { const da = a[i] - ma; va += da * da; cov += da * (b[i] - mb) }
    if (va <= 1e-6) continue
    const r = cov / Math.sqrt(va * vb)
    if (r > best.r) best = { lag, r }
    if (atLag >= 0 && Math.abs(lag - atLag) <= TOL_FRAMES && r > rAt) rAt = r
  }
  return {
    lag: best.lag, lagS: best.lag * FRAME_S, r: Math.max(0, best.r), active: activeOf(best.lag),
    rAt, activeAt: atLag >= 0 && atLag <= cap ? activeOf(atLag) : 0,
  }
}

export type LagScan = { lag: number; lagS: number; r: number; active: number; rAt: number; activeAt: number }

/**
 * When is it an echo, and when is it over? Fed one scan a second.
 *
 * REPORT: a delay wins (r ≥ minR while the reference talks), and the same
 * delay (±60ms) also won in a window that shares NO audio with this one —
 * 8s+ earlier, within the last 40s. Searching hundreds of delays, one
 * window's winner is often chance; the same delay winning again on fresh audio
 * is not. (Three windows running, as first shipped, shared most of their audio
 * — one observation, not three.)
 * CLEAR: only after `clearAfter` scans in which the reference talked at the
 * reported delay and the mic did not follow it even loosely (r < holdR there).
 * A real, steady echo scores below minR in plenty of windows — the mic's own
 * talk swamps it — and must not flicker off and on.
 */
export class EchoJudge {
  reportedLag = -1
  private hits: { e: number; lag: number }[] = []
  private e = 0
  private quiet = 0
  private o: { minR: number; gap: number; horizon: number; clearAfter: number; holdR: number }
  constructor(o: { minR: number; gap: number; horizon: number; clearAfter: number; holdR: number }, reportedLag = -1) {
    this.o = o
    this.reportedLag = reportedLag
  }
  step(f: LagScan): 'echo' | 'clear' | null {
    this.e++
    if (this.reportedLag >= 0) {
      if (f.activeAt < MIN_ACTIVE) return null // the reference was quiet there: no evidence
      if (f.rAt >= this.o.holdR) { this.quiet = 0; return null }
      if (++this.quiet >= this.o.clearAfter) {
        this.reportedLag = -1
        this.quiet = 0
        this.hits = []
        return 'clear'
      }
      return null
    }
    if (f.active < MIN_ACTIVE || f.r < this.o.minR) return null
    this.hits = this.hits.filter((h) => this.e - h.e <= this.o.horizon)
    const again = this.hits.some((h) => this.e - h.e >= this.o.gap && Math.abs(h.lag - f.lag) <= TOL_FRAMES)
    this.hits.push({ e: this.e, lag: f.lag })
    if (!again) return null
    this.reportedLag = f.lag
    this.quiet = 0
    return 'echo'
  }
}

/** The judge's settings for a search up to `maxLag` frames. */
export function judgeFor(maxLag: number, reportedLag = -1) {
  const win = Math.round(WINDOW_S / FRAME_S)
  return new EchoJudge({
    // More delays searched, more chance winners: ask more of each.
    minR: maxLag > 60 ? 0.45 : 0.4,
    gap: Math.round(win / 50), // scans arrive once a second; this many = no shared audio
    horizon: 40,
    clearAfter: 30,
    holdR: 0.25,
  }, reportedLag)
}

/**
 * Watch whether `mic` carries `ref` back, at a delay up to `maxLagS`. `ref`
 * must be a track this page is already playing (Chrome gives WebAudio nothing
 * from a remote track no element plays). `reportedLagS` carries a finding over
 * from a detector this one replaces (a new mic track), so the report neither
 * sticks nor flickers. Resolves to a detector whose `state` says whether it is
 * really listening; after stop() it never calls back.
 */
export async function startEchoDetector(
  ref: MediaStreamTrack,
  mic: MediaStreamTrack,
  { maxLagS, onEcho, onClear, reportedLagS = null }: {
    maxLagS: number
    onEcho: (f: EchoFinding) => void
    onClear: () => void
    reportedLagS?: number | null
  },
): Promise<EchoDetector> {
  const off: EchoDetector = { stop: () => {}, state: 'off' }
  if (typeof window === 'undefined' || typeof AudioWorkletNode === 'undefined') return off
  const micClone = mic.clone()
  micClone.enabled = true // a clone copies `enabled`: the howl guard may have cut the sent track mid-duck
  let ctx: AudioContext | null = null
  let url: string | null = null
  let node: AudioWorkletNode | null = null
  let stopped = false
  const stop = () => {
    stopped = true
    if (node) {
      try { node.port.onmessage = null; node.port.close() } catch { /* gone */ }
    }
    try { micClone.stop() } catch { /* already ended */ }
    if (ctx) void ctx.close().catch(() => {})
    if (url) URL.revokeObjectURL(url)
    ctx = null
    url = null
    node = null
  }
  try {
    ctx = new AudioContext()
    url = URL.createObjectURL(new Blob([PROCESSOR], { type: 'application/javascript' }))
    await ctx.audioWorklet.addModule(url)
    if (stopped) return off
    node = new AudioWorkletNode(ctx, 'mc-echo-envelope', { numberOfInputs: 2, numberOfOutputs: 1 })
    ctx.createMediaStreamSource(new MediaStream([ref])).connect(node, 0, 0)
    ctx.createMediaStreamSource(new MediaStream([micClone])).connect(node, 0, 1)
    const sink = ctx.createGain()
    sink.gain.value = 0 // pulled by the destination so it renders; never heard
    node.connect(sink)
    sink.connect(ctx.destination)

    const maxLag = Math.round(maxLagS / FRAME_S)
    const win = Math.round(WINDOW_S / FRAME_S)
    const keep = win + maxLag + 10
    const judge = judgeFor(maxLag, reportedLagS != null ? Math.round(reportedLagS / FRAME_S) : -1)
    let refHist = new Float32Array(0)
    let micHist = new Float32Array(0)
    const push = (h: Float32Array, add: number[]) => {
      const out = new Float32Array(Math.min(keep, h.length + add.length))
      const from = h.length + add.length - out.length
      for (let i = 0; i < out.length; i++) { const j = from + i; out[i] = j < h.length ? h[j] : add[j - h.length] }
      return out
    }
    node.port.onmessage = (m: MessageEvent) => {
      if (stopped) return
      const f = m.data as Float32Array
      const r: number[] = []
      const k: number[] = []
      for (let i = 0; i < f.length; i += 2) { r.push(f[i]); k.push(f[i + 1]) }
      refHist = push(refHist, r)
      micHist = push(micHist, k)
      const scan = bestLag(refHist, micHist, win, maxLag, judge.reportedLag)
      const verdict = judge.step(scan)
      if (verdict === 'echo') onEcho({ lagS: scan.lagS, r: scan.r })
      else if (verdict === 'clear') onClear()
    }
    if (ctx.state !== 'running') await ctx.resume().catch(() => {})
    if (stopped) return off
    if (ctx.state !== 'running') {
      stop()
      return off
    }
    return { stop, state: 'on' }
  } catch (e) {
    console.warn('[echo-detector] could not start', e)
    stop()
    return off
  }
}
