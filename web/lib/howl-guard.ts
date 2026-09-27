'use client'

// HOWL GUARD — the last line of defence against feedback on the booth mic.
//
// Every loop through MegaChat passes the streamer's booth mic: guests play only
// the host (join-page.ts), so a sound that circulates host → guest → host has
// to go out through this mic every time round. On 2026-09-26 one did, on the
// streamer's monitor speakers, and grew into "the deafening siren". The booth
// now keeps the overlay silent wherever its mic cannot cancel it
// (host-cam-card.tsx, mc.seatAudio) — but Chrome's ordinary canceller has
// never been measured on those speakers, and a guest's leaky device can close
// a loop too. So this listens for what a howl IS, and breaks the loop when it
// hears one.
//
// WHAT A HOWL LOOKS LIKE. One frequency, far above its neighbours, with no
// harmonics of its own (speech and sung notes have strong ones), loud, and
// holding the same pitch for half a second.
//
// WHAT IT DOES. The track guests receive is disabled (`enabled = false`: the
// sender keeps sending, silence) — the loop is cut where it leaves this PC.
// The analysis runs on a CLONE, which keeps hearing the room:
//   · the tone collapses within 2s (a loop keeps sounding for one round trip
//     after the cut) → send the mic again; if the same pitch builds again
//     within 2.5s it IS the loop — cut again, and count it.
//   · it stops at once → it ended by itself (a beep): send the mic again.
//   · it does not collapse → a real tone in the room (a whistle, a game
//     alarm): send the mic again and ignore that pitch while it lasts.
// The stream never loses the streamer's voice: OBS records the mic itself.
//
// WHERE IT RUNS. An AudioWorklet — the audio thread is not throttled in a
// background tab, and the booth tab is in the background whenever the
// streamer is playing.

// reformed: this cut came right after an earlier one ended the same pitch —
// the loop built again, so it is feedback (not a whistle or a beep).
export type HowlEvent = { freq: number; db: number; reformed?: boolean; heldS?: number; why?: string }
export type HowlGuard = { stop: () => void; state: 'on' | 'off' }

const PROCESSOR = `
const N = 2048, HOP = 1024;
const MIN_HZ = 150, MAX_HZ = 6000;
const TONAL_OVER_NEIGHBOURS_DB = 15;
const TONAL_OVER_HARMONICS_DB = 10;
const MIN_DBFS = -40;
const PERSIST_S = 0.5;       // a howl holds its pitch this long before it is cut
const HIT_RATIO = 0.7;       // ...in at least this share of the steps (speech over it drops some)
const MAX_MISSES = 4;        // ~85 ms of steps that do not look like it before the timer restarts
const DECAY_DB = 20;
// After the cut, a loop keeps sounding for one round trip — up to ~1.7 s
// through a far or Bluetooth guest, or Through OBS — plus the room's tail.
const DECAY_WINDOW_S = 2.0;
const HOLD_AFTER_DROP_S = 0.3;
// A tone that stops sooner than any loop audio could come back stopped by
// itself (a beep, a whistle ending): not the loop.
const MIN_LOOP_S = 0.12;
// A cut that ended a tone is only CONFIRMED as feedback when the same pitch
// builds again this soon after the mic is sent again — a loop with gain above
// one always does; a whistle or a beep that ended by itself does not.
const REFORM_S = 2.5;
const IGNORE_GONE_S = 5;     // an ignored room tone is forgotten once gone this long
const IGNORE_MAX_S = 20;     // ...and re-tested after this long, even if still there

class HowlGuardProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(N);
    this.fill = 0;
    this.win = new Float32Array(N);
    let sum = 0;
    for (let i = 0; i < N; i++) { this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); sum += this.win[i]; }
    this.norm = 2 / sum; // bin magnitude → sine amplitude
    this.re = new Float32Array(N);
    this.im = new Float32Array(N);
    this.rev = new Uint32Array(N);
    const bits = Math.log2(N);
    for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.cos = new Float32Array(N / 2);
    this.sin = new Float32Array(N / 2);
    for (let i = 0; i < N / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / N); this.sin[i] = -Math.sin((2 * Math.PI * i) / N); }
    this.db = new Float32Array(N / 2);
    this.hz = sampleRate / N;
    this.lo = Math.max(2, Math.ceil(MIN_HZ / this.hz));
    this.hi = Math.min(N / 2 - 14, Math.floor(MAX_HZ / this.hz));
    this.t = 0; // seconds of audio analysed
    this.state = 'listen';
    this.cand = -1; this.candSince = 0; this.hits = 0; this.frames = 0; this.miss = 0;
    this.duck = null; // { bin, db0, at, dropAt }
    this.suspect = null; // { bin, releasedAt } — a cut that ended a tone, awaiting a rebuild
    this.ignored = new Map(); // bin → { last, since }
  }

  fft() {
    const re = this.re, im = this.im;
    for (let i = 0; i < N; i++) { const j = this.rev[i]; if (j > i) { let x = re[i]; re[i] = re[j]; re[j] = x; x = im[i]; im[i] = im[j]; im[j] = x; } }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let s = 0; s < N; s += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step], d = this.sin[k * step];
          const a = s + k, b = a + half;
          const tr = re[b] * c - im[b] * d, ti = re[b] * d + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  // Loudest of k-1..k+1 (a tone can sit between bins).
  peakNear(k) { return Math.max(this.db[k - 1] ?? -200, this.db[k] ?? -200, this.db[k + 1] ?? -200); }

  // Is bin k a howl-like tone: a local peak, loud, far over its neighbours,
  // with no harmonics or sub-harmonic of its own (voices and notes have them)?
  tonalAt(k) {
    if (k < this.lo || k > this.hi) return false;
    const v = this.db[k];
    if (v < MIN_DBFS) return false;
    for (let o = 1; o <= 2; o++) if (this.db[k - o] > v || this.db[k + o] > v) return false;
    let p = 0, n = 0;
    for (let o = 4; o <= 12; o++) { p += Math.pow(10, this.db[Math.max(1, k - o)] / 10) + Math.pow(10, this.db[k + o] / 10); n += 2; }
    if (v - 10 * Math.log10(p / n + 1e-24) < TONAL_OVER_NEIGHBOURS_DB) return false;
    let harm = -200;
    for (const m of [2, 3]) { const h = k * m; if (h + 1 < N / 2) harm = Math.max(harm, this.peakNear(h)); }
    const sub = Math.round(k / 2);
    if (sub - 1 >= 1) harm = Math.max(harm, this.peakNear(sub));
    return v - harm >= TONAL_OVER_HARMONICS_DB;
  }

  release(confirmed) {
    const d = this.duck;
    this.port.postMessage({ type: 'release', confirmed, freq: d.bin * this.hz, db: d.db0, heldS: this.t - d.at, why: d.dropAt == null ? 'room-tone' : d.dropAt - d.at < MIN_LOOP_S ? 'ended' : 'collapsed' });
    this.state = 'listen'; this.duck = null;
    this.cand = -1; this.miss = 0;
  }

  analyse() {
    for (let i = 0; i < N; i++) { this.re[i] = this.buf[i] * this.win[i]; this.im[i] = 0; }
    this.fft();
    for (let k = 0; k < N / 2; k++) {
      const m = Math.hypot(this.re[k], this.im[k]) * this.norm;
      this.db[k] = 20 * Math.log10(m + 1e-12);
    }
    const now = this.t;
    if (this.suspect && now - this.suspect.releasedAt > REFORM_S) this.suspect = null;

    if (this.state === 'ducked') {
      const d = this.duck;
      const level = this.peakNear(d.bin);
      if (d.dropAt == null && level <= d.db0 - DECAY_DB) d.dropAt = now;
      if (d.dropAt != null && d.dropAt - d.at < MIN_LOOP_S) {
        this.release(false); // it stopped by itself, before any loop audio could come back
      } else if (d.dropAt != null && now - d.dropAt >= HOLD_AFTER_DROP_S) {
        // The cut ended it. Feedback only if it builds again once the mic is back.
        this.suspect = { bin: d.bin, releasedAt: now };
        this.release(false);
      } else if (d.dropAt == null && now - d.at >= DECAY_WINDOW_S) {
        // Still sounding with the loop cut: a real tone in the room.
        this.ignored.set(d.bin, { last: now, since: now });
        this.release(false);
      }
      return;
    }

    // The loudest bin in the band — or the running candidate, which need not
    // be the loudest while the streamer talks over it.
    let k = this.lo;
    for (let i = this.lo + 1; i <= this.hi; i++) if (this.db[i] > this.db[k]) k = i;
    let tonal = this.tonalAt(k);
    if (!tonal && this.cand >= 0) {
      let c = this.cand;
      for (const j of [this.cand - 1, this.cand + 1]) if (this.db[j] > this.db[c]) c = j;
      if (this.tonalAt(c)) { k = c; tonal = true; }
    }

    // Ignored room tones: refreshed while they sound, forgotten once gone, and
    // re-tested after a while even if they are still there.
    let isIgnored = false;
    for (const [b, e] of this.ignored) {
      if (now - e.since > IGNORE_MAX_S) { this.ignored.delete(b); continue; }
      if (tonal && Math.abs(b - k) <= 1) { e.last = now; isIgnored = true; }
      else if (now - e.last > IGNORE_GONE_S) this.ignored.delete(b);
    }

    if (!tonal || isIgnored) {
      if (this.cand >= 0) { this.frames++; if (++this.miss > MAX_MISSES) { this.cand = -1; this.miss = 0; } }
      return;
    }
    this.miss = 0;
    if (this.cand < 0 || Math.abs(k - this.cand) > 1) {
      this.cand = k; this.candSince = now; this.hits = 1; this.frames = 1;
      return;
    }
    this.cand = k; this.hits++; this.frames++;
    if (now - this.candSince >= PERSIST_S && this.hits / this.frames >= HIT_RATIO) {
      const reformed = !!(this.suspect && Math.abs(k - this.suspect.bin) <= 1);
      this.suspect = null;
      this.state = 'ducked';
      this.duck = { bin: k, db0: this.db[k], at: now, dropAt: null };
      this.port.postMessage({ type: 'duck', freq: k * this.hz, db: this.db[k], reformed });
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.fill++] = ch[i];
        if (this.fill === N) {
          this.t += HOP / sampleRate;
          this.analyse();
          this.buf.copyWithin(0, HOP);
          this.fill = N - HOP;
        }
      }
    }
    return true;
  }
}
registerProcessor('mc-howl-guard', HowlGuardProcessor);
`

/**
 * Watch `sendTrack` (the mic track guests receive) for feedback. Resolves to
 * a guard whose `state` says whether it is really listening — an audio
 * context a browser will not start leaves it 'off', and the caller says so.
 */
export async function startHowlGuard(
  sendTrack: MediaStreamTrack,
  handlers: {
    onDuck?: (e: HowlEvent) => void
    onRelease?: (e: HowlEvent & { confirmed: boolean }) => void
  } = {},
): Promise<HowlGuard> {
  const off: HowlGuard = { stop: () => {}, state: 'off' }
  if (typeof window === 'undefined' || typeof AudioWorkletNode === 'undefined') return off
  const listen = sendTrack.clone() // keeps hearing the room while the sent track is cut
  let ctx: AudioContext | null = null
  let url: string | null = null
  const stop = () => {
    try { sendTrack.enabled = true } catch { /* already ended */ }
    try { listen.stop() } catch { /* already ended */ }
    if (ctx) void ctx.close().catch(() => {})
    if (url) URL.revokeObjectURL(url)
    ctx = null
    url = null
  }
  try {
    ctx = new AudioContext()
    url = URL.createObjectURL(new Blob([PROCESSOR], { type: 'application/javascript' }))
    await ctx.audioWorklet.addModule(url)
    const node = new AudioWorkletNode(ctx, 'mc-howl-guard', { numberOfInputs: 1, numberOfOutputs: 1 })
    const src = ctx.createMediaStreamSource(new MediaStream([listen]))
    const sink = ctx.createGain()
    sink.gain.value = 0 // pulled by the destination so it renders; never heard
    src.connect(node)
    node.connect(sink)
    sink.connect(ctx.destination)
    node.port.onmessage = (m: MessageEvent) => {
      const d = m.data as { type: string; freq: number; db: number; confirmed?: boolean; reformed?: boolean; heldS?: number; why?: string }
      if (d.type === 'duck') {
        sendTrack.enabled = false
        handlers.onDuck?.({ freq: d.freq, db: d.db, reformed: !!d.reformed })
      } else if (d.type === 'release') {
        sendTrack.enabled = true
        handlers.onRelease?.({ freq: d.freq, db: d.db, confirmed: !!d.confirmed, heldS: d.heldS, why: d.why })
      }
    }
    if (ctx.state !== 'running') await ctx.resume().catch(() => {})
    if (ctx.state !== 'running') {
      stop()
      return off
    }
    return { stop, state: 'on' }
  } catch (e) {
    console.warn('[howl-guard] could not start', e)
    stop()
    return off
  }
}
