/** Dollar display only. Preserve sub-cent prices without rounding paid actions to zero. */
export function formatDollars(value: string | number): string {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '$0'
  return `$${amount.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 6,
  })}`
}

export function guestName(): string {
  const adjectives = ['Turbo', 'Solar', 'Pixel', 'Lucky', 'Hyper', 'Cosmic', 'Rapid', 'Nova']
  const animals = ['Badger', 'Mantis', 'Falcon', 'Otter', 'Gecko', 'Panda', 'Raven', 'Tiger']
  const random = new Uint32Array(3)
  crypto.getRandomValues(random)
  return `${adjectives[random[0] % adjectives.length]}${animals[random[1] % animals.length]}${10 + random[2] % 90}`
}
