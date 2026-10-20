import { HollerMark } from '@/components/holler-mark'

// The brand as it sits in a header or footer line: the Holler mark sized to
// the surrounding text (1em, solid record dot). The export keeps its old name
// so every existing <BrandText /> picks up the new mark.
export function BrandText() {
  return <HollerMark />
}
