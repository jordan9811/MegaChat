'use client'

// THREE WAYS IN — one stage, three situations. Each way in swaps the picture
// for the stream it belongs on and lands its own thing on it: a Holler tile
// airing on a gaming stream, a live seat on a talk show, and the fan on the
// couch backing that same show. The fan is "you" in all three (the couch
// frame, cropped). Cycles on its own until someone touches it; reduced motion
// never cycles.
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import './ways-in.css'

type Way = 'holler' | 'callin' | 'bounty'

const WAYS: Record<Way, { verb: string; line: string; readout: string; cta: string; href: string; label: string }> = {
  holler: {
    verb: 'Holler',
    line: 'Record a clip. It plays on their stream.',
    readout: 'REC 0:07 · $0.007',
    cta: 'Find a streamer',
    href: '/app',
    label: 'A gaming stream with your recorded Holler playing on it',
  },
  callin: {
    verb: 'Call in',
    line: 'Take a live seat, face to face.',
    readout: '00:00:43 · $0.043',
    cta: 'Browse rooms',
    href: '/app',
    label: 'A talk show with you live in a Call in seat',
  },
  bounty: {
    verb: 'Pledge',
    line: 'Back a streamer before they have a room.',
    readout: '$200 · @latedesk',
    cta: 'Browse bounties',
    href: '/bounty',
    label: 'A fan on the couch backing the streamer on screen',
  },
}
const ORDER: Way[] = ['holler', 'callin', 'bounty']
const CYCLE_MS = 3600

export function WaysIn() {
  const [way, setWay] = useState<Way>('holler')
  const touched = useRef(false)

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const timer = setInterval(() => {
      if (touched.current) return
      setWay((w) => ORDER[(ORDER.indexOf(w) + 1) % ORDER.length])
    }, CYCLE_MS)
    return () => clearInterval(timer)
  }, [])

  const pick = (w: Way) => { touched.current = true; setWay(w) }
  const cur = WAYS[way]

  return (
    <section className="mcl-ways" aria-labelledby="mcl-ways-title">
      <h2 id="mcl-ways-title" className="mcl-ways-title">Three ways on the show</h2>
      <div className="mcl-ways-wrap">
        <div className="mcl-ways-stage dark" data-way={way} role="img" aria-label={cur.label}>
          {ORDER.map((w) => <span key={w} className="mcl-ways-shot" data-shot={w} aria-hidden="true" />)}
          <span className="mcl-ways-live" aria-hidden="true">
            <i />
            {way === 'holler' ? 'LIVE · pixelmaeve' : way === 'callin' ? 'LIVE · nordtalk' : 'WATCHING · latedesk'}
          </span>
          <div className="mcl-ways-ov mcl-ways-ov-holler" aria-hidden="true">
            <span className="t">0:07</span>
            <span className="tag">HOLLER · you</span>
          </div>
          <div className="mcl-ways-ov mcl-ways-ov-callin" aria-hidden="true">
            <div className="seat"><b>CALL IN · you</b></div>
            <div className="seat open">+</div>
            <span className="meter">00:00:43 · $0.043</span>
          </div>
          <div className="mcl-ways-ov mcl-ways-ov-bounty" aria-hidden="true">
            <span className="amt">$200</span>
            <span className="who"><strong>You pledged @latedesk</strong><small>Paid out when they go live and play it</small></span>
          </div>
        </div>
        <div className="mcl-ways-modes" role="group" aria-label="Ways in">
          {ORDER.map((w) => (
            <button key={w} type="button" className="mcl-ways-mode" data-k={w} aria-pressed={way === w} onClick={() => pick(w)}>
              <span className="bar" aria-hidden="true" />
              <strong>{WAYS[w].verb}</strong>
              <small>{WAYS[w].line}</small>
            </button>
          ))}
          <div className="mcl-ways-foot">
            <span className="mcl-ways-readout">{cur.readout}</span>
            <Link href={cur.href} className="mcl-ways-cta" data-k={way}>{cur.cta}<ArrowRight size={15} aria-hidden="true" /></Link>
          </div>
        </div>
      </div>
    </section>
  )
}
