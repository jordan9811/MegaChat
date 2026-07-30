import type { ObsClient } from './obs-client.mjs'

export const OVERLAY_INPUT_NAME: string
export const MONITOR: { HEAR: string; MUTE_LOCAL: string }

export function addOverlayToObs(client: ObsClient, opts: {
  overlayUrl: string
  inputName?: string
  monitorType?: string
}): Promise<{
  sceneName: string
  sceneItemId: number
  baseWidth: number
  baseHeight: number
  inputName: string
}>

export interface ObsVerifyCheck { name: string; ok: boolean; got: string; want: string }

export function verifyOverlayInObs(client: ObsClient, opts: {
  inputName?: string
  overlayUrl: string
  badgeMinHeightPx?: number
  badgeCssPx?: number
}): Promise<{
  ok: boolean
  checks: ObsVerifyCheck[]
  sceneName: string
  baseWidth: number
  baseHeight: number
}>
