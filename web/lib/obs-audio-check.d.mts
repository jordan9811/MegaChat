export const MONITOR_AND_OUTPUT: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT'

export function isRoomOverlay(url: unknown, opts: { roomId?: string | null; handle?: string | null }): boolean

export type ObsAudioProblemRaw = {
  id: string
  code: string
  text: string
  fix: null | { label: string; requestType: string; requestData: Record<string, unknown> }
}

export function checkObsAudio(
  request: (type: string, data?: object) => Promise<any>,
  opts: { mode: 'tab' | 'system'; roomId: string; handle?: string | null },
): Promise<ObsAudioProblemRaw[]>
