// The Retro/Classic look key and the pre-paint script that applies it.
//
// A plain module, deliberately without 'use client', for the same reason as
// ui-mode-boot.ts: the root layout is a server component and renders this
// string inline. Retro is the default; the stylesheet treats any value other
// than "classic" as retro, so a blocked localStorage still paints retro.
export const STYLE_KEY = 'holler-style'

export type HollerStyle = 'retro' | 'classic'

/** Runs inline before first paint, so the first frame already carries data-style. */
export const STYLE_BOOT_SCRIPT = `(function(){try{var s=localStorage.getItem('${STYLE_KEY}');document.documentElement.dataset.style=(s==='classic'?'classic':'retro');}catch(e){document.documentElement.dataset.style='retro';}})()`
