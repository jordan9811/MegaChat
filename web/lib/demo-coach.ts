/**
 * The site tour's first chapter, in the demo room: a frosted speech bubble
 * that points at one control at a time ("Tap Send a Holler to record a
 * clip"), with a pulse ring on that control, a count, Next and Skip.
 *
 * Demo room only: join-page.ts starts it when CONFIG.isDemo, and nowhere else.
 * It reads the page and never drives it: no click is made for the visitor, no
 * state of the join script is changed. Steps follow what the visitor actually
 * does: pressing the control a bubble points at advances it, opening the
 * recorder or calling in out of order jumps the tour to that step, and backing
 * out (Cancel, a dismissed sign-in) steps it back.
 *
 * The bubble, ring and wiring are the shared runner (lib/site-tour.ts). The
 * demo's last bubble moves the tour on to the Rooms board, and the rest of
 * the site (lib/site-tour-chapters.ts). Skip, Escape or finishing ends the
 * whole tour; a "Show me around" link in the room strip starts it over from
 * here. Styles: globals.css, "Site tour".
 */

import { runTour, shown, type TourStep as Step } from './site-tour';
import { tourDismissed } from './site-tour-state';

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
const DEMO_HOLLER = '$0.05 a second';
const DEMO_CALLIN = '$0.10 a second';

/** Start the demo chapter (or the replay link, if the tour was dismissed). Returns cleanup. */
export function startDemoCoach(hooks: DemoCoachHooks): () => void {
  return createCoach(hooks);
}

function createCoach(h: DemoCoachHooks): () => void {
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
    onAdvance: () => { recordPendingUntil = Date.now() + 20_000; },
    ready: () => shown($('letterBtn')),
    resolve: () => {
      const btn = $('letterBtn') as HTMLButtonElement | null;
      if (!shown(btn) || btn.disabled) return 'next';
      return {
        target: btn,
        feature: 'holler',
        text: `Tap Send a Holler to record a clip. It's ${DEMO_HOLLER} of demo money, so you pay only for the seconds you record.`,
      };
    },
  };

  const record: Step = {
    id: 'record',
    // Counted in parts (earn, Holler, Call in): Record belongs to the Holler
    // part and Go Live to Call in, so skipping a sub-step never skips a number.
    part: 'holler',
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
      if (shown(send)) return { target: send, feature: 'holler', text: 'Like the take? Send shows its price for the seconds you recorded. Tap it and it plays once on the stream.' };
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
    part: 'callin',
    advancesOnClick: false,
    ready: () => shown($('joinBtn')) && h.seatState() !== 'idle',
    resolve: () => {
      const btn = $('joinBtn');
      const s = h.seatState();
      if (s === 'idle') return 'back';
      if (!shown(btn)) return 'wait';
      if (s === 'go-live') return { target: btn, feature: 'callin', text: "The seat's yours. Tap Go Live to put your camera on the stream." };
      if (s === 'going-live' || s === 'live') {
        return { target: btn, feature: 'callin', text: "You're on the stream. That's the demo: earn, Holler, Call in.", final: true };
      }
      return { target: btn, feature: 'callin', text: 'Getting your seat ready. Go Live lights up right here.' };
    },
  };

  const steps: Step[] = [
    ...(h.has.rewards ? [rewards] : []),
    ...(h.has.holler ? [holler, record] : []),
    ...(h.has.callin ? [callin, golive] : []),
  ];

  // Out-of-order actions: the recorder just opened, or a seat just got on its
  // way. Only the moment it happens moves the tour: with both under way, a
  // standing rule would hand the bubble back and forth on every frame.
  let wasRec = false;
  let wasLive = false;
  function contextJump(_idx: number, done: Set<string>): number | null {
    const iRec = steps.indexOf(record);
    const iLive = steps.indexOf(golive);
    const rec = iRec >= 0 && record.ready();
    const live = iLive >= 0 && golive.ready();
    let to: number | null = null;
    if (rec && !wasRec && !done.has('record')) to = iRec;
    else if (live && !wasLive && !done.has('golive')) to = iLive;
    wasRec = rec;
    wasLive = live;
    return to;
  }

  return runTour({
    chapter: 'demo',
    steps,
    autoStart: !tourDismissed(),
    replayHost: document.querySelector('.join-room-strip'),
    observe: document.querySelector('.join-shell'),
    countEverything: true,
    scroll: 'center',
    jump: contextJump,
    onStart: () => {
      startedAt = Date.now();
      recordPendingUntil = 0;
      wasRec = false;
      wasLive = false;
    },
  });
}
