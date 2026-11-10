// The streamer's face beside their handle on board cards (booth, recent rail).
/** The streamer's face: their platform avatar, or a monogram of their name.
 *  Small, beside the handle, so a tile says whose stream it is at a glance. */
export function HostFace({ url, name }: { url: string | null; name: string }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="mcr-hostface" src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
  ) : (
    <span className="mcr-hostface is-mono" aria-hidden="true">{(name || '?').replace(/^@/, '').trim().charAt(0).toUpperCase() || '?'}</span>
  )
}
