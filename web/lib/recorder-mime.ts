/**
 * The best video format this browser can record, or '' when it cannot record at
 * all. WebM first (Chrome, Firefox), then MP4 (Safari and iOS, which have no
 * WebM recorder). Asking MediaRecorder for a type it does not support throws
 * NotSupportedError, so every recorder on the site asks here first. The
 * Holler and bounty clip routes both accept webm and mp4.
 */
export function recorderMime(): string {
  if (typeof window === 'undefined' || !window.MediaRecorder) return ''
  for (const m of ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported(m)) return m
  }
  return ''
}
