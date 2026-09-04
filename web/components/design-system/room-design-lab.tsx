'use client'

import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleDollarSign,
  Gift,
  LockKeyhole,
  MessageSquareText,
  Minus,
  Plus,
  Radio,
  Settings2,
  ShieldCheck,
  Users,
  Video,
} from 'lucide-react'

type DirectionId = 'signal' | 'broadcast' | 'tape'
type AdvancedTab = 'megachats' | 'open-mic' | 'drops' | 'access' | 'money' | 'stream'

const DIRECTIONS: Array<{
  id: DirectionId
  index: string
  name: string
  label: string
  summary: string
}> = [
  {
    id: 'signal',
    index: '01',
    name: 'Signal Deck',
    label: 'Balanced',
    summary: 'Calm control room. Powder-blue navigation, yellow money, green live state.',
  },
  {
    id: 'broadcast',
    index: '02',
    name: 'Broadcast OS',
    label: 'Selected',
    summary: 'Deeper screen-light layers and a stronger live-production hierarchy.',
  },
  {
    id: 'tape',
    index: '03',
    name: 'Game Tape',
    label: 'More arcade',
    summary: 'A light equipment panel inside a dark broadcast chassis. Fast and graphic.',
  },
]

const ADVANCED_TABS: Array<{ id: AdvancedTab; label: string; icon: LucideIcon }> = [
  { id: 'megachats', label: 'MegaChats', icon: MessageSquareText },
  { id: 'open-mic', label: 'Open mic', icon: Video },
  { id: 'drops', label: 'Drops', icon: Gift },
  { id: 'access', label: 'Who gets in', icon: Users },
  { id: 'money', label: 'Money', icon: CircleDollarSign },
  { id: 'stream', label: 'Stream', icon: Radio },
]

const CLIP_LENGTHS = [5, 10, 15, 20, 30]

const GATE_RESULTS = [
  { id: 'signal', name: 'Signal Deck', c1: 7.8, c2: 8.7, c3: 9, c4: 9, c5: 8, minimum: 7.8, average: 8.5 },
  { id: 'broadcast', name: 'Broadcast OS', c1: 8.5, c2: 8, c3: 8, c4: 8, c5: 5, minimum: 5, average: 7.5 },
  { id: 'tape', name: 'Game Tape', c1: 8, c2: 7.6, c3: 8, c4: 7, c5: 7, minimum: 7, average: 7.5 },
] as const

function trimRate(value: number) {
  return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div className="lab-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function RateStepper({ rate, setRate }: { rate: string; setRate: (value: string) => void }) {
  const adjust = (amount: number) => {
    const current = Number.parseFloat(rate) || 0.001
    setRate(trimRate(Math.max(0.0005, current + amount)))
  }

  return (
    <div className="lab-rate-control">
      <button type="button" aria-label="Lower MegaChat rate" onClick={() => adjust(-0.0005)}>
        <Minus size={15} strokeWidth={2.5} />
      </button>
      <label className="lab-rate-input">
        <span>$</span>
        <input
          aria-label="MegaChat rate"
          inputMode="decimal"
          value={rate}
          onChange={(event) => setRate(event.target.value.replace(/[^0-9.]/g, ''))}
        />
        <small>/s</small>
      </label>
      <button type="button" aria-label="Raise MegaChat rate" onClick={() => adjust(0.0005)}>
        <Plus size={15} strokeWidth={2.5} />
      </button>
    </div>
  )
}

function Module({
  icon: Icon,
  title,
  description,
  enabled,
  onToggle,
  accent,
  children,
}: {
  icon: LucideIcon
  title: string
  description: string
  enabled: boolean
  onToggle: () => void
  accent: 'primary' | 'live' | 'money'
  children?: React.ReactNode
}) {
  return (
    <section className="lab-module" data-enabled={enabled} data-accent={accent}>
      <button type="button" className="lab-module-head" aria-pressed={enabled} onClick={onToggle}>
        <span className="lab-module-icon" aria-hidden="true">
          <Icon size={18} strokeWidth={2} />
        </span>
        <span className="lab-module-copy">
          <strong>{title}</strong>
          <span>{description}</span>
        </span>
        <span className="lab-switch" aria-hidden="true">
          <span>{enabled ? <Check size={13} strokeWidth={3} /> : null}</span>
          {enabled ? 'On' : 'Off'}
        </span>
      </button>
      {enabled && children ? <div className="lab-module-body">{children}</div> : null}
    </section>
  )
}

export function RoomDesignLab() {
  const [direction, setDirection] = useState<DirectionId>('broadcast')
  const [paid, setPaid] = useState(true)
  const [megachats, setMegachats] = useState(true)
  const [openMic, setOpenMic] = useState(false)
  const [drops, setDrops] = useState(false)
  const [rate, setRate] = useState('0.001')
  const [clipLength, setClipLength] = useState(10)
  const [screening, setScreening] = useState<'ai' | 'approve'>('ai')
  const [advancedTab, setAdvancedTab] = useState<AdvancedTab>('megachats')
  const active = DIRECTIONS.find((item) => item.id === direction) ?? DIRECTIONS[0]
  const clipTotal = (Number.parseFloat(rate || '0') * clipLength).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')

  return (
    <div className="lab" data-direction={direction}>
      <header className="lab-toolbar">
        <div className="lab-toolbar-brand">
          <span>MEGACHAT</span>
          <small>UI direction lab</small>
        </div>
        <nav className="lab-directions" aria-label="Design directions">
          {DIRECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={direction === item.id ? 'page' : undefined}
              onClick={() => setDirection(item.id)}
            >
              <span>{item.index}</span>
              {item.name}
            </button>
          ))}
        </nav>
        <a href="/dashboard/design-system/pages" className="lab-local-status"><i /> Page mocks <ArrowRight size={13} /></a>
      </header>

      <div className="lab-frame">
        <section className="lab-intro">
          <div>
            <span className="lab-kicker">Direction {active.index} / {active.label}</span>
            <h1>{active.name}</h1>
          </div>
          <p>{active.summary}</p>
          <div className="lab-swatches" aria-label="Direction palette">
            <span data-swatch="primary">Action</span>
            <span data-swatch="money">Money</span>
            <span data-swatch="live">Live</span>
            <span data-swatch="danger">Stop</span>
          </div>
        </section>

        <section className="room-mock" aria-label={`${active.name} Create Room mockup`}>
          <header className="room-mock-header">
            <a href="/app" className="room-brand">MEGACHAT</a>
            <span className="room-divider" />
            <span className="room-page-title">New room</span>
            <span className="room-progress"><b>01</b> Set the room <i /> <b>02</b> Go live</span>
            <button type="button" className="lab-button lab-button-quiet">Sign in</button>
          </header>

          <div className="room-identity">
            <label className="identity-name">
              <span>Room name</span>
              <input defaultValue="Jordan's room" aria-label="Room name" />
            </label>
            <label className="identity-link">
              <span>Your room link</span>
              <span className="identity-url">megachat.fun/<input defaultValue="jordandotfun" aria-label="Room handle" /></span>
            </label>
            <div className="identity-charging">
              <span>Charging</span>
              <Segmented
                label="Free or paid"
                value={paid ? 'paid' : 'free'}
                onChange={(value) => setPaid(value === 'paid')}
                options={[{ value: 'paid', label: 'Paid' }, { value: 'free', label: 'Free' }]}
              />
            </div>
          </div>

          <div className="room-workspace">
            <div className="room-form">
              <section className="room-section">
                <div className="room-section-title">
                  <span>01</span>
                  <div><h2>What runs in your room</h2><p>Start with MegaChats. Add live seats or rewards only when you need them.</p></div>
                </div>

                <div className="lab-modules">
                  <Module
                    icon={MessageSquareText}
                    title="MegaChats"
                    description="Recorded clips that play on the broadcast"
                    enabled={megachats}
                    onToggle={() => setMegachats((value) => !value)}
                    accent="primary"
                  >
                    <div className="module-fields">
                      <div className="lab-field field-rate">
                        <span className="lab-label">Rate per second</span>
                        {paid ? <RateStepper rate={rate} setRate={setRate} /> : <strong className="free-readout">Free</strong>}
                        <small>{clipLength}s clip = ${paid ? clipTotal || '0' : '0'}</small>
                      </div>
                      <div className="lab-field field-screening">
                        <span className="lab-label">Who screens clips</span>
                        <Segmented
                          label="Who screens clips"
                          value={screening}
                          onChange={setScreening}
                          options={[{ value: 'ai', label: 'AI only' }, { value: 'approve', label: 'AI, then me' }]}
                        />
                        <small>{screening === 'ai' ? 'Airs when the filter clears' : 'You approve every clip'}</small>
                      </div>
                      <div className="lab-field field-length">
                        <span className="lab-label">Longest clip</span>
                        <Segmented
                          label="Longest clip"
                          value={clipLength}
                          onChange={setClipLength}
                          options={CLIP_LENGTHS.map((value) => ({ value, label: `${value}s` }))}
                        />
                      </div>
                    </div>
                  </Module>

                  <Module
                    icon={Video}
                    title="Open mic"
                    description="Viewers take live camera seats beside you"
                    enabled={openMic}
                    onToggle={() => setOpenMic((value) => !value)}
                    accent="live"
                  >
                    <div className="module-compact-copy">Set the seat rate and seat count under Advanced settings.</div>
                  </Module>

                  <Module
                    icon={Gift}
                    title="Drops & rewards"
                    description="Pay viewers to watch or give MegaChat credit"
                    enabled={drops}
                    onToggle={() => setDrops((value) => !value)}
                    accent="money"
                  >
                    <div className="module-compact-copy">Choose the reward, interval, and budget under Advanced settings.</div>
                  </Module>
                </div>
              </section>

              <section className="room-section room-advanced">
                <div className="room-section-title">
                  <span>02</span>
                  <div><h2>Advanced settings</h2><p>Rates, screening, access, money, and stream behavior.</p></div>
                </div>
                <div className="advanced-shell">
                  <nav className="advanced-nav" aria-label="Advanced settings groups">
                    {ADVANCED_TABS.map(({ id, label, icon: Icon }) => (
                      <button
                        key={id}
                        type="button"
                        aria-current={advancedTab === id ? 'page' : undefined}
                        onClick={() => setAdvancedTab(id)}
                      >
                        <Icon size={16} strokeWidth={2} />
                        <span>{label}</span>
                        <ChevronRight size={14} />
                      </button>
                    ))}
                  </nav>
                  <div className="advanced-panel">
                    <div className="advanced-panel-head">
                      <div><span>Advanced / {ADVANCED_TABS.find((tab) => tab.id === advancedTab)?.label}</span><h3>{advancedTab === 'megachats' ? 'Clip controls' : 'Room controls'}</h3></div>
                      <Settings2 size={20} strokeWidth={1.8} />
                    </div>
                    <div className="advanced-grid">
                      <label className="lab-field">
                        <span className="lab-label">AI strictness</span>
                        <select defaultValue="strict"><option value="strict">Strict</option><option value="clear">Clear violations only</option></select>
                      </label>
                      <label className="lab-field">
                        <span className="lab-label">Rejected clips</span>
                        <select defaultValue="refund"><option value="refund">Refund automatically</option><option value="keep">No refund</option></select>
                      </label>
                      <div className="lab-field fixed-setting">
                        <span className="lab-label">Shortest clip</span>
                        <strong>3 seconds</strong>
                        <small>Verifier sampling floor</small>
                      </div>
                      <label className="lab-check-row">
                        <input type="checkbox" defaultChecked />
                        <span><strong>Show price before recording</strong><small>Viewers see the full cost up front.</small></span>
                      </label>
                    </div>
                  </div>
                </div>
              </section>

              <footer className="room-submit">
                <label className="save-defaults">
                  <input type="checkbox" />
                  <span><strong>Save as my defaults</strong><small>Use this setup for the next room.</small></span>
                </label>
                <label className="password-field">
                  <span>Room password</span>
                  <span><LockKeyhole size={15} /><input type="password" placeholder="At least 4 characters" aria-label="Room password" /></span>
                </label>
                <button type="button" className="lab-button lab-button-primary">Create room <ChevronRight size={17} /></button>
              </footer>
            </div>

            <aside className="room-preview">
              <div className="preview-head"><div><span>Live preview</span><h2>What viewers see</h2></div><span className="preview-live"><i /> On air</span></div>
              <div className="preview-stage">
                <span className="preview-stage-rate">${paid ? rate || '0' : '0'}/s</span>
                <div className="preview-signal"><i /><i /><i /><i /></div>
                <div className="preview-card">
                  <small>Your room</small>
                  <h3>Jordan's room</h3>
                  <p>{megachats ? 'MegaChats open' : 'MegaChats closed'}{openMic ? ' / 3 camera seats' : ''}</p>
                  <button type="button">Send a MegaChat <ChevronRight size={15} /></button>
                </div>
              </div>
              <div className="preview-ledger">
                <div><span>A MegaChat</span><strong>${paid ? rate || '0' : '0'}/s</strong></div>
                <div><span>10 second clip</span><strong>${paid ? ((Number.parseFloat(rate || '0') || 0) * 10).toFixed(2) : '0'}</strong></div>
                <div><span>Open mic</span><strong data-off={!openMic}>{openMic ? '3 seats' : 'Off'}</strong></div>
                <div><span>Spend limit</span><strong>$2 max</strong></div>
              </div>
              <div className="preview-note"><ShieldCheck size={18} /><span><strong>Real configuration</strong>Only the stage art is illustrative.</span></div>
            </aside>
          </div>
        </section>

        <section className="component-sheet">
          <header><span className="lab-kicker">Canonical components</span><h2>One visual rule per action</h2><p>The same controls carry every page. No page-specific button shapes.</p></header>
          <div className="component-grid">
            <article><span className="component-label">Actions</span><button className="lab-button lab-button-primary">Primary action <ChevronRight size={16} /></button><button className="lab-button lab-button-secondary">Secondary action</button><button className="lab-button lab-button-danger">Destructive action</button></article>
            <article><span className="component-label">Fields</span><label className="lab-field"><span className="lab-label">Room name</span><input defaultValue="Jordan's room" /></label><RateStepper rate={rate} setRate={setRate} /></article>
            <article><span className="component-label">Status</span><div className="status-stack"><span className="status-tag status-live"><i />On air</span><span className="status-tag status-money">$12.40 running</span><span className="status-tag status-waiting">Waiting for camera</span></div></article>
            <article><span className="component-label">Bounty split</span><div className="bounty-total"><strong>$200</strong><small>on this name</small></div><div className="bounty-track"><span /><i /></div><div className="bounty-legend"><span><i />$100 locked</span><span><i />$100 contested</span></div></article>
          </div>
        </section>

        <section className="results-sheet">
          <header>
            <div><span className="lab-kicker">Initial blind review</span><h2>Direction results</h2></div>
            <p>Five independent cohort scores, before the final corrections. Scores are evidence, not the design decision.</p>
            <span className="selected-direction">Selected: Broadcast OS</span>
          </header>
          <div className="results-table-wrap">
            <table>
              <thead><tr><th>Direction</th><th>C1</th><th>C2</th><th>C3</th><th>C4</th><th>C5</th><th>Minimum</th><th>Average</th></tr></thead>
              <tbody>
                {GATE_RESULTS.map((row) => (
                  <tr key={row.id} data-selected={row.id === 'broadcast'}>
                    <th>{row.name}{row.id === 'broadcast' ? <small>Jordan's pick</small> : null}</th>
                    <td>{row.c1}</td><td>{row.c2}</td><td>{row.c3}</td><td>{row.c4}</td><td>{row.c5}</td><td>{row.minimum}</td><td><strong>{row.average}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="results-fixes">
            <span>Applied after review</span>
            <p>Preview action demoted. Neutral pink removed. Helper contrast and target sizes raised. Game Tape money contrast corrected.</p>
            <strong>Final re-score pending</strong>
          </div>
        </section>
      </div>
    </div>
  )
}
