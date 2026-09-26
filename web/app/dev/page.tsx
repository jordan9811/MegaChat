import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { SiteSettingsPanel, type SiteSettingsData } from '@/components/dev/site-settings-panel'
import '../account/account.css'
import './dev.css'

// /dev — the site owner's settings, live, without a redeploy (site-settings.js).
//
// Hidden, not just unlinked: the server answers /api/site-settings only for
// the owner's signed-in account, and for anyone else falls through to what a
// path that does not exist answers — so this page asks it first and is a plain
// 404 for everybody else. No metadata of its own for the same reason: a 404
// here must look like every other 404.
export const dynamic = 'force-dynamic'

async function loadSettings(): Promise<SiteSettingsData | null> {
  const cookie = (await cookies()).toString()
  if (!cookie) return null
  // Our own process, over loopback: the owner's cookie never leaves the box.
  // localhost, not 127.0.0.1 — server.js redirects 127.0.0.1 to localhost, and
  // a redirect to another origin drops the cookie. Never follow one.
  const port = process.env.PORT || '3000'
  try {
    const res = await fetch(`http://localhost:${port}/api/site-settings`, {
      headers: { cookie },
      cache: 'no-store',
      redirect: 'manual',
    })
    if (!res.ok || !(res.headers.get('content-type') || '').includes('application/json')) return null
    return (await res.json()) as SiteSettingsData
  } catch {
    return null
  }
}

export default async function Page() {
  const data = await loadSettings()
  if (!data) notFound()
  return <SiteSettingsPanel initial={data} />
}
