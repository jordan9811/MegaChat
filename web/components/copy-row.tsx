'use client'

import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'

export function CopyRow({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore clipboard errors
    }
  }

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border border-border bg-input/30 px-3 py-2',
        className,
      )}
    >
      <span className="w-16 shrink-0 text-xs font-semibold text-muted-foreground">
        {label}
      </span>
      <code className="flex-1 truncate font-mono text-xs text-foreground/90">
        {value}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={`Copy ${label} link`}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-card/60 text-muted-foreground transition-colors hover:text-foreground"
      >
        {copied ? (
          <Check className="size-3.5 text-[var(--neon-lime)]" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
    </div>
  )
}
