/** See obs-visibility.mjs. */
export declare const VISIBILITY: {
  VISIBLE: 'overlay_visible'
  HIDDEN: 'overlay_hidden'
  SCALED: 'overlay_scaled_below_floor'
  DISCONNECTED: 'obs_disconnected'
}

export declare const HIDDEN_REASON: {
  SCENE: 'scene'
  DISABLED: 'disabled'
  OFFCANVAS: 'offcanvas'
  COVERED: 'covered'
}

export declare const HIGHER_INDEX_IS_ON_TOP: boolean
export declare const COVER_FRACTION: number

export type Rect = { x: number; y: number; width: number; height: number }

export declare function occluderRect(t?: Record<string, unknown>): Rect
export declare function coveredFraction(target: Rect, other: Rect): number
export declare function effectiveScale(
  t?: Record<string, unknown>,
  rect?: Rect,
): { scaleX: number | null; scaleY: number | null; sourceWidth: number | null; sourceHeight: number | null }

export declare function checkOverlayVisibility(
  client: unknown,
  opts?: { inputName?: string; now?: number },
): Promise<{
  signal: string
  reason: string | null
  detail?: string | null
  checked: boolean
  visible: boolean
  sceneName?: string
  rect?: Rect
  scale?: { scaleX: number | null; scaleY: number | null; sourceWidth: number | null; sourceHeight: number | null } | null
  occlusion?: { checked: boolean; covered: boolean; by: string | null; fraction: number; note?: string | null } | null
}>
