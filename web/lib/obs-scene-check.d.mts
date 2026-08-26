import type { ObsClient } from './obs-client.mjs'

export const SCENE_STATE: {
  VISIBLE: string
  HIDDEN: string
  NOT_IN_SCENE: string
  ZERO_AREA: string
  OFF_CANVAS: string
  NO_CONNECTION: string
  ERROR: string
}

export interface SceneRect { x: number; y: number; width: number; height: number }

export interface SceneVisibility {
  at: number
  inputName: string
  /** false means "we could not look" — NOT "the overlay was hidden". */
  checked: boolean
  visible: boolean
  state: string
  detail?: string
  sceneName?: string
  sceneItemId?: number
  enabled?: boolean
  rect?: SceneRect
  baseWidth?: number
  baseHeight?: number
}

export function effectiveRect(transform: Record<string, unknown>): SceneRect
export function isOffCanvas(rect: SceneRect, baseWidth: number, baseHeight: number): boolean

export function checkOverlayVisible(
  client: ObsClient | null,
  opts?: { inputName?: string; now?: number },
): Promise<SceneVisibility>

export function stateIsNotVisible(state: string): boolean
export function stateIsConclusive(state: string): boolean
