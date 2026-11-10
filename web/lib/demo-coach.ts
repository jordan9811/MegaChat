/**
 * The demo room's guided tour: a frosted speech bubble that points at one
 * control at a time ("Tap Send a Holler to record a 10-second clip"), with a
 * pulse ring on that control, a step count, Next and Skip.
 *
 * Demo room only: join-page.ts starts it when CONFIG.isDemo, and nowhere else.
 * It reads the page and never drives it: no click is made for the visitor, no
 * state of the join script is changed. Steps follow what the visitor actually
 * does: pressing the control a bubble points at advances it, opening the
 * recorder or calling in out of order jumps the tour to that step, and backing
 * out (Cancel, a dismissed sign-in) steps it back.
 *
 * Skip, Escape or finishing remembers the dismissal in localStorage; a "Show
 * me around" link in the room strip brings the tour back. Styles: join.css,
 * "Demo tour".
 */

type Feature = 'holler' | 'callin' | 'rewards';

type View = {
  target: HTMLElement;
  feature: Feature;
  text: string;
  // The tour's last word: Done only, no ring (the button now means Leave).
  final?: boolean;
};

type Resolution = View | 'wait' | 'next' | 'back';

type Step = {
  id: string;
  // Can Next land here right now?
  ready: () => boolean;
  // What to show, or wait (show nothing yet), or move on / step back.
  resolve: () => Resolution;
  // Pressing the control itself is the step done.
  advancesOnClick: boolean;
};

export type DemoCoachHooks = {
  // join-page.ts joinBtnState: idle | busy | awaiting-camera | go-live | going-live | live
  seatState: () => string;
  // join-page.ts letterState: idle | recording | preview | sending | sent
  letterState: () => string;
  maxSeconds: () => number;
  minSeconds: () => number;
  has: { rewards: boolean; holler: boolean; callin: boolean };
};

// The demo's play money, in the owner's words (2026-11-09). The earning and
// spending are built elsewhere; these are copy only.
const DEMO_EARN = '$1 a second, up to $10';
const DEMO_HOLLER_10S = '50¢';
const DEMO_CALLIN = '$0.10 a second';

const STORE_KEY = 'holler.demoTour';
const LABEL: Record<Feature, string> = { holler: 'Holler', callin: 'Call in', rewards: 'Watch to earn' };

function remembered(): boolean {
  try { return localStorage.getItem(STORE_KEY) === 'done'; } catch { return false; }
}

function remember() {
  try { localStorage.setItem(STORE_KEY, 'done'); } catch { /* storage optional */ }
}

function shown(el: HTMLElement | null): el is HTMLElement {
  return !!el && el.isConnected && !el.hidden && el.getClientRects().length > 0;
}

function stillPlease(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

let current: (() => void) | null = null;

/** Start the tour (or the replay link, if it was dismissed). Returns cleanup. */
export function startDemoCoach(hooks: DemoCoachHooks): () => void {
  // One tour per page: a re-run of the page's init replaces the old one.
  if (current) current();
  const stop = createCoach(hooks);
  current = stop;
  return () => {
    stop();
    if (current === stop) current = null;
  };
}

function createCoach(h: DemoCoachHooks): () => void {
  const ac = new AbortController();
  const $ = (id: string) => document.getElementById(id) as HTMLElement | null;

  let startedAt = Date.now();
  let recordPendingUntil = 0;

  const rewards: Step = {
    id: 'rewards',
    advancesOnClick: true,
    ready: () => shown($('rewardsLine')),
    resolve: () => {
      const line = $('rewardsLine');
      // The line fills once the rewards socket answers: give it a moment.
      if (!shown(line)) return Date.now() - startedAt < 3000 ? 'wait' : 'next';
      const earning = line.dataset.state === 'earning' || line.dataset.state === 'maxed';
      return {
        target: line,
        feature: 'rewards',
        text: earning
          ? `You're earning demo money just by watching: ${DEMO_EARN}.`
          : `Watch to earn demo money: ${DEMO_EARN}. Spend it on Hollers and Call ins.`,
      };
    },
  };

  const holler: Step = {
    id: 'holler',
    advancesOnClick: true,
    ready: () => shown($('letterBtn')),
    resolve: () => {
      const btn = $('letterBtn') as HTMLButtonElement | null;
      if (!shown(btn) || btn.disabled) return 'next';
      return {
        target: btn,
        feature: 'holler',
        text: `Tap Send a Holler to record a ${h.maxSeconds()}-second clip. 10 seconds costs ${DEMO_HOLLER_10S} of demo money.`,
      };
    },
  };

  const record: Step = {
    id: 'record',
    advancesOnClick: false,
    ready: () => shown($('letterStage')) && h.letterState() !== 'sent',
    resolve: () => {
      const state = h.letterState();
      // The camera prompt is up: the recorder has not opened yet.
      if (!shown($('letterStage'))) return Date.now() < recordPendingUntil ? 'wait' : 'back';
      if (state === 'sent') return 'next';
      if (state === 'sending') return 'wait';
      const rec = $('letterRecordBtn');
      const send = $('letterSendBtn');
      const redo = $('letterRedoBtn');
      if (state === 'recording' && shown(rec)) {
        return { target: rec, feature: 'holler', text: `Recording. Tap Stop when you're done, or it stops at ${h.maxSeconds()}s.` };
      }
      if (shown(send)) return { target: send, feature: 'holler', text: 'Like the take? Tap Send and it plays once on the stream.' };
      if (shown(redo)) return { target: redo, feature: 'holler', text: `Too short. Tap Re-record and go for at least ${h.minSeconds()} seconds.` };
      if (shown(rec)) return { target: rec, feature: 'holler', text: `Tap Record and say hi. You get up to ${h.maxSeconds()} seconds.` };
      return 'wait'; // "Discard this take?" is asking
    },
  };

  const callin: Step = {
    id: 'callin',
    advancesOnClick: true,
    ready: () => shown($('joinBtn')) && h.seatState() === 'idle',
    resolve: () => {
      const btn = $('joinBtn') as HTMLButtonElement | null;
      if (!shown(btn) || btn.disabled || h.seatState() !== 'idle') return 'next';
      return {
        target: btn,
        feature: 'callin',
        text: `Tap Call in to take a seat on the stream: ${DEMO_CALLIN} of demo money. Your camera stays private until Go Live.`,
      };
    },
  };

  const golive: Step = {
    id: 'golive',
    advancesOnClick: false,
    ready: () => shown($('joinBtn')) && h.seatState() !== 'idle',
    resolve: () => {
      const btn = $('joinBtn');
      const s = h.seatState();
      if (s === 'idle') return 'back';
      if (!shown(btn)) return 'wait';
      if (s === 'go-live') return { target: btn, feature: 'callin', text: "The seat's yours. Tap Go Live to put your camera on the stream." };
      if (s === 'going-live' || s === 'live') {
        return { target: btn, feature: 'callin', text: "You're on the stream. That's the tour: earn, Holler, Call in.", final: true };
      }
      return { target: btn, feature: 'callin', text: 'Getting your seat ready. Go Live lights up right here.' };
    },
  };

  const steps: Step[] = [
    ...(h.has.rewards ? [rewards] : []),
    ...(h.has.holler ? [holler, record] : []),
    ...(h.has.callin ? [callin, golive] : []),
  ];

  // ── Markup ────────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.className = 'demo-coach is-hidden';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Demo tour');
  root.innerHTML = `
    <div class="demo-coach-fog" aria-hidden="true"></div>
    <div class="demo-coach-bubble">
      <span class="demo-coach-arrow" aria-hidden="true"></span>
      <div class="demo-coach-head">
        <span class="demo-coach-kicker"><i aria-hidden="true"></i><span data-coach="label"></span></span>
        <span class="demo-coach-count" data-coach="count"></span>
      </div>
      <p class="demo-coach-text" data-coach="text" aria-live="polite"></p>
      <div class="demo-coach-actions">
        <button type="button" class="demo-coach-skip" data-coach="skip">Skip tour</button>
        <button type="button" class="demo-coach-next" data-coach="next">Next</button>
      </div>
    </div>`;
  const ring = document.createElement('div');
  ring.className = 'demo-coach-ring is-hidden';
  ring.setAttribute('aria-hidden', 'true');
  const part = (name: string) => root.querySelector(`[data-coach="${name}"]`) as HTMLElement;
  const labelEl = part('label');
  const countEl = part('count');
  const textEl = part('text');
  const skipBtn = part('skip') as HTMLButtonElement;
  const nextBtn = part('next') as HTMLButtonElement;
  const bubble = root.querySelector('.demo-coach-bubble') as HTMLElement;

  const replay = document.createElement('button');
  replay.type = 'button';
  replay.className = 'demo-coach-replay';
  replay.textContent = 'Show me around';
  replay.hidden = true;

  document.body.append(ring, root);
  const strip = document.querySelector('.join-room-strip');
  if (strip) strip.append(replay);

  // ── State ─────────────────────────────────────────────────────────────
  let running = false;
  let idx = 0;
  let view: View | null = null;
  let lastKey = '';
  const done = new Set<string>();

  // Out-of-order actions: the recorder just opened, or a seat just got on its
  // way. Only the moment it happens moves the tour: with both under way, a
  // standing rule would hand the bubble back and forth on every frame.
  let wasRec = false;
  let wasLive = false;
  function contextJump() {
    const iRec = steps.indexOf(record);
    const iLive = steps.indexOf(golive);
    const rec = iRec >= 0 && record.ready();
    const live = iLive >= 0 && golive.ready();
    if (rec && !wasRec && !done.has('record')) idx = iRec;
    else if (live && !wasLive && !done.has('golive')) idx = iLive;
    wasRec = rec;
    wasLive = live;
  }

  function resolveView(): View | null {
    contextJump();
    for (let guard = 0; guard < steps.length * 3; guard += 1) {
      const step = steps[idx];
      if (!step) { finish(); return null; }
      const r = step.resolve();
      if (r === 'wait') return null;
      if (r === 'next') { done.add(step.id); idx += 1; continue; }
      if (r === 'back') { idx = Math.max(0, idx - 1); continue; }
      return r;
    }
    return null;
  }

  function headerBottom(): number {
    const hdr = document.querySelector('.mcj-product-header');
    if (!hdr) return 0;
    const pos = getComputedStyle(hdr).position;
    return pos === 'sticky' || pos === 'fixed' ? Math.max(0, hdr.getBoundingClientRect().bottom) : 0;
  }

  function modalOpen(): boolean {
    return !!document.querySelector('[aria-modal="true"]');
  }

  function setHidden(on: boolean) {
    root.classList.toggle('is-hidden', on);
    ring.classList.toggle('is-hidden', on || !!view?.final);
  }

  function fill(v: View) {
    root.dataset.feature = v.feature;
    ring.dataset.feature = v.feature;
    labelEl.textContent = LABEL[v.feature];
    countEl.textContent = `${idx + 1}/${steps.length}`;
    textEl.textContent = v.text;
    const more = !v.final && steps.slice(idx + 1).some((s) => s.ready());
    nextBtn.textContent = more ? 'Next' : 'Done';
    skipBtn.hidden = !!v.final;
    // Replay the entrance for each new step.
    root.classList.remove('is-in');
    void root.offsetWidth;
    root.classList.add('is-in');
  }

  function bringIntoView(target: HTMLElement) {
    const r = target.getBoundingClientRect();
    if (r.top >= headerBottom() + 8 && r.bottom <= window.innerHeight - 8) return;
    target.scrollIntoView({ block: 'center', behavior: stillPlease() ? 'auto' : 'smooth' });
  }

  function place(v: View) {
    const r = v.target.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const top0 = headerBottom() + 8;
    // Scrolled out of sight: the bubble goes with it rather than float alone.
    const away = r.bottom < top0 || r.top > vh - 8 || r.right < 0 || r.left > vw;
    setHidden(away);
    if (away) return;

    // The ring: 5px clear of the control, never past the viewport's edge.
    const pad = 5;
    const left = Math.max(2, r.left - pad);
    const right = Math.min(vw - 2, r.right + pad);
    const rw = Math.max(0, right - left);
    const rh = r.height + pad * 2;
    ring.style.width = `${rw}px`;
    ring.style.height = `${rh}px`;
    ring.style.transform = `translate3d(${left}px, ${r.top - pad}px, 0)`;
    ring.style.setProperty('--coach-sx', String((rw + 14) / Math.max(1, rw)));
    ring.style.setProperty('--coach-sy', String((rh + 14) / Math.max(1, rh)));
    ring.style.borderRadius = getComputedStyle(v.target).borderRadius || '0';

    // The bubble: below the control when it fits, else above, else the
    // roomier side. Never over the control; never past the 16px gutter.
    const w = Math.min(320, vw - 32);
    root.style.width = `${w}px`;
    const bh = bubble.offsetHeight;
    const gap = 16;
    const below = vh - r.bottom - gap - 8;
    const above = r.top - gap - top0;
    const under = bh <= below || (bh > above && below >= above);
    const y = under ? r.bottom + gap : r.top - gap - bh;
    const cx = r.left + r.width / 2;
    const x = Math.min(Math.max(16, cx - w / 2), Math.max(16, vw - 16 - w));
    root.dataset.place = under ? 'below' : 'above';
    root.style.setProperty('--arrow-x', `${Math.min(Math.max(20, cx - x), w - 20)}px`);
    root.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  function render() {
    if (!running) return;
    const v = resolveView();
    if (!running) return; // the tour ran off its end
    view = v;
    if (!v || modalOpen()) { setHidden(true); return; }
    const key = `${steps[idx].id}|${v.text}`;
    if (key !== lastKey) {
      const newStep = !lastKey.startsWith(`${steps[idx].id}|`);
      lastKey = key;
      fill(v);
      if (newStep) bringIntoView(v.target);
    }
    place(v);
  }

  let raf = 0;
  const schedule = () => {
    if (!running || raf) return;
    raf = requestAnimationFrame(() => { raf = 0; render(); });
  };

  function start() {
    running = true;
    idx = 0;
    view = null;
    lastKey = '';
    done.clear();
    recordPendingUntil = 0;
    wasRec = false;
    wasLive = false;
    startedAt = Date.now();
    replay.hidden = true;
    schedule();
    // The rewards line may take a moment to fill: look again once it has.
    setTimeout(schedule, 3100);
  }

  function finish() {
    if (!running) return;
    running = false;
    view = null;
    const hadFocus = root.contains(document.activeElement);
    setHidden(true);
    root.classList.remove('is-in');
    remember();
    replay.hidden = false;
    if (hadFocus) replay.focus();
  }

  function goNext() {
    const step = steps[idx];
    if (!step || view?.final) return finish();
    done.add(step.id);
    let j = idx + 1;
    while (j < steps.length && !steps[j].ready()) j += 1;
    if (j >= steps.length) return finish();
    idx = j;
    render();
  }

  // ── Wiring ────────────────────────────────────────────────────────────
  const sig = { signal: ac.signal };
  nextBtn.addEventListener('click', goNext, sig);
  skipBtn.addEventListener('click', finish, sig);
  replay.addEventListener('click', () => {
    start();
    // Keyboard users land on the tour they asked for.
    requestAnimationFrame(() => requestAnimationFrame(() => { if (running && view) nextBtn.focus({ preventScroll: true }); }));
  }, sig);

  // The real action: a press on the control the bubble points at. Capture
  // phase, so it is seen even if the page's own handler stops the event.
  document.addEventListener('click', (e) => {
    if (!running || !view) return;
    const step = steps[idx];
    if (!step || !step.advancesOnClick) return;
    if (!(e.target instanceof Node) || !view.target.contains(e.target)) return;
    done.add(step.id);
    if (step === holler) recordPendingUntil = Date.now() + 20_000;
    idx += 1;
    schedule();
  }, { capture: true, signal: ac.signal });

  document.addEventListener('keydown', (e) => {
    if (!running || e.key !== 'Escape' || e.defaultPrevented || modalOpen()) return;
    finish();
  }, sig);

  window.addEventListener('scroll', schedule, { capture: true, passive: true, signal: ac.signal });
  window.addEventListener('resize', schedule, sig);

  // The page's script shows, hides and relabels controls as the visitor goes:
  // every such change is a reason to look again.
  const shell = document.querySelector('.join-shell');
  const mo = new MutationObserver(schedule);
  if (shell) {
    mo.observe(shell, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['style', 'hidden', 'disabled', 'class', 'data-state'],
    });
  }

  if (remembered()) replay.hidden = false;
  else start();

  return () => {
    running = false;
    ac.abort();
    mo.disconnect();
    if (raf) cancelAnimationFrame(raf);
    root.remove();
    ring.remove();
    replay.remove();
  };
}
