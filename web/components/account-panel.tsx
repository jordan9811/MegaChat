'use client'

// Account layer — rolled INTO the dashboard (no orphan page): who you are
// (handle + linked sign-ins), your balance, and your saved room defaults.
// The header chip's "Account" item deep-links here (?section=account).

import { useEffect, useState } from 'react'
import { UserRound, Wallet, SlidersHorizontal, RefreshCw, Trash2, Save } from 'lucide-react'
import { GlassCard, CardHeader } from '@/components/glass-card'
import { CopyRow } from '@/components/copy-row'
import { useRoom } from '@/components/room-provider'
import { listLinkedAccounts, type LinkedAccount } from '@/lib/api'
import { useUiMode } from '@/lib/ui-mode'
import { formatDollars } from '@/lib/display-format'

const PROVIDER_LABEL: Record<string, string> = {
  twitch: '🎮 Twitch',
  twitter: '𝕏 X (Twitter)',
  x: '𝕏 X (Twitter)',
  google: 'ⓖ Google',
  discord: '🎧 Discord',
  tiktok: '🎵 TikTok',
  email: '✉️ Email',
  passkey: '🔑 Passkey',
  wallet: '👛 Wallet',
  privy: '🔐 Privy',
}

function providerLabel(type: string) {
  return PROVIDER_LABEL[type] || type
}

export function AccountCard() {
  const { identityHandle, hasIdentity } = useRoom()
  const simple = useUiMode() === 'simple'
  const [accounts, setAccounts] = useState<LinkedAccount[] | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [balance, setBalance] = useState<string | null>(null)

  useEffect(() => {
    if (!hasIdentity) return
    listLinkedAccounts()
      .then((d) => setAccounts(d.accounts))
      .catch(() => setAccounts([]))
  }, [hasIdentity])

  // Wallet bridge — same source the header chip uses.
  useEffect(() => {
    const sync = () => setAddress(window.MegaWallet?.address ?? null)
    sync()
    window.addEventListener('megawallet:changed', sync)
    return () => window.removeEventListener('megawallet:changed', sync)
  }, [])
  useEffect(() => {
    if (!address) {
      setBalance(null)
      return
    }
    fetch(`/api/balance/${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const n = parseFloat(d?.available)
        setBalance(Number.isFinite(n) ? n.toFixed(2) : null)
      })
      .catch(() => {})
  }, [address])

  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  return (
    <GlassCard>
      <CardHeader
        icon={<UserRound className="size-5" />}
        title="Account"
        description="Your handle, balance, and the sign-ins linked to it."
        accent="cyan"
      />
      <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">
        {!hasIdentity ? (
          <p className="text-sm text-muted-foreground">
            Sign in (top right) to claim your handle — it becomes your
            permanent room link and unlocks saved defaults.
          </p>
        ) : (
          <>
            {identityHandle ? (
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Your handle — it&apos;s also your room link
                </p>
                <CopyRow label="Link" value={`${origin}/${identityHandle}`} />
              </div>
            ) : null}

            <div className="rounded-xl border border-border/70 bg-input/20 px-4 py-3">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Wallet className="size-4 text-[var(--neon-cyan)]" /> Balance
                </span>
                <span className="font-mono font-semibold text-foreground">
                  {address == null
                    ? '— no wallet connected'
                    : balance == null
                      ? '…'
                      : formatDollars(balance)}
                </span>
              </div>
              {address ? (
                <p className="mt-1 font-mono text-[10px] text-muted-foreground" title={address}>
                  {address.slice(0, 6)}…{address.slice(-4)}
                </p>
              ) : null}
            </div>

            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Linked accounts
              </p>
              {accounts == null ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : accounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing linked yet — sign-ins you add through the login modal
                  appear here.
                </p>
              ) : (
                <ul id="linked-accounts" className="flex flex-col gap-1.5">
                  {accounts.map((a, i) => (
                    <li
                      key={`${a.type}-${i}`}
                      className="flex items-center justify-between rounded-lg border border-border/60 bg-input/15 px-3 py-2 text-sm"
                    >
                      <span className="font-semibold text-foreground">{providerLabel(a.type)}</span>
                      <span className="truncate pl-3 font-mono text-xs text-muted-foreground">
                        {a.name || '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </GlassCard>
  )
}

// Human summary of a saved defaults blob — only fields worth glancing at.
function defaultsSummary(d: Record<string, unknown>): [string, string][] {
  const rows: [string, string][] = []
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null)
  const b = (k: string) => (typeof d[k] === 'boolean' ? (d[k] as boolean) : null)
  const price = s('passkeyTickPrice')
  if (price != null) rows.push(['Price / second', price === '0' ? 'Free room' : formatDollars(Number(price) / (Number(s('passkeyTickSeconds')) || 1))])
  const secs = s('passkeyTickSeconds')
  if (secs != null && secs !== '1') rows.push(['Charge interval', `${secs}s`])
  const cap = s('maxSession')
  if (cap != null) rows.push(['Session cap', formatDollars(cap)])
  const t = s('transport')
  if (t != null) rows.push(['Transport', t === 'livekit' ? 'LiveKit (default)' : 'vdo.ninja'])
  const mc = b('lettersEnabled')
  if (mc != null) rows.push(['MegaChats', mc ? 'On' : 'Off'])
  const js = b('joinStreamEnabled')
  if (js != null) rows.push(['Join Stream', js ? 'On' : 'Off'])
  const sfx = b('stingerSounds')
  if (sfx != null) rows.push(['Stinger sounds', sfx ? 'On' : 'Off'])
  const tw = s('twitchChannel')
  if (tw) rows.push(['Twitch channel', tw])
  return rows
}

export function DefaultsCard() {
  const { hasIdentity, accountDefaults, saveDefaultsFromDraft, clearDefaults } = useRoom()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function run(fn: () => Promise<void>, done: string) {
    setBusy(true)
    setNote(null)
    try {
      await fn()
      setNote(done)
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Failed — try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <GlassCard>
      <CardHeader
        icon={<SlidersHorizontal className="size-5" />}
        title="Default room settings"
        description="New rooms start from these instead of blank. Tune the create form the way you like it, then save it here once."
        accent="lime"
      />
      <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">
        {!hasIdentity ? (
          <p className="text-sm text-muted-foreground">
            Sign in (top right) to keep defaults — they follow your account,
            not this browser.
          </p>
        ) : (
          <>
            {accountDefaults ? (
              <div id="defaults-summary">
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Saved defaults
                </p>
                <ul className="flex flex-col gap-1">
                  {defaultsSummary(accountDefaults).map(([k, v]) => (
                    <li
                      key={k}
                      className="flex items-center justify-between rounded-lg border border-border/60 bg-input/15 px-3 py-1.5 text-sm"
                    >
                      <span className="text-muted-foreground">{k}</span>
                      <span className="font-semibold text-foreground">{v}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No defaults saved yet — every new room starts from the stock
                settings.
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                id="save-defaults"
                disabled={busy}
                onClick={() =>
                  void run(saveDefaultsFromDraft, '✓ Saved — new rooms start from this setup')
                }
                className="flex items-center gap-2 rounded-xl border border-[var(--neon-lime)]/60 bg-[var(--neon-lime)]/10 px-4 py-2.5 text-sm font-bold text-[var(--neon-lime)] transition-transform hover:scale-[1.02] disabled:opacity-60"
              >
                {busy ? <RefreshCw className="size-4 animate-spin" /> : <Save className="size-4" />}
                Save current create-form as my defaults
              </button>
              {accountDefaults ? (
                <button
                  type="button"
                  id="clear-defaults"
                  disabled={busy}
                  onClick={() => void run(clearDefaults, 'Cleared — back to stock settings')}
                  className="flex items-center gap-2 rounded-xl border border-border bg-input/20 px-4 py-2.5 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
                >
                  <Trash2 className="size-4" />
                  Clear
                </button>
              ) : null}
            </div>
            {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
          </>
        )}
      </div>
    </GlassCard>
  )
}
