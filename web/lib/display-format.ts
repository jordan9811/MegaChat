/** Dollar display only. Preserve sub-cent prices without rounding paid actions to zero. */
export function formatDollars(value: string | number): string {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '$0'
  return `$${amount.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 6,
  })}`
}

/**
 * Middle-truncated address (6…4) for a line that must not wrap. One cut rule
 * for the site, so the same wallet reads the same on every surface. Short
 * strings pass through: cutting a 10-character value would only hide it.
 * The approve step keeps its own longer 8…6 cut on purpose (the person is
 * checking a spender there, and should see more of it).
 */
export function shortAddr(addr: string | null | undefined): string {
  const a = String(addr || '')
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}

export function guestName(): string {
  const adjectives = ['Turbo', 'Solar', 'Pixel', 'Lucky', 'Hyper', 'Cosmic', 'Rapid', 'Nova']
  const animals = ['Badger', 'Mantis', 'Falcon', 'Otter', 'Gecko', 'Panda', 'Raven', 'Tiger']
  const random = new Uint32Array(3)
  crypto.getRandomValues(random)
  return `${adjectives[random[0] % adjectives.length]}${animals[random[1] % animals.length]}${10 + random[2] % 90}`
}
