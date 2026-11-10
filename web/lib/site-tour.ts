/**
 * The site tour's runner: a frosted speech bubble that points at one control
 * at a time, glowing in that step's feature colour, with a pulse ring on the
 * control, a count ("Bounties · 2/3", and a square per chapter), Next and
 * Skip tour.
 *
 * One tour, chapters across pages (lib/site-tour-state.ts CHAPTERS), started
 * only on the demo. Each page runs its own chapter with runTour: the demo from
 * lib/demo-coach.ts, the rest from lib/site-tour-chapters.ts through
 * components/site-tour.tsx. A chapter's last bubble says where the tour goes
 * next ("Next: Bounties →"): pressing it saves the hand-off and goes there in
 * the same tab, where that page's chapter picks it up.
 *
 * The runner reads the page and never drives it. A step whose control is not
 * on the page is skipped, never shown as a bubble pointing at nothing. Skip,
 * Escape or the end of the tour ends it on every page; "Show me around" on
 * the demo starts it over. Styles: globals.css, "Site tour".
 */

import { CHAPTERS, type ChapterId, writeTour } from './site-tour-state'

export type TourFeature = 'holler' | 'callin' | 'rewards' | 'bounty'

export type TourView = {
  target: HTMLElement
  feature: TourFeature
  text: string
  // The kicker; the feature's own name when left out.
  label?: string
  // The chapter's last word: no ring, and the button moves the tour on.
  final?: boolean
  // A second button beside Next (the signed-out account's Sign in).
  action?: { label: string; run: () => void }
}

export type TourResolution = TourView | 'wait' | 'next' | 'back'

export type TourStep = {
  id: string
  // Steps sharing a part count as one number (Record belongs to Holler).
  part?: string
  // Can Next land here right now?
  ready: () => boolean
  // What to show, or wait (show nothing yet), or move on / step back.
  // `since`: ms since this step became the current one.
  resolve: (since: number) => TourResolution
  // Pressing the control itself is the step done.
  advancesOnClick?: boolean
  onAdvance?: () => void
}

export type TourRun = {
  chapter: ChapterId
  steps: TourStep[]
  startAt?: number
  // Off: wait for "Show me around" (needs replayHost).
  autoStart?: boolean
  // Where "Show me around" goes; the demo's room strip.
  replayHost?: Element | null
  // What to watch for changes; the whole page when left out.
  observe?: Element | null
  // Count every step's part, ready or not (the demo's three parts).
  countEverything?: boolean
  // 'center': the control to the middle (the demo, whose console scrolls on
  // its own); 'fit': the window scrolls so the control and its bubble fit.
  scroll?: 'center' | 'fit'
  // Out-of-order actions: a step to jump to, or null.
  jump?: (idx: number, done: Set<string>) => number | null
  onStart?: () => void
}

const LABEL: Record<TourFeature, string> = { holler: 'Holler', callin: 'Call in', rewards: 'Watch to earn', bounty: 'Bounties' }

// Every product page's sticky bar: the bubble never tucks under it.
const HEADERS = '.mcj-product-header, .mcb-product-header, .mcp-header, .mcc-product-header, .mc-product-header'

export function shown(el: Element | null | undefined): el is HTMLElement {
  return !!el && el instanceof HTMLElement && el.isConnected && !el.hidden && el.getClientRects().length > 0
}

function stillPlease(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

let current: (() => void) | null = null

/** Run a chapter on this page. Returns cleanup. */
export function runTour(run: TourRun): () => void {
  // One tour per page: a re-run of the page's init replaces the old one.
  if (current) current()
  const stop = createTour(run)
  current = stop
  return () => {
    stop()
    if (current === stop) current = null
  }
}

function createTour(run: TourRun): () => void {
  const { steps, chapter } = run
  const ac = new AbortController()
  const at = Math.max(0, CHAPTERS.findIndex((c) => c.id === chapter))
  const nextChapter = CHAPTERS[at + 1] || null

  // ── Markup ────────────────────────────────────────────────────────────
  const root = document.createElement('div')
  root.className = 'site-tour is-hidden'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', 'Guided tour')
  const pips = CHAPTERS.map((c, i) => `<i class="${i < at ? 'is-past' : i === at ? 'is-now' : ''}"></i>`).join('')
  root.innerHTML = `
    <div class="site-tour-fog" aria-hidden="true"></div>
    <div class="site-tour-bubble">
      <span class="site-tour-arrow" aria-hidden="true"></span>
      <div class="site-tour-head">
        <span class="site-tour-kicker"><i aria-hidden="true"></i><span data-tour="label"></span></span>
        <span class="site-tour-count"><span class="site-tour-pips" aria-hidden="true">${pips}</span><span data-tour="count"></span></span>
      </div>
      <p class="site-tour-text" data-tour="text" aria-live="polite"></p>
      <div class="site-tour-actions">
        <button type="button" class="site-tour-skip" data-tour="skip">Skip tour</button>
        <button type="button" class="site-tour-alt" data-tour="alt" hidden></button>
        <button type="button" class="site-tour-next" data-tour="next">Next</button>
      </div>
    </div>`
  const ring = document.createElement('div')
  ring.className = 'site-tour-ring is-hidden'
  ring.setAttribute('aria-hidden', 'true')
  const part = (name: string) => root.querySelector(`[data-tour="${name}"]`) as HTMLElement
  const labelEl = part('label')
  const countEl = part('count')
  const textEl = part('text')
  const skipBtn = part('skip') as HTMLButtonElement
  const altBtn = part('alt') as HTMLButtonElement
  const nextBtn = part('next') as HTMLButtonElement
  const bubble = root.querySelector('.site-tour-bubble') as HTMLElement

  let replay: HTMLButtonElement | null = null
  if (run.replayHost) {
    replay = document.createElement('button')
    replay.type = 'button'
    replay.className = 'site-tour-replay'
    replay.textContent = 'Show me around'
    replay.hidden = true
    run.replayHost.append(replay)
  }

  document.body.append(ring, root)

  // ── State ─────────────────────────────────────────────────────────────
  let running = false
  let idx = 0
  let since = Date.now()
  let view: TourView | null = null
  let lastKey = ''
  let action: TourView['action'] = undefined
  const done = new Set<string>()
  const seen = new Set<string>()

  function setIdx(i: number) {
    if (i === idx) return
    idx = i
    since = Date.now()
  }

  function resolveView(): TourView | null {
    const j = run.jump ? run.jump(idx, done) : null
    if (j != null) setIdx(j)
    for (let guard = 0; guard < steps.length * 3; guard += 1) {
      const step = steps[idx]
      if (!step) { ranOut(); return null }
      const r = step.resolve(Date.now() - since)
      if (r === 'wait') return null
      if (r === 'next') { done.add(step.id); setIdx(idx + 1); continue }
      if (r === 'back') { setIdx(Math.max(0, idx - 1)); continue }
      return r
    }
    return null
  }

  // Past the chapter's last step without a bubble to end on. A chapter that
  // found nothing at all to show (the page is in a state none of its steps
  // fit) passes the tour straight on; otherwise the tour ends here.
  function ranOut() {
    if (!seen.size && nextChapter && chapter !== 'demo') handOff(true)
    else finish()
  }

  function headerBottom(): number {
    let bottom = 0
    for (const hdr of document.querySelectorAll(HEADERS)) {
      const pos = getComputedStyle(hdr).position
      if (pos === 'sticky' || pos === 'fixed') bottom = Math.max(bottom, hdr.getBoundingClientRect().bottom)
    }
    return bottom
  }

  function modalOpen(): boolean {
    return !!document.querySelector('[aria-modal="true"]')
  }

  function setHidden(on: boolean) {
    root.classList.toggle('is-hidden', on)
    ring.classList.toggle('is-hidden', on || !!view?.final)
  }

  // The chapter's last bubble: Next leaves for the next chapter (or ends).
  function isLast(v: TourView): boolean {
    return !!v.final || !steps.slice(idx + 1).some((s) => s.ready())
  }

  // The count, the button and Skip follow what is on the page now, so a
  // step that turns up (or goes) after the bubble opened never leaves a
  // stale "Next: Bounties →" or a skipped number.
  function syncChrome(v: TourView) {
    const partOf = (s: TourStep) => s.part || s.id
    const pool = run.countEverything ? steps : steps.filter((s, i) => i === idx || seen.has(s.id) || (i > idx && s.ready()))
    const parts = [...new Set(pool.map(partOf))]
    const count = `${CHAPTERS[at].name} · ${parts.indexOf(partOf(steps[idx])) + 1}/${parts.length}`
    if (countEl.textContent !== count) countEl.textContent = count
    const last = isLast(v)
    const label = !last ? 'Next' : nextChapter ? `Next: ${nextChapter.name} →` : 'Done'
    if (nextBtn.textContent !== label) nextBtn.textContent = label
    skipBtn.hidden = last && !nextChapter
    action = v.action
    altBtn.hidden = !action
    if (action && altBtn.textContent !== action.label) altBtn.textContent = action.label
  }

  function fill(v: TourView) {
    root.dataset.feature = v.feature
    ring.dataset.feature = v.feature
    labelEl.textContent = v.label || LABEL[v.feature]
    textEl.textContent = v.text
    // Replay the entrance for each new step.
    root.classList.remove('is-in')
    void root.offsetWidth
    root.classList.add('is-in')
  }

  function bringIntoView(target: HTMLElement) {
    const r = target.getBoundingClientRect()
    const top0 = headerBottom() + 8
    const vh = window.innerHeight
    const behavior: ScrollBehavior = stillPlease() ? 'auto' : 'smooth'
    if (run.scroll !== 'fit') {
      if (r.top >= top0 && r.bottom <= vh - 8) return
      target.scrollIntoView({ block: 'center', behavior })
      return
    }
    // The control and its bubble both in view, on either side: leave it.
    const bh = bubble.offsetHeight || 150
    const room = (r.bottom + 16 + bh <= vh - 8) || (r.top - 16 - bh >= top0)
    if (r.top >= top0 && r.bottom <= vh - 8 && room) return
    const need = r.height + 16 + bh
    const free = vh - 8 - top0 - need
    // The pair centred in the view, or the control's top under the header
    // when the pair is taller than the view.
    const dy = free >= 0 ? r.top - (top0 + free / 2) : r.top - top0
    window.scrollBy({ top: dy, behavior })
  }

  function place(v: TourView) {
    const r = v.target.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    const vh = window.innerHeight
    const top0 = headerBottom() + 8
    // Scrolled out of sight: the bubble goes with it rather than float alone.
    const away = r.bottom < top0 || r.top > vh - 8 || r.right < 0 || r.left > vw
    setHidden(away)
    if (away) return

    // The ring: 5px clear of the control, never past the viewport's edge.
    const pad = 5
    const left = Math.max(2, r.left - pad)
    const right = Math.min(vw - 2, r.right + pad)
    const rw = Math.max(0, right - left)
    const rh = r.height + pad * 2
    ring.style.width = `${rw}px`
    ring.style.height = `${rh}px`
    ring.style.transform = `translate3d(${left}px, ${r.top - pad}px, 0)`
    ring.style.setProperty('--tour-sx', String((rw + 14) / Math.max(1, rw)))
    ring.style.setProperty('--tour-sy', String((rh + 14) / Math.max(1, rh)))
    ring.style.borderRadius = getComputedStyle(v.target).borderRadius || '0'

    // The bubble: below the control when it fits, else above, else the
    // roomier side. Never over the control; never past the 16px gutter.
    const w = Math.min(320, vw - 32)
    root.style.width = `${w}px`
    const bh = bubble.offsetHeight
    const gap = 16
    const below = vh - r.bottom - gap - 8
    const above = r.top - gap - top0
    const under = bh <= below || (bh > above && below >= above)
    const y = under ? r.bottom + gap : r.top - gap - bh
    const cx = r.left + r.width / 2
    const x = Math.min(Math.max(16, cx - w / 2), Math.max(16, vw - 16 - w))
    root.dataset.place = under ? 'below' : 'above'
    root.style.setProperty('--arrow-x', `${Math.min(Math.max(20, cx - x), w - 20)}px`)
    root.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`
  }

  function render() {
    if (!running) return
    const v = resolveView()
    if (!running) return // the chapter ran off its end
    view = v
    if (!v || modalOpen()) { setHidden(true); return }
    const key = `${steps[idx].id}|${v.text}`
    if (key !== lastKey) {
      const newStep = !lastKey.startsWith(`${steps[idx].id}|`)
      lastKey = key
      fill(v)
      syncChrome(v)
      if (newStep) {
        seen.add(steps[idx].id)
        // Where to pick up if this page is reloaded mid-chapter.
        writeTour({ status: 'running', chapter, step: idx, at: Date.now() })
        bringIntoView(v.target)
      }
    } else {
      syncChrome(v)
    }
    place(v)
  }

  let raf = 0
  const schedule = () => {
    if (!running || raf) return
    raf = requestAnimationFrame(() => { raf = 0; render() })
  }

  function start(from: number) {
    running = true
    idx = Math.min(Math.max(0, from), Math.max(0, steps.length - 1))
    since = Date.now()
    view = null
    lastKey = ''
    done.clear()
    seen.clear()
    if (run.onStart) run.onStart()
    if (replay) replay.hidden = true
    writeTour({ status: 'running', chapter, step: idx, at: Date.now() })
    schedule()
  }

  function finish() {
    if (!running) return
    running = false
    view = null
    const hadFocus = root.contains(document.activeElement)
    setHidden(true)
    root.classList.remove('is-in')
    writeTour({ status: 'done', chapter, step: idx, at: Date.now() })
    if (replay) {
      replay.hidden = false
      if (hadFocus) replay.focus()
    }
  }

  // Same tab, and the next page's chapter picks the tour up on arrival.
  // Storage blocked: the page still opens, and simply has no tour.
  function handOff(replace: boolean) {
    if (!nextChapter) return finish()
    running = false
    view = null
    setHidden(true)
    writeTour({ status: 'running', chapter: nextChapter.id, step: 0, at: Date.now() })
    if (replace) window.location.replace(nextChapter.href)
    else window.location.assign(nextChapter.href)
  }

  function goNext() {
    const step = steps[idx]
    if (!step) return finish()
    if (view && isLast(view)) return nextChapter ? handOff(false) : finish()
    done.add(step.id)
    let j = idx + 1
    while (j < steps.length && !steps[j].ready()) j += 1
    if (j >= steps.length) return nextChapter ? handOff(false) : finish()
    setIdx(j)
    render()
  }

  // ── Wiring ────────────────────────────────────────────────────────────
  const sig = { signal: ac.signal }
  nextBtn.addEventListener('click', goNext, sig)
  skipBtn.addEventListener('click', finish, sig)
  altBtn.addEventListener('click', () => { if (action) action.run() }, sig)
  if (replay) {
    replay.addEventListener('click', () => {
      start(0)
      // Keyboard users land on the tour they asked for.
      requestAnimationFrame(() => requestAnimationFrame(() => { if (running && view) nextBtn.focus({ preventScroll: true }) }))
    }, sig)
  }

  // The real action: a press on the control the bubble points at. Capture
  // phase, so it is seen even if the page's own handler stops the event.
  document.addEventListener('click', (e) => {
    if (!running || !view) return
    const step = steps[idx]
    if (!step || !step.advancesOnClick) return
    if (!(e.target instanceof Node) || !view.target.contains(e.target)) return
    done.add(step.id)
    if (step.onAdvance) step.onAdvance()
    setIdx(idx + 1)
    schedule()
  }, { capture: true, signal: ac.signal })

  document.addEventListener('keydown', (e) => {
    if (!running || e.key !== 'Escape' || e.defaultPrevented || modalOpen()) return
    finish()
  }, sig)

  window.addEventListener('scroll', schedule, { capture: true, passive: true, signal: ac.signal })
  window.addEventListener('resize', schedule, sig)

  // The page shows, hides and relabels controls as the visitor goes: every
  // such change is a reason to look again. The tour's own moves are not.
  const mine = (n: Node) => root.contains(n) || ring.contains(n) || (!!replay && replay.contains(n))
  const mo = new MutationObserver((records) => {
    if (records.some((r) => !mine(r.target))) schedule()
  })
  mo.observe(run.observe || document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['style', 'hidden', 'disabled', 'class', 'data-state', 'aria-current', 'aria-modal'],
  })
  // A step that is waiting (its control still loading) looks again on its
  // own, so a page that settles without a DOM change is not missed.
  const beat = window.setInterval(() => { if (running && !view) schedule() }, 400)

  if (run.autoStart === false) {
    if (replay) replay.hidden = false
  } else {
    start(run.startAt || 0)
  }

  return () => {
    running = false
    ac.abort()
    mo.disconnect()
    window.clearInterval(beat)
    if (raf) cancelAnimationFrame(raf)
    root.remove()
    ring.remove()
    if (replay) replay.remove()
  }
}
