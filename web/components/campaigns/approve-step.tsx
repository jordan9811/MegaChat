'use client'

// The allowance step Fund needs when the creator's wallet has not approved
// the campaign spender for the budget. Same client path the join page uses
// for a seat (lib/join-page.ts joinSeatMetered): the embedded wallet's
// EIP-1193 provider from the window.MegaWallet bridge, one
// eth_sendTransaction carrying approve(spender, amount), then wait for the
// receipt. The join page keeps its encoders private, so the calldata comes
// from viem (already a dependency) rather than a copy of those helpers.
//
// Then a SECOND prompt, no gas: the wallet signs the EIP-712 Fund message the
// server sent in `ask.sign` (this campaign, this wallet, token, amount, a
// deadline under 10 minutes). The approve alone only shows that some wallet
// approved the spender; the signature shows THIS wallet means THIS campaign
// (OPEN-ISSUES N10). If the signature is refused or fails, the mined approve
// is kept and the button asks only for the signature again.

import { useCallback, useState } from 'react'
import { encodeFunctionData, erc20Abi, getTypesForEIP712Domain } from 'viem'
import { explorerAddressUrl, explorerTxUrl, type ApprovalAsk, type FundProof } from '@/lib/campaigns-api'
import { rewardLabel } from './rules'

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }

export type { ApprovalAsk, FundProof }

/** Sign the server's Fund message with the approving wallet. No transaction, no gas. */
async function signFunding(provider: Eip1193, from: string, ask: ApprovalAsk): Promise<Omit<FundProof, 'approveTx'>> {
  const s = ask.sign
  if (!s) throw new Error('This server did not send the funding message to sign. Reload the page and try again.')
  // A minute inside the server's limit, so a slow wallet prompt still lands in time.
  const deadline = Math.floor(Date.now() / 1000) + Math.max(60, Math.min(s.maxSeconds || 600, 600) - 60)
  const message = { ...s.message, wallet: from, deadline: String(deadline) }
  const domain = s.domain as Parameters<typeof getTypesForEIP712Domain>[0]['domain']
  const payload = { domain: s.domain, types: { EIP712Domain: getTypesForEIP712Domain({ domain }), ...s.types }, primaryType: s.primaryType, message }
  const signature = (await provider.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(payload)] })) as string
  return { signature, typedData: { domain: s.domain, types: s.types, primaryType: s.primaryType, message } }
}

function formatAtomic(amountAtomic: string, decimals: number | null) {
  if (decimals == null) return amountAtomic
  try {
    // tsconfig targets ES6, so no bigint literals or ** on bigints here.
    const n = BigInt(amountAtomic)
    const base = BigInt(`1${'0'.repeat(decimals)}`)
    const whole = n / base
    const frac = (n % base).toString().padStart(decimals, '0').replace(/0+$/, '')
    return frac ? `${whole}.${frac}` : whole.toString()
  } catch {
    return amountAtomic
  }
}

const shortHex = (h: string) => (h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h)

async function waitForReceipt(provider: Eip1193, hash: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = (await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] })) as { status?: string } | null
    if (r) {
      if (r.status === '0x0') throw new Error('The approval transaction reverted.')
      return
    }
    await new Promise((res) => setTimeout(res, 1500))
  }
  throw new Error('The approval has not confirmed yet. Wait a moment, then try Fund again.')
}

/** The creator's embedded wallet address, connecting it first if needed. */
export async function connectedWallet(): Promise<string> {
  const MW = window.MegaWallet
  if (!MW?.configured) throw new Error('Sign-in is not configured on this server, so there is no wallet to fund from.')
  return MW.address || MW.connect()
}

export function ApproveStep({
  ask,
  explorerUrl,
  onApproved,
  onCancel,
}: {
  ask: ApprovalAsk
  explorerUrl: string
  /** Called once the approval is mined AND the wallet signed the Fund message, so the fund call can cite both. */
  onApproved: (proof: FundProof) => Promise<void> | void
  onCancel: () => void
}) {
  const [phase, setPhase] = useState<'idle' | 'wallet' | 'mining' | 'signing' | 'done' | 'error'>('idle')
  const [txHash, setTxHash] = useState<string | null>(null)
  // The approve that already mined: a retry after a refused signature asks
  // only for the signature, never for a second approve.
  const [minedTx, setMinedTx] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const symbol = ask.token?.symbol || 'TOKEN'
  const decimals = ask.token?.decimals ?? null
  const tokenAddress = ask.token?.address || ''

  const approve = useCallback(async () => {
    setError(null)
    setPhase('wallet')
    try {
      const MW = window.MegaWallet!
      const from = await connectedWallet()
      const provider = (await MW.getProvider()) as Eip1193
      let hash = minedTx
      if (!hash) {
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [ask.spender as `0x${string}`, BigInt(ask.amountAtomic)],
        })
        hash = (await provider.request({
          method: 'eth_sendTransaction',
          params: [{ from, to: tokenAddress, data }],
        })) as string
        setTxHash(hash)
        setPhase('mining')
        await waitForReceipt(provider, hash)
        setMinedTx(hash)
      }
      setPhase('signing')
      const proof = await signFunding(provider, from, ask)
      setPhase('done')
      await onApproved({ approveTx: hash, ...proof })
    } catch (e) {
      setPhase('error')
      setError(e instanceof Error ? e.message : 'The approval did not go through.')
    }
  }, [ask, tokenAddress, onApproved, minedTx])

  const busy = phase === 'wallet' || phase === 'mining' || phase === 'signing'
  // "$25" for USDC, "25 TOKEN" for anything else, the same rule as every
  // other money figure on these pages.
  const amount = rewardLabel(formatAtomic(ask.amountAtomic, decimals), symbol)
  return (
    <section className="mcp-approve" aria-live="polite">
      <span className="mcp-coordinate">One more step</span>
      <h3>Approve the budget</h3>
      {/* Plain words first (this is where a streamer who has never used a
          wallet drops off); the addresses wait behind Details. */}
      <p>
        {ask.walletRequired ? 'Connect the wallet the budget comes from. ' : ''}
        You’re allowing Holler to collect your <strong className="mcp-money">{amount}</strong> budget. Two quick wallet prompts: one approval, one signature, no gas on the second.
      </p>
      <details className="mcp-approve-details">
        <summary>Details</summary>
        <p>
          {/* What the platform wallet does with OTHER budgets is the server's
              claim to make (`holds`); without that word this only names the
              wallet the budget goes into. */}
          The approval lets Holler’s campaign spender move exactly this amount, into the Holler platform wallet{ask.holds === true ? ', which holds every campaign budget and pays every reward' : ''}.
          {ask.allowance && ask.allowance !== '0' ? ` Approved so far: ${formatAtomic(ask.allowance, decimals)} ${symbol}.` : ''}
        </p>
        <dl>
          <div><dt>Amount</dt><dd className="mcp-money">{formatAtomic(ask.amountAtomic, decimals)} {symbol}</dd></div>
          <div><dt>Token</dt><dd><code title={tokenAddress}>{shortHex(tokenAddress)}</code></dd></div>
          <div><dt>Approved to (campaign spender)</dt><dd><a className="mcp-link" href={explorerAddressUrl(explorerUrl, ask.spender)} target="_blank" rel="noopener"><code title={ask.spender}>{shortHex(ask.spender)}</code></a></dd></div>
          {ask.holder ? <div><dt>Held by (Holler platform wallet)</dt><dd><a className="mcp-link" href={explorerAddressUrl(explorerUrl, ask.holder)} target="_blank" rel="noopener"><code title={ask.holder}>{shortHex(ask.holder)}</code></a></dd></div> : null}
        </dl>
      </details>
      {minedTx || phase === 'signing' ? <p className="mcp-hint">Sign to confirm this approval funds this campaign (no gas).</p> : null}
      <div className="mcp-actions">
        <button type="button" className="mcp-btn" disabled={busy || phase === 'done'} onClick={() => void approve()}>
          {phase === 'wallet' ? 'Confirm in wallet…' : phase === 'mining' ? 'Confirming…' : phase === 'signing' ? 'Sign in wallet…' : phase === 'done' ? 'Approved' : minedTx ? 'Sign to fund' : 'Approve in wallet'}
        </button>
        <button type="button" className="mcp-btn-ghost" disabled={busy} onClick={onCancel}>Not now</button>
        {txHash ? <a className="mcp-link" href={explorerTxUrl(explorerUrl, txHash)} target="_blank" rel="noopener">approval tx</a> : null}
      </div>
      {error ? <p role="alert" className="mcp-error">{error}</p> : null}
    </section>
  )
}
