// Round-1 contrast probe: every text node vs its composited background, WCAG
// 4.5:1 (3:1 large), both themes. Run from repo root against a running server.
import puppeteer from 'puppeteer-core'
const BASE = process.argv[2] || 'http://localhost:3388'
const PAGES = (process.argv[3] || '/,/app,/dashboard,/bounty,/join?room=demo,/how-it-works,/account').split(',')
const PROBE = 
(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1
  const cx = cv.getContext('2d', { willReadFrequently: true })
  const rgba = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255] }
  const over = (top, bot) => { const a = top[3]; return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1] }
  const L = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]) }
  const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const root = rgba(getComputedStyle(document.body).backgroundColor)
  const base = root[3] > 0 ? over(root, [255, 255, 255, 1]) : rgba(getComputedStyle(document.documentElement).backgroundColor)
  const bgOf = (el) => {
    const stack = []; let n = el; let hasImg = false
    while (n && n.nodeType === 1) { const cs = getComputedStyle(n); const c = rgba(cs.backgroundColor); if (cs.backgroundImage && cs.backgroundImage !== 'none' && !/url\(/.test(cs.backgroundImage)) hasImg = true; if (/url\(/.test(cs.backgroundImage) || n.tagName === 'VIDEO' || n.tagName === 'IMG') return { media: true }; if (c[3] > 0) { stack.push(c); if (c[3] >= 0.99) break } n = n.parentElement }
    let bg = (stack.length && stack[stack.length - 1][3] >= 0.99) ? stack.pop() : base
    while (stack.length) bg = over(stack.pop(), bg)
    return { bg, hasImg }
  }
  const out = []; const seen = new Set()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const t = walker.currentNode; const txt = t.textContent.trim(); if (txt.length < 2) continue
    const el = t.parentElement; if (!el || seen.has(el)) continue; seen.add(el)
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue
    if (el.closest('[aria-hidden="true"], .sr-only, video, [hidden]')) continue
    const b = bgOf(el); if (b.media) continue
    let op = 1; let n = el; while (n && n.nodeType === 1) { op *= +getComputedStyle(n).opacity; n = n.parentElement }
    let fg = rgba(cs.color); fg = [fg[0], fg[1], fg[2], fg[3] * op]; fg = over(fg, b.bg)
    const cr = ratio(fg, b.bg); const size = parseFloat(cs.fontSize); const bold = +cs.fontWeight >= 700
    const large = size >= 24 || (size >= 18.66 && bold); const need = large ? 3 : 4.5
    if (cr < need) out.push({ txt: txt.slice(0, 40), cr: +cr.toFixed(2), need, size, color: cs.color, bg: 'rgb(' + b.bg.slice(0, 3).map(Math.round).join(',') + ')', grad: b.hasImg, cls: (el.className && el.className.baseVal === undefined ? String(el.className) : '').slice(0, 50), y: Math.round(r.top + scrollY) })
  }
  return { theme: document.documentElement.classList.contains('light') ? 'light' : 'dark', fails: out.length, items: out.slice(0, 40) }
})

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new' })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
const results = {}
for (const theme of ['dark', 'light']) {
  for (const p of PAGES) {
    await page.evaluateOnNewDocument((t) => { try { localStorage.setItem('theme', t) } catch {} }, theme)
    await page.goto(BASE + p, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1500))
    const r = await page.evaluate(`(${PROBE.toString()})()`)
    results[`${p} ${theme}`] = r
    console.log(`\n## ${p} [${theme}] html=${r.theme} fails=${r.fails}`)
    for (const i of r.items) console.log(`  ${i.cr}:1 (need ${i.need}) ${i.size}px "${i.txt}" fg=${i.color} bg=${i.bg}${i.grad ? ' +grad' : ''} .${i.cls} y=${i.y}`)
  }
}
await browser.close()
