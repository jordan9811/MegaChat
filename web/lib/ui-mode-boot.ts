// The Simple/Advanced mode key and the pre-paint script that applies it.
//
// A plain module, deliberately without 'use client': the root layout is a
// server component and renders this string inline. Exported from ui-mode.ts
// (a client module) it would reach the layout as a client reference, not as
// the string ("You cannot dot into a client module from a server component").
// ui-mode.ts imports the key from here, so the two can never disagree.
export const UI_MODE_KEY = 'mc-ui-mode'

/** Runs inline before first paint, so the first frame already carries data-ui. */
export const UI_MODE_BOOT_SCRIPT = `(function(){try{var m=localStorage.getItem('${UI_MODE_KEY}');document.documentElement.dataset.ui=(m==='simple'?'simple':'advanced');}catch(e){document.documentElement.dataset.ui='advanced';}})()`
