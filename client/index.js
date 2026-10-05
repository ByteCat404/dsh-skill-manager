'use strict'

// Browser-only client. React and ReactDOM are supplied by DSH's module loader.
const { createElement: h, useState, useEffect, useLayoutEffect, useRef } = require('react')
const { createPortal } = require('react-dom')
const { QuickCreate } = require('./quick-create')
const NS = 'dsh-skill-manager'
const API = '/' + NS + '/api'
let composerScope = null
// Styles stay inside each shadow root; no document-wide rules are installed.
const STYLE_ID = NS + '-style'

function resolveTheme(source) {
  const root = getComputedStyle(document.documentElement)
  const computed = getComputedStyle(source || document.documentElement)
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const color = value => {
    value = value.trim()
    if (!context || !value || !CSS.supports('color', value) || /^(currentcolor|inherit|initial|unset|revert|revert-layer)$/i.test(value)) return null
    context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1)
    return Array.from(context.getImageData(0, 0, 1, 1).data)
  }
  const token = name => color(computed.getPropertyValue(name))
  const base = token('--dsw-alias-bg-base')
  const text = token('--dsw-alias-label-primary')
  const scheme = computed.colorScheme === 'normal' ? root.colorScheme : computed.colorScheme
  const marker = document.documentElement
  const markedDark = marker.classList.contains('dark') || marker.dataset.theme === 'dark' || marker.dataset.colorMode === 'dark'
  const markedLight = marker.classList.contains('light') || marker.dataset.theme === 'light' || marker.dataset.colorMode === 'light'
  const brightness = rgba => rgba[0] * .2126 + rgba[1] * .7152 + rgba[2] * .0722
  const dark = markedDark || (!markedLight && (scheme === 'dark' || (scheme !== 'light' && (base && base[3] > 128 ? brightness(base) < 128 : text && text[3] > 128 ? brightness(text) > 160 : matchMedia('(prefers-color-scheme: dark)').matches))))
  const backing = dark ? [24, 27, 33, 255] : [255, 255, 255, 255]
  const blend = (value, fallback) => {
    if (!value) return fallback
    const alpha = value[3] / 255
    return [0, 1, 2].map(i => Math.round(value[i] * alpha + fallback[i] * (1 - alpha))).concat(255)
  }
  const bg = blend(base, backing)
  const luminance = value => value.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
  const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) }
  const lightText = [255, 255, 255, 255], darkText = [0, 0, 0, 255]
  const commonContrast = value => Math.max(Math.min(contrast(lightText, bg), contrast(lightText, value)), Math.min(contrast(darkText, bg), contrast(darkText, value)))
  // Never collapse cards into the panel to repair contrast. Choose a distinct,
  // opaque layer that supports one readable foreground on BOTH surfaces.
  const proposedSurface = blend(token('--dsw-alias-bg-layer-1'), bg)
  const layerContrast = contrast(proposedSurface, bg)
  let surface = proposedSurface
  if (layerContrast < 1.1 || layerContrast > 1.35 || commonContrast(surface) < 4.5) {
    const candidates = []
    for (const endpoint of [lightText, darkText]) {
      for (let alpha = 8; alpha <= 160; alpha += 2) {
        const candidate = blend(endpoint.slice(0, 3).concat(alpha), bg), ratio = contrast(candidate, bg)
        if (ratio >= 1.1 && ratio <= 1.35 && commonContrast(candidate) >= 4.5) candidates.push({ value: candidate, distance: Math.abs(ratio - 1.16) })
      }
    }
    candidates.sort((a, b) => a.distance - b.distance)
    surface = candidates[0]?.value || proposedSurface
  }
  const readable = value => Math.min(contrast(value, bg), contrast(value, surface))
  const fallbackText = readable(lightText) > readable(darkText) ? lightText : darkText
  const preferDarkText = fallbackText === darkText
  const muted = preferDarkText ? [94, 103, 118, 255] : [183, 190, 202, 255]
  const fallbackMuted = readable(muted) >= 4.5 ? muted : fallbackText
  const safeText = (value, fallback) => {
    const candidate = blend(value, bg)
    return value && readable(candidate) >= 4.5 ? candidate : readable(fallback) >= 4.5 ? fallback : fallbackText
  }
  let brand = safeText(token('--dsw-alias-state-business-primary') || token('--dsw-alias-brand-primary'), preferDarkText ? [70, 85, 196, 255] : [157, 173, 255, 255])
  const tintContrast = value => contrast(value, blend(value.slice(0, 3).concat(255 * .08), bg))
  if (tintContrast(brand) < 4.5) brand = preferDarkText ? [70, 85, 196, 255] : [157, 173, 255, 255]
  if (readable(brand) < 4.5 || tintContrast(brand) < 4.5) brand = fallbackText
  // Badge uses semantic colors, not host brand/secondary tokens (which may be purple).
  const gray = fallbackMuted
  const greens = preferDarkText ? [[21, 112, 63, 255], [0, 65, 24, 255], [0, 25, 8, 255], [0, 5, 1, 255], [0, 1, 0, 255]] : [[117, 220, 159, 255], [176, 255, 197, 255], [229, 255, 233, 255], [254, 255, 254, 255]]
  // This badge paints on its own tint or bg, not the panel's secondary surface.
  const green = greens.find(value => contrast(value, bg) >= 4.5) || greens[greens.length - 1]
  const greenTint = blend(green.slice(0, 3).concat(255 * .09), bg)
  const rgb = value => 'rgb(' + value.slice(0, 3).join(',') + ')'
  return {
    '--skm-bg': rgb(bg), '--skm-surface': rgb(surface), '--skm-text': rgb(safeText(text, fallbackText)),
    '--skm-muted': rgb(safeText(token('--dsw-alias-label-secondary'), fallbackMuted)),
    '--skm-line': rgb(blend(token('--dsw-alias-border-l2'), preferDarkText ? [220, 225, 233, 255] : [65, 73, 88, 255])),
    '--skm-tint': rgb(tintContrast(brand) >= 4.5 ? blend(brand.slice(0, 3).concat(255 * .08), bg) : bg),
    '--skm-brand': rgb(brand), '--skm-on-brand': contrast(brand, lightText) >= contrast(brand, darkText) ? '#fff' : '#000',
    '--skm-danger': rgb(safeText([211, 68, 77, 255], preferDarkText ? [168, 36, 46, 255] : [255, 147, 155, 255])),
    '--skm-count-gray': rgb(gray), '--skm-green': rgb(green), '--skm-green-tint': rgb(contrast(green, greenTint) >= 4.5 ? greenTint : bg),
    'color-scheme': dark ? 'dark' : 'light',
  }
}

function ShadowBoundary({ children, overlay = false, themeSource }) {
  const hostRef = useRef(null)
  const [shadow, setShadow] = useState(null)
  useEffect(() => {
    const host = hostRef.current
    // Inline !important also protects the host itself from universal theme rules.
    const rules = { all: 'initial', display: overlay ? 'block' : 'inline-flex', position: overlay ? 'fixed' : 'static', opacity: '1', visibility: 'visible', filter: 'none', transform: 'none', 'pointer-events': overlay ? 'none' : 'auto', 'box-sizing': 'border-box', 'font-family': 'Inter,system-ui,-apple-system,"Segoe UI",sans-serif', 'font-size': '13px', 'line-height': '1.5', direction: 'ltr' }
    if (overlay) Object.assign(rules, { inset: '0', 'z-index': '2147483000', width: 'auto', height: 'auto', margin: '0', padding: '0', border: '0', background: 'transparent', overflow: 'visible' })
    for (const [name, value] of Object.entries(rules)) host.style.setProperty(name, value, 'important')
    const root = host.shadowRoot || host.attachShadow({ mode: 'open' })
    ensureStyles(root)
    let queued = false, alive = true
    const update = () => {
      queued = false
      if (!alive) return
      for (const [name, value] of Object.entries(resolveTheme(themeSource?.() || host.parentElement))) {
        if (host.style.getPropertyValue(name) !== value) host.style.setProperty(name, value, 'important')
      }
    }
    const schedule = () => { if (!queued) { queued = true; queueMicrotask(update) } }
    update(); setShadow(root)
    const observer = new MutationObserver(schedule)
    const ancestors = new Set([document.documentElement, document.body])
    for (let node = themeSource?.() || host.parentElement; node; node = node.parentElement) ancestors.add(node)
    for (const node of ancestors) observer.observe(node, { attributes: true })
    observer.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true })
    // A linked stylesheet can finish loading after its DOM insertion.
    document.addEventListener('load', schedule, true)
    const media = matchMedia('(prefers-color-scheme: dark)'); media.addEventListener('change', schedule)
    return () => { alive = false; observer.disconnect(); document.removeEventListener('load', schedule, true); media.removeEventListener('change', schedule) }
  }, [])
  return h(__Fragment, null, h('span', { ref: hostRef, 'data-skm-host': overlay ? 'panel' : 'trigger' }), shadow ? createPortal(children, shadow) : null)
}

function deepestActiveElement() {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active
}

// 归还焦点时触发控件可能正处在刷新/加锁造成的短暂 disabled 状态（例如保存成功后列表 refresh 期间），
// 只检查一次会静默放弃。这里在“焦点仍停留在原位、用户没有移开”的前提下按帧重试到可用为止。
function restoreFocusWhenReady(getTrigger, active, host, deadlineMs = 800) {
  const until = Date.now() + deadlineMs
  const attempt = () => {
    const current = deepestActiveElement()
    if (!document.hasFocus() || !(current === active || current === document.body || current === host)) return
    const trigger = getTrigger()
    if (trigger?.isConnected && !trigger.disabled && !trigger.closest('[inert],[hidden]')) { trigger.focus({ preventScroll: true }); return }
    if (Date.now() < until) requestAnimationFrame(attempt)
  }
  queueMicrotask(attempt)
}

function Icon({ name, size = 18, ...props }) {
  const paths = {
    skills: ['M12 3 3 8l9 5 9-5-9-5Z', 'm3 12 9 5 9-5', 'm3 16 9 5 9-5'],
    search: ['M21 21l-4.4-4.4', 'M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0'],
    plus: ['M12 5v14', 'M5 12h14'], close: ['m6 6 12 12', 'M18 6 6 18'],
    upload: ['M12 16V3', 'm7 8 5-5 5 5', 'M4 16v4h16v-4'],
    folder: ['M3 7V5h6l2 2h10v13H3V7Z'], file: ['M14 2H5v20h14V7l-5-5Z', 'M14 2v6h5', 'M8 13h8', 'M8 17h6'],
    arrow: ['M5 12h14', 'm13 6 6 6-6 6'], check: ['m5 12 4 4L19 6'],
    refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M6 7a7 7 0 0 1 12-2l2 3', 'M18 17a7 7 0 0 1-12 2l-2-3'],
    rename: ['m15 5 4 4', 'M4 16v4h4L21 7a2.8 2.8 0 0 0-4-4L4 16Z'],
    trash: ['M3 6h18', 'M9 6V3h6v3', 'M5 6l1 15h12l1-15', 'M10 10v7', 'M14 10v7'],
    alert: ['m12 3 10 18H2L12 3Z', 'M12 9v5', 'M12 17h.01'],
  }
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, ...props },
    (paths[name] || paths.skills).map((d, i) => h('path', { key: i, d })))
}

function ensureStyles(root) {
  if (!root) return
  let style = root.getElementById(STYLE_ID)
  if (!style) { style = document.createElement('style'); style.id = STYLE_ID; root.appendChild(style) }
  style.textContent = `
:host{color:var(--skm-text);font:13px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
:host::before,:host::after{content:none!important;display:none!important}
*,*::before,*::after{box-sizing:border-box}button,input,textarea{appearance:none;font:inherit;letter-spacing:normal;text-transform:none;margin:0}button{color:inherit;text-align:center}svg{display:block;max-width:none}h2,h3,p,pre{margin:0}button::before,button::after{content:none}[hidden]{display:none!important}
.skm-panel,.skm-trigger{color:var(--skm-text);font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;line-height:1.5}
.skm-panel button,.skm-trigger{cursor:pointer}.skm-panel button:disabled{cursor:not-allowed;opacity:.5}.skm-panel svg,.skm-trigger svg{flex-shrink:0}
.skm-trigger{display:inline-flex;align-items:center;gap:6px;background:transparent;border:0;border-radius:8px;padding:5px 8px;color:var(--skm-muted)}.skm-trigger[aria-expanded=true]{background:var(--skm-tint);color:var(--skm-brand)}
.skm-panel{position:fixed;z-index:2147483000;display:flex;flex-direction:column;background:var(--skm-bg);border:1px solid var(--skm-line);border-radius:18px;box-shadow:0 24px 80px #0003,0 4px 16px #0001;overflow:hidden;isolation:isolate;pointer-events:auto}
.skm-header{display:flex;align-items:center;gap:12px;padding:20px 22px 16px;flex-shrink:0}.skm-logo{width:42px;height:42px;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--skm-brand) 20%,var(--skm-line));border-radius:12px;background:var(--skm-tint);color:var(--skm-brand)}.skm-title{font-size:17px;line-height:1.4;font-weight:650;letter-spacing:-.4px;margin:0}.skm-subtitle{font-size:12px;color:var(--skm-muted);margin:2px 0 0}.skm-header-copy{flex:1;min-width:0}
.skm-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--skm-muted);flex-shrink:0}.skm-tabs{display:flex;gap:6px;padding:0 22px 14px;border-bottom:1px solid var(--skm-line);flex-shrink:0}.skm-tab{display:inline-flex;align-items:center;justify-content:center;gap:7px;background:transparent;border:1px solid transparent;padding:8px 14px;border-radius:9px;color:var(--skm-muted);font-weight:550}.skm-tab[aria-selected=true]{background:var(--skm-tint);border-color:color-mix(in srgb,var(--skm-brand) 16%,transparent);color:var(--skm-brand)}
.skm-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:20px 22px}.skm-page[hidden]{display:none}.skm-footer{display:flex;align-items:center;gap:8px;justify-content:space-between;padding:11px 22px;border-top:1px solid var(--skm-line);font-size:11px;color:var(--skm-muted);background:var(--skm-surface);flex-shrink:0}.skm-key{border:1px solid var(--skm-line);border-radius:4px;padding:1px 5px;font-size:10px}
.skm-toolbar{display:flex;gap:10px;align-items:center;margin-bottom:16px}.skm-search-wrap{position:relative;flex:1}.skm-search-wrap>svg{position:absolute;left:12px;top:11px;color:var(--skm-muted)}.skm-search-wrap .skm-input{padding-left:38px;padding-right:38px}.skm-search-clear{position:absolute;right:4px;top:4px}.skm-input,.skm-textarea{display:block;width:100%;border:1px solid var(--skm-line);border-radius:9px;padding:9px 11px;background:var(--skm-bg);color:var(--skm-text);outline:none}.skm-input::placeholder,.skm-textarea::placeholder{color:var(--skm-muted);opacity:1}.skm-input:focus,.skm-textarea:focus{border-color:var(--skm-brand);box-shadow:0 0 0 3px var(--skm-tint)}.skm-textarea{min-height:160px;resize:vertical;line-height:1.65;font-family:ui-monospace,SFMono-Regular,Consolas,monospace!important;font-size:12px!important}
.skm-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--skm-muted);font-size:12px;margin-bottom:10px}.skm-summary strong{color:var(--skm-text);font-variant-numeric:tabular-nums;font-weight:600}.skm-library{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;align-items:start}.skm-list{display:flex;flex-direction:column;gap:7px;max-height:350px;overflow:auto;scrollbar-width:thin;padding:2px}.skm-row{width:100%;text-align:left;display:flex;align-items:flex-start;gap:10px;border:1px solid var(--skm-line);background:var(--skm-bg);border-radius:11px;padding:12px;color:var(--skm-text)}.skm-row[aria-pressed=true]{border-color:color-mix(in srgb,var(--skm-brand) 50%,var(--skm-line));background:var(--skm-tint)}.skm-row-icon{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:var(--skm-surface);color:var(--skm-brand);flex-shrink:0}.skm-row-copy{min-width:0;flex:1}.skm-name{font-size:13px;font-weight:600;overflow-wrap:anywhere}.skm-desc{font-size:12px;color:var(--skm-muted);margin-top:3px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.skm-preview{border:1px solid var(--skm-line);border-radius:12px;background:var(--skm-surface);padding:16px;min-width:0}.skm-eyebrow{font-size:10px;font-weight:600;letter-spacing:1px;color:var(--skm-muted);margin-bottom:8px}.skm-preview h3{margin:0 0 6px;font-size:16px;overflow-wrap:anywhere}.skm-preview-desc{font-size:12px;color:var(--skm-muted);margin:0 0 14px;overflow-wrap:anywhere}.skm-code{margin:0 0 14px;padding:12px;border:1px solid var(--skm-line);border-radius:8px;background:var(--skm-bg);font:11px/1.7 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto}.skm-preview-actions{display:flex;align-items:center;gap:8px}.skm-preview-actions .skm-primary{flex:1}
.skm-primary,.skm-secondary{display:inline-flex;align-items:center;justify-content:center;gap:7px;border-radius:9px;padding:9px 13px;font-weight:550;min-height:38px}.skm-primary{background:var(--skm-brand);border:1px solid transparent;color:var(--skm-on-brand)}.skm-secondary{background:var(--skm-bg);color:var(--skm-text);border:1px solid var(--skm-line)}.skm-danger{color:var(--skm-danger)}.skm-empty{text-align:center;border:1px dashed var(--skm-line);border-radius:12px;padding:28px 18px;color:var(--skm-muted)}.skm-empty>svg{color:var(--skm-brand);margin-bottom:8px}.skm-empty h3{font-size:14px;margin:0 0 6px;color:var(--skm-text)}.skm-empty p{font-size:12px;margin:0 0 14px}.skm-empty-actions{display:flex;gap:8px;justify-content:center}.skm-error,.skm-success{display:flex;gap:8px;align-items:flex-start;border-radius:9px;padding:10px 12px;margin-bottom:12px;font-size:12px;overflow-wrap:anywhere}.skm-error{background:color-mix(in srgb,#d3444d 8%,var(--skm-bg));color:var(--skm-text);border:1px solid color-mix(in srgb,#d3444d 25%,var(--skm-line))}.skm-error>svg{color:var(--skm-danger);margin-top:1px}.skm-success{background:var(--skm-tint);border:1px solid color-mix(in srgb,var(--skm-brand) 20%,var(--skm-line));color:var(--skm-brand)}.skm-success>span{flex:1}
.skm-section-title{font-size:15px;font-weight:600;margin:0 0 5px}.skm-hint{font-size:12px;color:var(--skm-muted);line-height:1.6;margin:0 0 16px}.skm-segment{display:inline-flex;background:var(--skm-surface);border:1px solid var(--skm-line);padding:3px;border-radius:9px;gap:3px;margin-bottom:18px}.skm-segment button{border:1px solid transparent;border-radius:6px;background:transparent;color:var(--skm-muted);padding:6px 12px}.skm-segment button[aria-pressed=true]{background:var(--skm-bg);border-color:var(--skm-line);color:var(--skm-text);box-shadow:0 1px 3px #0001}.skm-upload{border:1px dashed color-mix(in srgb,var(--skm-brand) 35%,var(--skm-line));border-radius:13px;background:var(--skm-tint);text-align:center;padding:26px 18px;margin-bottom:16px}.skm-upload-icon{display:inline-grid;place-items:center;width:46px;height:46px;background:var(--skm-bg);border:1px solid var(--skm-line);border-radius:12px;color:var(--skm-brand);margin-bottom:12px}.skm-upload h3{font-size:14px;margin:0 0 6px}.skm-upload p{font-size:12px;color:var(--skm-muted);margin:0 0 18px}.skm-upload-actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}.skm-note{display:flex;gap:9px;padding:12px 14px;border:1px solid var(--skm-line);background:var(--skm-surface);border-radius:9px;font-size:12px;color:var(--skm-muted)}.skm-note svg{color:var(--skm-brand);margin-top:2px}.skm-note strong{color:var(--skm-text);font-weight:550}.skm-field{margin-bottom:15px}.skm-field label{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;font-weight:550;margin-bottom:6px}.skm-field label span{font-size:11px;font-weight:400;color:var(--skm-muted)}.skm-field small{display:block;font-size:11px;color:var(--skm-muted);margin-top:5px}.skm-fields-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}.skm-form-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px}.skm-form-actions>span{font-size:11px;color:var(--skm-muted)}
.skm-panel button:focus-visible,.skm-trigger:focus-visible{outline:2px solid var(--skm-brand);outline-offset:3px}.skm-panel button,.skm-trigger{transition:transform 120ms cubic-bezier(.23,1,.32,1)}.skm-panel button:active:not(:disabled),.skm-trigger:active{transform:scale(.98)}
@media(hover:hover) and (pointer:fine){.skm-icon-btn:hover,.skm-trigger:hover,.skm-tab:hover{background:var(--skm-surface);color:var(--skm-text)}.skm-row:hover{border-color:var(--skm-brand)}.skm-primary:hover{filter:brightness(1.06)}.skm-secondary:hover{background:var(--skm-surface)}}
@media(max-width:600px){.skm-header{padding:15px 16px 12px}.skm-tabs{padding:0 16px 12px}.skm-tab{flex:1;padding:8px 9px}.skm-body{padding:16px}.skm-footer{padding:10px 16px}.skm-library{grid-template-columns:1fr}.skm-list{max-height:220px}.skm-fields-row{grid-template-columns:1fr;gap:0}.skm-form-actions>span{max-width:45%}.skm-subtitle{font-size:11px}.skm-footer>span:first-child{max-width:80%}.skm-logo{width:36px;height:36px}}
.skm-library{display:block}.skm-list{width:100%;max-height:none;overflow:visible}.skm-desc{display:block;overflow:visible}.skm-section-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:18px 0 10px}.skm-section-bar .skm-hint{margin:0}.skm-inline-actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.skm-row-actions{display:flex;gap:7px;align-items:center;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}.skm-compact{padding:5px 9px;min-height:30px;font-size:12px}.skm-collection,.skm-editor{border:1px solid var(--skm-line);border-radius:11px;background:var(--skm-surface);padding:12px;margin-bottom:10px}.skm-collection>.skm-section-bar{margin:0 0 10px}.skm-editor .skm-section-title{margin-bottom:10px}.skm-members{border:1px solid var(--skm-line);border-radius:8px;margin:0 0 12px;padding:10px;display:flex;flex-direction:column;gap:8px;max-height:240px;overflow:auto}.skm-check{display:inline-flex;align-items:center;gap:8px;min-height:32px;cursor:pointer;overflow-wrap:anywhere}.skm-check input{appearance:auto;accent-color:var(--skm-brand);width:17px;height:17px;flex-shrink:0}.skm-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}.skm-tag{border:1px solid var(--skm-line);border-radius:5px;padding:1px 6px;font-size:11px;color:var(--skm-muted);background:var(--skm-surface)}.skm-details{margin-top:7px}.skm-details summary{cursor:pointer;color:var(--skm-brand);font-size:12px}.skm-details .skm-code{margin-top:8px;margin-bottom:0}.skm-toggle{position:relative;display:inline-flex;align-items:center;flex-shrink:0;width:42px;height:25px;border:1px solid var(--skm-muted);border-radius:20px;background:var(--skm-surface);padding:3px}.skm-toggle-dot{display:block;width:17px;height:17px;border-radius:50%;background:var(--skm-muted)}.skm-toggle[aria-checked=true]{background:var(--skm-brand);border-color:var(--skm-brand)}.skm-toggle[aria-checked=true] .skm-toggle-dot{background:var(--skm-on-brand);margin-left:auto}.skm-sr{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.skm-panel button,.skm-trigger{transition:none}.skm-panel button:active:not(:disabled),.skm-trigger:active{transform:none}.skm-panel input:focus-visible,.skm-panel select:focus-visible,.skm-panel summary:focus-visible{outline:2px solid var(--skm-brand);outline-offset:3px}.skm-panel select{font:inherit;background:var(--skm-bg);color:var(--skm-text);border:1px solid var(--skm-line)}.skm-note{margin-bottom:12px}.skm-summary{flex-wrap:wrap}.skm-empty>svg{margin-left:auto;margin-right:auto}.skm-quick-create .skm-upload-actions{justify-content:flex-start}
@media(max-width:600px){.skm-list{max-height:none}.skm-row{flex-wrap:wrap}.skm-row-copy{min-width:calc(100% - 45px)}.skm-row-actions{width:100%;justify-content:flex-start;padding-left:40px}.skm-collection{padding:10px}.skm-inline-actions{width:100%}.skm-section-bar .skm-inline-actions{justify-content:flex-start}.skm-toolbar{gap:5px}.skm-summary>span{width:100%}}
.skm-trigger-group{display:inline-flex;align-items:center;gap:2px}.skm-count{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:21px;padding:0 6px;border-radius:7px;background:var(--skm-surface);border:1px solid var(--skm-line);color:var(--skm-count-gray);font-size:11px;font-weight:650;font-variant-numeric:tabular-nums}.skm-count[data-positive=true]{color:var(--skm-green);border-color:color-mix(in srgb,var(--skm-green) 30%,var(--skm-line));background:var(--skm-green-tint)}.skm-skill-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:12px;align-items:center;padding:11px 12px;border:0;border-bottom:1px solid var(--skm-line);border-radius:0;background:transparent;position:relative}.skm-skill-row .skm-row-copy{min-width:0}.skm-collection{background:transparent;border:0;border-bottom:1px solid var(--skm-line);border-radius:0;margin:0;padding:10px 0}.skm-collection-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.skm-collection-name{display:flex;align-items:center;gap:8px;flex:1;min-width:0;text-align:left;border:0;background:transparent;padding:5px;color:var(--skm-text);font-weight:550;overflow-wrap:anywhere}.skm-member-count{font-size:11px;color:var(--skm-muted);font-weight:400}.skm-collection-bar>.skm-check>span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.skm-collection-more{display:contents}.skm-collection-more>.skm-inline-actions{flex-basis:100%;padding:6px 5px}.skm-collection-more:not([open])>.skm-inline-actions{display:none}.skm-collection-members{padding-left:16px}.skm-session-details{margin-bottom:14px;font-size:12px;color:var(--skm-muted)}.skm-session-details>summary{cursor:pointer;width:fit-content}.skm-session-details .skm-hint{margin:9px 0}.skm-panel{overscroll-behavior:contain}.skm-body{scrollbar-width:thin}
@media(max-width:600px){.skm-skill-row{grid-template-columns:minmax(0,1fr) auto auto;padding:11px 3px;gap:8px}.skm-skill-row .skm-row-copy{min-width:0}.skm-collection-name{min-width:120px}.skm-collection-members{padding-left:8px}.skm-input,.skm-textarea{font-size:16px}.skm-trigger{padding:5px}}
/* One scroll owner keeps the refresh control visible without covering any row. */
.skm-body{display:flex;flex-direction:column;overflow:hidden;padding:0}.skm-body>.skm-success{flex-shrink:0;margin:12px 22px 0}.skm-page{flex:1;min-height:0;overflow:auto;padding:20px 22px}.skm-page#skm-page-select{display:flex;overflow:hidden;padding:0}.skm-library-page{display:flex;flex-direction:column;min-height:0;width:100%;flex:1}.skm-library-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scroll-padding-block:12px;padding:20px 22px 8px;scrollbar-width:thin}.skm-toolbar{margin-bottom:10px}.skm-library-actions{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;margin-bottom:16px}.skm-library-actions>button{width:100%;min-width:0}
.skm-skill-row,.skm-collection{background:var(--skm-surface);border:1px solid var(--skm-line);border-radius:11px;padding:11px 12px;margin:0}.skm-skill-row,.skm-collection-bar{display:grid;grid-template-columns:minmax(0,1fr) 42px 42px;align-items:center;gap:12px}.skm-collection-bar{flex-wrap:nowrap}.skm-collection-name{display:flex;flex-direction:column;align-items:flex-start;gap:0;min-width:0;min-height:32px;padding:0;line-height:1.5}.skm-collection-name .skm-tags{align-items:center;gap:7px}.skm-collection-name .skm-tag{background:var(--skm-bg)}.skm-collection-more>.skm-inline-actions{grid-column:1/-1;flex-basis:auto;padding-top:10px}.skm-collection-more:not([open])>.skm-inline-actions{display:none}.skm-collection-members{padding:10px 0 0;margin-top:10px;border-top:1px solid var(--skm-line)}.skm-collection-members .skm-skill-row{background:var(--skm-bg);margin:0}.skm-toggle[aria-checked=mixed]{background:var(--skm-tint);border-color:var(--skm-brand)}.skm-toggle[aria-checked=mixed] .skm-toggle-dot{background:var(--skm-brand);margin-inline:auto}
.skm-name{line-height:1.5}
.skm-refresh-dock{display:flex;justify-content:flex-end;align-items:center;flex-shrink:0;min-height:58px;padding:6px 22px 10px;background:var(--skm-bg)}.skm-refresh-fab{width:40px;height:40px;border:1px solid var(--skm-line);border-radius:50%;background:var(--skm-surface);color:var(--skm-brand);box-shadow:0 3px 10px #0002}.skm-library-scroll .skm-empty{margin-top:12px}.skm-collection-name:focus-visible{outline:2px solid var(--skm-brand);outline-offset:3px}
@media(max-width:600px){.skm-page{padding:16px}.skm-library-scroll{padding:16px 16px 8px}.skm-body>.skm-success{margin:10px 16px 0}.skm-refresh-dock{padding:6px 16px 10px}.skm-skill-row,.skm-collection{padding:10px}.skm-skill-row,.skm-collection-bar{gap:8px}.skm-collection-name{min-width:0}.skm-collection-members{padding-left:0}.skm-library-actions{gap:8px}}

/* Single-item actions stay adjacent and vertically centered; no inline body editor. */
.skm-skill-row{grid-template-columns:minmax(0,1fr) auto;align-items:center}.skm-skill-row>.skm-row-copy{grid-column:1;grid-row:1;align-self:center}.skm-skill-actions{grid-column:2;grid-row:1;display:flex;align-items:center;gap:4px;flex-shrink:0}.skm-skill-actions>.skm-toggle{margin-right:5px}.skm-skill-actions>.skm-icon-btn{width:32px;height:32px}.skm-skill-actions>.skm-danger{color:var(--skm-danger)}.skm-collection-more-button{display:grid;place-items:center;min-height:32px;padding:5px 4px;border:0;border-radius:6px;background:transparent;color:var(--skm-muted);font-size:12px}.skm-collection-tools{padding-top:7px;justify-content:flex-end}
@media(hover:hover) and (pointer:fine){.skm-collection-more-button:hover{background:var(--skm-bg);color:var(--skm-text)}}
@media(max-width:420px){.skm-skill-row{grid-template-columns:minmax(0,1fr);gap:8px}.skm-skill-actions{grid-column:1;grid-row:2;justify-self:end}.skm-collection-tools{justify-content:flex-start}.skm-skill-actions>.skm-icon-btn{width:36px;height:36px}}
/* Collection editing has one independent scroll region and an always-visible footer. */
.skm-modal-layer{position:fixed;z-index:2147483001;display:flex;align-items:center;justify-content:center;padding:16px;background:#0006;pointer-events:auto;overscroll-behavior:contain}
.skm-collection-dialog{position:relative;z-index:auto;width:520px;max-width:100%;max-height:100%;min-height:0;margin:auto;box-shadow:0 24px 80px #0005}
.skm-dialog-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--skm-line);flex-shrink:0}.skm-dialog-header .skm-section-title{margin:0}
.skm-collection-form{display:flex;flex-direction:column;min-height:0;overflow:hidden}.skm-dialog-scroll{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;padding:20px}.skm-dialog-scroll .skm-members{max-height:none;overflow:visible;min-width:0;margin:0}.skm-dialog-scroll .skm-check{align-items:flex-start}.skm-dialog-scroll .skm-check input{margin-top:6px}.skm-dialog-scroll .skm-check span{min-width:0}
.skm-dialog-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--skm-line);background:var(--skm-bg);flex-shrink:0}
.skm-inline-rename{min-width:0;width:100%}.skm-rename-controls{display:flex;gap:3px;align-items:center;min-width:0}.skm-rename-controls>.skm-input{min-width:0;flex:1;width:0;padding:6px 8px}.skm-rename-controls>.skm-icon-btn{width:28px;height:32px}.skm-inline-rename .skm-error{margin:8px 0 0;padding:6px 8px}
.skm-collection-bar{grid-template-columns:minmax(0,1fr) auto}.skm-collection-copy{min-width:0}.skm-collection-copy>.skm-collection-name{width:100%;min-height:0}.skm-collection-copy .skm-tags{align-items:center}.skm-collection-copy .skm-tag{background:var(--skm-bg)}.skm-collection-actions{display:flex;align-items:center;gap:4px}.skm-collection-actions>.skm-toggle{margin-right:5px}.skm-collection-actions>.skm-danger{color:var(--skm-danger)}.skm-collection-actions>.skm-collection-more-button{min-width:34px}.skm-collection-tools{padding-top:0}
@media(max-width:600px){.skm-skill-row:has(.skm-inline-rename),.skm-collection-bar:has(.skm-inline-rename){grid-template-columns:minmax(0,1fr)}.skm-skill-row:has(.skm-inline-rename)>.skm-skill-actions,.skm-collection-bar:has(.skm-inline-rename)>.skm-collection-actions{grid-column:1;grid-row:2;justify-self:end}}
@media(max-width:420px){.skm-collection-bar{grid-template-columns:minmax(0,1fr);gap:8px}.skm-collection-actions{justify-self:end}.skm-modal-layer{padding:10px}.skm-dialog-header{padding:12px 14px}.skm-dialog-scroll{padding:14px}.skm-dialog-footer{padding:10px 14px}}
@media(max-height:420px){.skm-header{padding-block:8px}.skm-tabs{padding-bottom:8px}.skm-refresh-dock{min-height:48px;padding-block:4px}.skm-footer{padding-block:6px}.skm-modal-layer{padding:8px}.skm-dialog-header{padding-block:8px}.skm-dialog-scroll{padding-block:10px}.skm-dialog-footer{padding-block:8px}}
@media(prefers-reduced-motion:reduce){.skm-panel button,.skm-trigger{transition:none}.skm-panel button:active:not(:disabled),.skm-trigger:active{transform:none}}
`
}

function combineSignals(...signals) {
  const valid = signals.filter(Boolean)
  if (valid.length === 1) return valid[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(valid)
  const controller = new AbortController()
  const abort = () => { controller.abort(); valid.forEach(signal => signal.removeEventListener('abort', abort)) }
  valid.forEach(signal => signal.aborted ? abort() : signal.addEventListener('abort', abort, { once: true }))
  return controller.signal
}

const runtimeRestartHint = '请正常退出并重新打开当前桌面应用；仅刷新页面不会重载旧服务。'
function supportsRuntime(runtime, capability) {
  return Number.isSafeInteger(runtime?.apiVersion) && runtime.apiVersion >= 2 && runtime.capabilities?.[capability] === true && (capability !== 'contentEdit' || runtime.capabilities?.sha256CAS === true)
}
async function api(method, path, body, signal) {
  // Probe the live host, not the on-disk package: old cached services must fail closed.
  const capability = method === 'PATCH' && path.startsWith('/library/skills/') && typeof body?.content === 'string' ? 'contentEdit' : method === 'POST' && path === '/import/commit' ? 'exclusiveBundleImport' : null
  if (capability) {
    const authority = await api('GET', '/library', undefined, signal)
    if (!supportsRuntime(authority.runtime, capability)) throw new Error('当前宿主尚未确认新版' + (capability === 'contentEdit' ? '技能编辑与 SHA-256 CAS' : '安全导入发布') + '能力。' + runtimeRestartHint)
  }
  const res = await fetch(API + path, { method, signal, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const data = await res.json().catch(() => ({}))
  if (signal?.aborted) throw new DOMException('面板已关闭', 'AbortError')
  if (!res.ok || data.error) {
    const message = res.status === 403 ? '宿主拒绝此操作（403），请检查权限；此次更改未确认生效。' : res.status === 503 ? '宿主技能服务暂不可用（503）；此次更改未确认生效，请稍后重试。' : res.status === 401 ? '登录已失效，请刷新 DSH 后重试。' : ''
    const backendMessage = typeof data.error === 'string' ? data.error : data.error?.message
    const reason = typeof data.reason === 'string' ? data.reason : backendMessage
    const detail = backendMessage || reason
    const error = new Error(message ? message + (detail ? ' ' + detail : '') : detail || ('请求失败（HTTP ' + res.status + '）'))
    error.status = res.status
    error.code = typeof data.code === 'string' ? data.code : typeof data.error?.code === 'string' ? data.error.code : typeof data.diagnostic?.code === 'string' ? data.diagnostic.code : undefined
    error.reason = reason
    error.backendMessage = backendMessage
    const diagnostic = data.diagnostic
    if (diagnostic && typeof diagnostic === 'object') {
      const details = [diagnostic.code, diagnostic.operation, diagnostic.runtime?.pluginVersion && ('宿主 v' + diagnostic.runtime.pluginVersion)].filter(value => typeof value === 'string' && value)
      if (details.length) error.message += '（' + details.join(' · ') + '）'
    }
    throw error
  }
  return data
}
const aborted = e => e?.name === 'AbortError'
const titleOf = s => s.displayName || s.name || s.id
function ErrorMessage({ message }) {
  return message ? h('div', { className: 'skm-error', role: 'alert' }, h(Icon, { name: 'alert', size: 16 }), h('span', null, message)) : null
}
function Field({ id, label, hint, optional, multiline, value, onChange, placeholder, disabled }) {
  return h('div', { className: 'skm-field' },
    h('label', { htmlFor: id }, label, optional ? h('span', null, '可选') : null),
    h(multiline ? 'textarea' : 'input', { id, className: multiline ? 'skm-textarea' : 'skm-input', value, placeholder, disabled, spellCheck: false, required: !optional, 'aria-describedby': hint ? id + '-hint' : undefined, onChange: e => onChange(e.target.value) }),
    hint ? h('small', { id: id + '-hint' }, hint) : null)
}
function Check({ mixed, checked, onChange, disabled, label }) {
  const ref = useRef(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!mixed }, [mixed])
  return h('label', { className: 'skm-check' }, h('input', { ref, type: 'checkbox', checked, disabled, 'aria-checked': mixed ? 'mixed' : !!checked, onChange }), h('span', null, label))
}
function Toggle({ checked, mixed = false, disabled, onClick, label }) {
  // Collections remain shared skill references; the mixed bulk control is a checkbox,
  // since ARIA switches cannot represent a partially selected state.
  return h('button', { type: 'button', role: mixed ? 'checkbox' : 'switch', className: 'skm-toggle', 'aria-checked': mixed ? 'mixed' : !!checked, 'aria-label': label, disabled, onClick }, h('span', { className: 'skm-toggle-dot' }), h('span', { className: 'skm-sr' }, mixed ? '部分开启' : checked ? '已开启' : '已关闭'))
}
function validActivation(data) {
  return !!data && Array.isArray(data.skillIds) && data.skillIds.every(id => typeof id === 'string') && Number.isSafeInteger(data.revision) && data.revision >= 0
}
function activationRevisionConflict(error) {
  if (error.status !== 409) return false
  if (error.code) return error.code === 'ACTIVATION_REVISION_CONFLICT'
  // Older hosts had no typed code. Match only the exact revision error, never
  // source/body/unavailable errors that happen to use the same HTTP status.
  return (error.backendMessage || error.reason || error.message) === '技能开关已在其他窗口更改，请刷新重试'
}

// Keep IME-confirming Enter/Escape local, including engines that omit isComposing.
const composingKey = (event, composing) => composing || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229 || event.nativeEvent?.keyCode === 229
function InlineRename({ draft, busy, error, onChange, onSave, onCancel }) {
  const inputRef = useRef(null), composing = useRef(false)
  useLayoutEffect(() => { if (document.hasFocus()) { inputRef.current?.focus({ preventScroll: true }); inputRef.current?.select() } }, [])
  return h('form', { className: 'skm-inline-rename', 'aria-label': draft.type === 'collection' ? '重命名集合' : '重命名技能', 'aria-busy': busy,
    onSubmit: e => { e.preventDefault(); if (!composing.current && !busy) onSave() },
    onKeyDown: e => {
      if (!['Enter', 'Escape'].includes(e.key)) return
      e.stopPropagation()
      if (composingKey(e, composing.current)) { if (e.key === 'Enter') e.preventDefault(); return }
      if (e.key === 'Escape') { e.preventDefault(); if (!busy) onCancel() }
    } },
    h('div', { className: 'skm-rename-controls' }, h('input', { ref: inputRef, className: 'skm-input', 'aria-label': '新名称', value: draft.displayName, readOnly: busy, spellCheck: false, onChange: e => onChange(e.target.value), onCompositionStart: () => { composing.current = true }, onCompositionEnd: () => { composing.current = false } }),
      h('button', { className: 'skm-icon-btn', type: 'submit', disabled: busy, title: '保存名称', 'aria-label': '保存名称', onClick: e => { if (composing.current) e.preventDefault() } }, h(Icon, { name: 'check', size: 17 })),
      h('button', { className: 'skm-icon-btn', type: 'button', disabled: busy, title: '取消重命名', 'aria-label': '取消重命名', onClick: () => { if (!composing.current) onCancel() } }, h(Icon, { name: 'close', size: 17 }))),
    h(ErrorMessage, { message: error }))
}

function CollectionDialog({ target, draft, skills, busy, error, onChange, onSave, onCancel, returnFocus }) {
  const layerRef = useRef(null), dialogRef = useRef(null), composing = useRef(false)
  const callbacks = useRef(null); callbacks.current = { busy, onCancel }
  const [viewport, setViewport] = useState(() => ({ left: window.visualViewport?.offsetLeft || 0, top: window.visualViewport?.offsetTop || 0, width: window.visualViewport?.width || window.innerWidth, height: window.visualViewport?.height || window.innerHeight }))
  useLayoutEffect(() => {
    const layer = layerRef.current, dialog = dialogRef.current
    if (!layer || !dialog) return
    const panel = target.querySelector('.skm-panel'), previousMarker = panel?.getAttribute('data-skm-modal')
    panel?.setAttribute('data-skm-modal', 'true')
    // Move focus before hiding the old focused subtree from accessibility APIs.
    if (document.hasFocus()) (dialog.querySelector('input') || dialog).focus({ preventScroll: true })
    // Isolate siblings all the way through the ShadowRoot to document.body.
    // Restore exact prior attributes; never clear another dialog's inert state.
    const isolated = []
    for (let node = layer; node && node !== document.body;) {
      const parent = node.parentNode
      if (!parent) break
      for (const sibling of Array.from(parent.children || [])) {
        if (sibling === node || ['STYLE', 'SCRIPT', 'LINK'].includes(sibling.tagName)) continue
        isolated.push([sibling, sibling.getAttribute('inert'), sibling.getAttribute('aria-hidden')])
        sibling.setAttribute('inert', ''); sibling.setAttribute('aria-hidden', 'true')
      }
      node = parent.host || parent
    }
    const focusables = () => Array.from(dialog.querySelectorAll('button,input,textarea,select,a[href],[tabindex]')).filter(el => !el.disabled && !el.closest('[hidden],[inert]') && el.tabIndex >= 0 && el.getClientRects().length)
    const keydown = e => {
      if (!e.composedPath().includes(layer)) return
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        if (composingKey(e, composing.current)) return
        e.preventDefault(); if (!callbacks.current.busy) callbacks.current.onCancel()
      } else if (e.key === 'Tab' && !composingKey(e, composing.current)) {
        const elements = focusables(), index = elements.indexOf(deepestActiveElement())
        if (!elements.length) { e.preventDefault(); dialog.focus() }
        else if (e.shiftKey && index <= 0) { e.preventDefault(); elements[elements.length - 1].focus() }
        else if (!e.shiftKey && (index === -1 || index === elements.length - 1)) { e.preventDefault(); elements[0].focus() }
      } else if (e.key === 'Enter' && composingKey(e, composing.current)) e.preventDefault()
    }
    const resize = () => setViewport({ left: window.visualViewport?.offsetLeft || 0, top: window.visualViewport?.offsetTop || 0, width: window.visualViewport?.width || window.innerWidth, height: window.visualViewport?.height || window.innerHeight })
    document.addEventListener('keydown', keydown, true)
    window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize); window.visualViewport?.addEventListener('scroll', resize)
    return () => {
      const active = deepestActiveElement(), restore = document.hasFocus() && (layer.contains(active) || active === document.body)
      document.removeEventListener('keydown', keydown, true)
      window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('scroll', resize)
      for (const [node, inert, hidden] of isolated) {
        if (inert === null) node.removeAttribute('inert'); else node.setAttribute('inert', inert)
        if (hidden === null) node.removeAttribute('aria-hidden'); else node.setAttribute('aria-hidden', hidden)
      }
      if (panel) { if (previousMarker === null) panel.removeAttribute('data-skm-modal'); else panel.setAttribute('data-skm-modal', previousMarker) }
      if (restore) restoreFocusWhenReady(() => returnFocus, active, target.host)
    }
  }, [])
  return createPortal(h('div', { className: 'skm-modal-layer', ref: layerRef, style: viewport },
    h('section', { ref: dialogRef, className: 'skm-panel skm-collection-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'skm-collection-dialog-title', tabIndex: -1,
      onCompositionStart: () => { composing.current = true }, onCompositionEnd: () => { composing.current = false } },
      h('header', { className: 'skm-dialog-header' }, h('h3', { id: 'skm-collection-dialog-title', className: 'skm-section-title' }, draft.id ? '编辑集合' : '新建集合'), h('button', { type: 'button', className: 'skm-icon-btn', disabled: busy, 'aria-label': '关闭集合编辑', onClick: () => { if (!composing.current) onCancel() } }, h(Icon, { name: 'close' }))),
      h('form', { className: 'skm-collection-form', 'aria-busy': busy, onSubmit: e => { e.preventDefault(); if (!busy && !composing.current) onSave() } },
        h('div', { className: 'skm-dialog-scroll' }, h(ErrorMessage, { message: error }),
          h('div', { className: 'skm-field' }, h('label', { htmlFor: 'skm-edit-name' }, '显示名称'), h('input', { id: 'skm-edit-name', className: 'skm-input', value: draft.displayName, readOnly: busy, spellCheck: false, onChange: e => onChange({ ...draft, displayName: e.target.value }), 'aria-describedby': 'skm-collection-name-hint' }), h('small', { id: 'skm-collection-name-hint' }, '支持中文，不改变内部标识。')),
          h('fieldset', { className: 'skm-members', disabled: busy }, h('legend', null, '集合成员'), skills.length ? skills.map(s => h(Check, { key: s.id, label: titleOf(s), checked: draft.skillIds.includes(s.id), onChange: e => onChange({ ...draft, skillIds: e.target.checked ? [...new Set([...draft.skillIds, s.id])] : draft.skillIds.filter(id => id !== s.id) }) })) : h('p', { className: 'skm-hint' }, '还没有技能，可保存空集合。'))),
        h('footer', { className: 'skm-dialog-footer' }, h('button', { className: 'skm-secondary', type: 'button', disabled: busy, onClick: () => { if (!composing.current) onCancel() } }, '取消'), h('button', { className: 'skm-primary', type: 'submit', disabled: busy, onClick: e => { if (composing.current) e.preventDefault() } }, busy ? '保存中…' : '保存'))))), target)
}

function LibraryTab({ request: panelRequest, sessionId, refreshKey, onNavigate, onActivation, registerGuard }) {
  const [library, setLibrary] = useState(null), [loading, setLoading] = useState(true)
  const [query, setQuery] = useState(''), [error, setError] = useState('')
  const [activationError, setActivationError] = useState(''), [activation, setActivation] = useState(null)
  const [locks, setLocks] = useState({}), [reload, setReload] = useState(0)
  const [editor, setEditor] = useState(null), [formError, setFormError] = useState('')
  const [rename, setRename] = useState(null), [renameError, setRenameError] = useState('')
  const pageRef = useRef(null), editorTrigger = useRef(null), renameTrigger = useRef(null), renameState = useRef(null)
  renameState.current = rename
  const [expanded, setExpanded] = useState({}), [savedNotice, setSavedNotice] = useState('')
  const actRef = useRef(null), lockRef = useRef(new Set()), queue = useRef(Promise.resolve())
  const readSeq = useRef(0), actSeq = useRef(0), lifetime = useRef(null), mounted = useRef(false)
  if (!lifetime.current) lifetime.current = new AbortController()
  const request = (method, path, body, signal) => panelRequest(method, path, body, combineSignals(lifetime.current.signal, signal))
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++readSeq.current; ++actSeq.current; lifetime.current.abort() } }, [])
  const locked = key => !!locks[key]
  const acquire = keys => {
    if (!mounted.current || keys.some(key => lockRef.current.has(key))) return false
    keys.forEach(key => lockRef.current.add(key)); setLocks(Object.fromEntries([...lockRef.current].map(key => [key, true]))); return true
  }
  const release = keys => { keys.forEach(key => lockRef.current.delete(key)); if (mounted.current) setLocks(Object.fromEntries([...lockRef.current].map(key => [key, true]))) }
  const publish = data => { actRef.current = data; setActivation(data); onActivation(data) }
  const invalidate = message => { if (!mounted.current) return; actRef.current = null; setActivation(null); onActivation(null); setActivationError(message) }
  const readActivation = async signal => {
    const seq = ++actSeq.current
    const data = await request('GET', '/activation?sessionId=' + encodeURIComponent(sessionId), undefined, signal)
    if (!validActivation(data)) throw new Error('宿主未提供有效会话开关状态。')
    if (mounted.current && seq === actSeq.current && !signal?.aborted) { publish(data); setActivationError(data.available === false ? data.reason || '当前宿主暂不可用。已选技能不代表正在执行。' : '') }
    return data
  }
  useEffect(() => {
    const controller = new AbortController(), seq = ++readSeq.current
    setError(''); setLoading(true)
    request('GET', '/library', undefined, controller.signal).then(data => {
      if (mounted.current && seq === readSeq.current) setLibrary({ skills: data.skills || [], collections: data.collections || [], root: data.root, runtime: data.runtime })
    }).catch(e => { if (!aborted(e) && mounted.current && seq === readSeq.current) setError(e.message) }).finally(() => { if (mounted.current && seq === readSeq.current) setLoading(false) })
    return () => { ++readSeq.current; controller.abort() }
  }, [refreshKey, reload])
  useEffect(() => {
    const controller = new AbortController()
    readActivation(controller.signal).catch(e => { if (!aborted(e)) invalidate(e.message) })
    return () => { ++actSeq.current; controller.abort() }
  }, [sessionId])
  const applyActivation = (ids, enabled, clear = false) => {
    const unique = [...new Set(ids)], keys = clear ? ['activation-read'] : unique.map(id => 'act:' + id)
    if ((!unique.length && !clear) || !actRef.current || lockRef.current.has('activation-read') || (clear && [...lockRef.current].some(key => key.startsWith('act:'))) || !acquire(keys)) return
    setActivationError('')
    const operation = async () => {
      if (!mounted.current) return
      try {
        const previous = actRef.current
        if (!previous) throw new Error('会话状态不可用，请重新读取。')
        const next = clear ? new Set() : new Set(previous.skillIds)
        unique.forEach(id => enabled ? next.add(id) : next.delete(id))
        const result = await request('POST', '/activation', { sessionId, skillIds: [...next], expectedRevision: previous.revision })
        if (!validActivation(result) || (result.available === false && !clear)) throw new Error(result.reason || '宿主未确认开关结果，请刷新状态。')
        if (mounted.current) { ++actSeq.current; publish(result) }
      } catch (e) {
        if (aborted(e) || !mounted.current) return
        if (e.status === 409) {
          const revisionConflict = activationRevisionConflict(e)
          const originalReason = e.message || e.reason || '宿主拒绝本次开关操作。'
          const failure = revisionConflict ? originalReason + ' 会话开关版本已更新，本次操作未生效。' : originalReason + ' 本次开关操作未生效；请先处理上述原因，不要重复开启。'
          try {
            await readActivation()
            if (mounted.current) setActivationError(failure + (revisionConflict ? ' 已同步最新开关，请重新操作。' : ' 已读取当前开关状态。'))
          } catch (refreshError) {
            if (!aborted(refreshError)) invalidate(failure + ' 刷新状态失败：' + refreshError.message)
          }
        } else invalidate((e.message || e.reason || '宿主拒绝本次开关操作。') + ' 本次开关操作未确认生效。')
      } finally { release(keys) }
    }
    queue.current = queue.current.then(operation, operation)
  }
  const activate = (ids, enabled) => applyActivation(ids, enabled)
  const refreshLibrary = async () => {
    // Do not race a CAS mutation with a stale authority read; leave editor drafts intact.
    if ([...lockRef.current].some(key => key.startsWith('act:')) || !acquire(['activation-read'])) return
    setReload(n => n + 1)
    try { await readActivation() } catch (e) { if (!aborted(e)) invalidate(e.message) } finally { release(['activation-read']) }
  }
  const mutate = async (key, method, path, body, closeEditor = false) => {
    if (!acquire([key])) return
    if (closeEditor) setFormError(''); else setError('')
    try {
      await request(method, path, body)
      if (!mounted.current) return
      if (closeEditor) setEditor(null)
      setReload(n => n + 1)
      if (method === 'DELETE' && path.startsWith('/library/skills/')) await readActivation()
    } catch (e) { if (!aborted(e) && mounted.current) { (closeEditor ? setFormError : setError)(e.message); if (method === 'DELETE') invalidate('删除结果未确认，请刷新会话状态。') } } finally { release([key]) }
  }
  const editorState = useRef(null)
  editorState.current = editor
  // Explicit save/cancel owns draft disposal. Background navigation never silently
  // drops an inline edit, nor invokes a native confirm while an IME is active.
  const leaveForm = () => {
    if (editorState.current) return false
    if (renameState.current) { setRenameError('请先保存或取消当前名称修改。'); return false }
    return true
  }
  const formGuard = useRef(leaveForm); formGuard.current = leaveForm
  useEffect(() => { registerGuard(() => formGuard.current()); return () => registerGuard(null) }, [])
  const openEditor = (value, trigger) => { if (!leaveForm()) return; editorTrigger.current = trigger || deepestActiveElement(); setFormError(''); setEditor(value) }
  const saveEditor = () => {
    const value = editorState.current
    if (!value || !value.displayName.trim()) { setFormError('请输入名称，可使用中文。'); return }
    const key = value.id ? 'collection:' + value.id : 'collection:new'
    mutate(key, value.id ? 'PATCH' : 'POST', '/collections' + (value.id ? '/' + encodeURIComponent(value.id) : ''), { displayName: value.displayName.trim(), skillIds: value.skillIds }, true)
  }
  const cancelEditor = () => {
    const value = editorState.current
    if (!value || lockRef.current.has(value.id ? 'collection:' + value.id : 'collection:new')) return
    setEditor(null); setFormError('')
  }
  const beginRename = (item, type, context, trigger) => {
    if (renameState.current || editorState.current || lockRef.current.has(type + ':' + item.id)) return
    renameTrigger.current = trigger || deepestActiveElement(); setRenameError('')
    setRename({ type, id: item.id, context, displayName: titleOf(item) })
  }
  const finishRename = () => {
    const active = deepestActiveElement(), restore = document.hasFocus() && !!active?.closest?.('.skm-inline-rename')
    setRename(null); setRenameError('')
    // The launch icon stays mounted; do not restore after focus moved elsewhere.
    if (restore) restoreFocusWhenReady(() => renameTrigger.current, active, pageRef.current?.getRootNode().host)
  }
  const cancelRename = () => {
    const value = renameState.current
    if (value && !lockRef.current.has(value.type + ':' + value.id)) finishRename()
  }
  const saveRename = async () => {
    const value = renameState.current
    if (!value) return
    const displayName = value.displayName.trim(), key = value.type + ':' + value.id
    if (!displayName) { setRenameError('请输入名称，可使用中文。'); return }
    if (!acquire([key])) return
    setRenameError('')
    try {
      const result = await request('PATCH', (value.type === 'collection' ? '/collections/' : '/library/skills/') + encodeURIComponent(value.id), { displayName })
      if (!mounted.current) return
      const savedName = (value.type === 'collection' ? result?.collection?.displayName : result?.skill?.displayName) || displayName
      ++readSeq.current // An older library GET must not undo the successful name.
      setLibrary(previous => previous ? { ...previous, [value.type === 'collection' ? 'collections' : 'skills']: previous[value.type === 'collection' ? 'collections' : 'skills'].map(item => item.id === value.id ? { ...item, displayName: savedName } : item) } : previous)
      finishRename(); setReload(n => n + 1)
    } catch (e) { if (!aborted(e) && mounted.current) setRenameError(e.message) }
    finally { release([key]) }
  }
  const renameField = (item, type, context) => rename?.id === item.id && rename.type === type && rename.context === context ? h(InlineRename, { draft: rename, busy: locked(type + ':' + item.id), error: renameError, onChange: displayName => setRename(previous => ({ ...previous, displayName })), onSave: saveRename, onCancel: cancelRename }) : null
  const skills = library?.skills || [], collections = library?.collections || [], activeIds = new Set(activation?.skillIds || [])
  const q = query.trim().toLocaleLowerCase(), matches = s => [titleOf(s), s.name, s.description].join(' ').toLocaleLowerCase().includes(q)
  // Membership is derived from the entire library, not the filtered collections.
  // A shared skill can appear in multiple collections, but never again outside them.
  const collectedIds = new Set(collections.flatMap(c => c.skillIds))
  const filtered = skills.filter(s => !collectedIds.has(s.id) && matches(s)), actionBusy = Object.keys(locks).some(key => key.startsWith('act:'))
  const switchesDisabled = !activation || activation.available === false || locked('activation-read')
  const openSupported = supportsRuntime(library?.runtime, 'localFileOpen')
  const openFile = async s => {
    const key = 'skill:' + s.id
    if (!openSupported || !acquire([key])) return
    setError(''); setSavedNotice('')
    try {
      const result = await request('POST', '/library/skills/' + encodeURIComponent(s.id) + '/open')
      if (result?.opened !== true) throw new Error('宿主未确认文件打开请求。')
      if (mounted.current) setSavedNotice('已请求本机默认程序打开「' + titleOf(s) + '」。编辑并保存后，请刷新技能库。')
    } catch (e) { if (!aborted(e) && mounted.current) setError('无法打开本地文件：' + e.message) }
    finally { release([key]) }
  }
  const iconButton = (name, label, disabled, onClick, danger = false, title = label) => h('button', { type: 'button', className: 'skm-icon-btn' + (danger ? ' skm-danger' : ''), 'aria-label': label, title, disabled, onClick }, h(Icon, { name, size: 17 }))
  const skillRow = (s, context = 'all') => h('article', { className: 'skm-row skm-skill-row', key: context + ':' + s.id, 'aria-label': titleOf(s), 'aria-busy': locked('act:' + s.id) || locked('skill:' + s.id) },
    h('div', { className: 'skm-row-copy', title: s.description || undefined }, renameField(s, 'skill', context) || h('h3', { className: 'skm-name' }, titleOf(s))),
    h('div', { className: 'skm-skill-actions', role: 'group', 'aria-label': titleOf(s) + ' 的操作' },
      h(Toggle, { checked: activeIds.has(s.id), disabled: switchesDisabled || locked('act:' + s.id) || locked('skill:' + s.id), label: '在当前会话启用 ' + titleOf(s), onClick: () => activate([s.id], !activeIds.has(s.id)) }),
      iconButton('file', '打开本地文件 ' + titleOf(s), !openSupported || locked('skill:' + s.id), () => openFile(s), false, openSupported ? '用本机默认程序打开技能文件进行编辑' : runtimeRestartHint),
      iconButton('rename', '重命名 ' + titleOf(s), !!rename || !!editor || locked('skill:' + s.id), e => beginRename(s, 'skill', context, e.currentTarget)),
      iconButton('trash', '删除 ' + titleOf(s), !!editor || !!rename || locked('skill:' + s.id) || locked('act:' + s.id), () => { if (window.confirm('删除技能「' + titleOf(s) + '」及本地资源？所有集合中的此技能都会移除，此操作无法撤销。')) mutate('skill:' + s.id, 'DELETE', '/library/skills/' + encodeURIComponent(s.id)) }, true)))
  const filteredCollections = collections.filter(c => titleOf(c).toLocaleLowerCase().includes(q) || skills.some(s => c.skillIds.includes(s.id) && matches(s)))
  return h('div', { ref: pageRef, className: 'skm-library-page', 'aria-busy': loading }, h('div', { className: 'skm-library-scroll' },
    h('div', { className: 'skm-toolbar' }, h('div', { className: 'skm-search-wrap' }, h(Icon, { name: 'search' }), h('input', { type: 'search', className: 'skm-input', 'aria-label': '搜索技能或集合', placeholder: '搜索技能或集合…', value: query, readOnly: !!rename, onChange: e => setQuery(e.target.value) }))),
    h('div', { className: 'skm-library-actions', role: 'group', 'aria-label': '技能库操作' },
      h('button', { type: 'button', className: 'skm-secondary', disabled: !activation || !activeIds.size || actionBusy || locked('activation-read') || (activation.available === false && !activation.canDisable), onClick: () => applyActivation([], false, true) }, '全部关闭'),
      h('button', { type: 'button', className: 'skm-secondary', disabled: !!editor || !!rename || loading, onClick: e => openEditor({ type: 'collection', displayName: '', skillIds: [] }, e.currentTarget) }, h(Icon, { name: 'plus', size: 16 }), '新建集合')),
    h(ErrorMessage, { message: error }), h(ErrorMessage, { message: activationError }),
    library && !openSupported ? h(ErrorMessage, { message: '当前运行宿主尚未确认本地文件打开能力；技能列表和会话开关仍可使用。' + runtimeRestartHint }) : null,
    savedNotice ? h('div', { className: 'skm-success', role: 'status' }, h('span', null, savedNotice), h('button', { className: 'skm-icon-btn', 'aria-label': '关闭提示', onClick: () => setSavedNotice('') }, h(Icon, { name: 'close', size: 14 }))) : null,

    library === null ? h('div', { className: 'skm-empty', role: 'status' }, error ? '读取失败，请使用右下角刷新重试。' : '正在读取技能库…') : h('div', { className: 'skm-list', 'aria-label': '全部技能列表' }, filteredCollections.map(c => {
      const members = skills.filter(s => c.skillIds.includes(s.id)), ids = members.map(s => s.id), count = ids.filter(id => activeIds.has(id)).length
      const busy = locked('collection:' + c.id) || ids.some(id => locked('act:' + id) || locked('skill:' + id)), isOpen = !!expanded[c.id]
      return h('article', { className: 'skm-collection', key: c.id, 'aria-busy': busy },
        h('div', { className: 'skm-collection-bar' },
          h('div', { className: 'skm-collection-copy' }, renameField(c, 'collection', c.id) || h('button', { type: 'button', className: 'skm-collection-name', disabled: !!rename, 'aria-expanded': isOpen, 'aria-controls': 'skm-members-' + c.id, onClick: () => setExpanded(value => ({ ...value, [c.id]: !value[c.id] })) }, h('span', { className: 'skm-name' }, c.displayName)),
            h('span', { className: 'skm-tags' }, h('span', { className: 'skm-tag' }, '集合'), h('span', { className: 'skm-member-count' }, members.length + ' 个技能'))),
          h('div', { className: 'skm-collection-actions', role: 'group', 'aria-label': c.displayName + ' 的快捷操作' },
            h(Toggle, { label: '启用集合 ' + c.displayName, checked: !!ids.length && count === ids.length, mixed: count > 0 && count < ids.length, disabled: switchesDisabled || !ids.length || busy, onClick: () => activate(ids, count !== ids.length) }),
            iconButton('rename', '重命名集合 ' + c.displayName, busy || !!rename || !!editor, e => beginRename(c, 'collection', c.id, e.currentTarget)),
            iconButton('trash', '删除集合 ' + c.displayName, busy || !!rename || !!editor, () => { if (window.confirm('删除集合「' + c.displayName + '」？技能及会话开关会保留。')) mutate('collection:' + c.id, 'DELETE', '/collections/' + encodeURIComponent(c.id)) }, true),
            h('button', { type: 'button', className: 'skm-collection-more-button', disabled: !!rename, 'aria-label': c.displayName + ' 的更多操作', 'aria-expanded': isOpen, 'aria-controls': 'skm-members-' + c.id, onClick: () => setExpanded(value => ({ ...value, [c.id]: !value[c.id] })) }, isOpen ? '收起' : '更多'))),
        isOpen ? h('div', { className: 'skm-list skm-collection-members', id: 'skm-members-' + c.id },
          h('div', { className: 'skm-inline-actions skm-collection-tools', role: 'group', 'aria-label': c.displayName + ' 的集合操作' },
            h('button', { type: 'button', className: 'skm-secondary skm-compact', disabled: busy || !!rename || !!editor, onClick: e => openEditor({ type: 'collection', id: c.id, displayName: c.displayName, skillIds: [...c.skillIds] }, e.currentTarget) }, h(Icon, { name: 'folder', size: 15 }), '编辑集合')),
          members.length ? members.map(s => skillRow(s, c.id)) : h('p', { className: 'skm-hint' }, '空集合，可通过编辑集合添加技能。')) : null)

    }), filtered.map(s => skillRow(s))),
    library && !filtered.length && !filteredCollections.length ? h('div', { className: 'skm-empty' }, h('h3', null, q ? '没有匹配的技能或集合' : '从第一个技能开始'), h('div', { className: 'skm-empty-actions' }, h('button', { className: 'skm-secondary', onClick: () => onNavigate('import') }, '导入技能'), h('button', { className: 'skm-primary', onClick: () => onNavigate('create') }, '新建技能'))) : null),
    h('div', { className: 'skm-refresh-dock' }, h('button', { type: 'button', className: 'skm-icon-btn skm-refresh-fab', 'aria-label': '刷新技能库', title: '刷新技能库与当前会话开关', disabled: !!rename || !!editor || loading || actionBusy || locked('activation-read'), onClick: refreshLibrary }, h(Icon, { name: 'refresh', size: 19 }))),
    editor && pageRef.current ? h(CollectionDialog, { target: pageRef.current.getRootNode(), draft: editor, skills, error: formError, busy: locked(editor.id ? 'collection:' + editor.id : 'collection:new'), onChange: setEditor, onSave: saveEditor, onCancel: cancelEditor, returnFocus: editorTrigger.current }) : null)
}

async function fileBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let text = ''
  for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384))
  return btoa(text)
}
function ImportTab({ request, onDone }) {
  const [mode, setMode] = useState('files')
  const [paste, setPaste] = useState('')
  const [preview, setPreview] = useState(null)
  const [displayName, setDisplayName] = useState('')
  const [names, setNames] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [source, setSource] = useState('')
  const lock = useRef(false), dirRef = useRef(null), fileRef = useRef(null)
  const previewSource = async (bodyFactory, sourceName) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(''); setSource(sourceName)
    try {
      const result = await request('POST', '/import/preview', await bodyFactory())
      if (!result.token || !['skill', 'collection'].includes(result.kind) || !Array.isArray(result.skills) || !result.skills.length) throw new Error('导入预览没有返回可用技能，请检查所选文件。')
      setPreview(result); setDisplayName(result.suggestedName || sourceName); setNames(Object.fromEntries(result.skills.map(s => [s.candidateId, s.displayName || s.name || '新技能'])))
    } catch (e) { if (!aborted(e)) setError(e.message) } finally { lock.current = false; setBusy(false) }
  }
  const pickedDirectory = e => {
    const files = Array.from(e.target.files || []); e.target.value = ''
    if (!files.length) return
    const sourceName = files[0].webkitRelativePath.split('/')[0] || '技能文件夹'
    previewSource(async () => ({ sourceName, files: await Promise.all(files.map(async file => ({ path: file.webkitRelativePath || file.name, content: await fileBase64(file), encoding: 'base64' }))) }), sourceName)
  }
  const pickedFile = e => {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    previewSource(async () => /\.(zip|rar|7z)$/i.test(file.name) ? { archive: { fileName: file.name, content: await fileBase64(file) } } : { fileName: file.name, content: await file.text() }, file.name)
  }
  const commit = async e => {
    e.preventDefault()
    if (lock.current || !preview) return
    if (!displayName.trim() || Object.values(names).some(name => !name.trim())) { setError('请填写技能或集合名称，支持中文。'); return }
    lock.current = true; setBusy(true); setError('')
    try {
      const result = await request('POST', '/import/commit', { token: preview.token, displayName: displayName.trim(), names: Object.fromEntries(Object.entries(names).map(([id, name]) => [id, name.trim()])) })
      setPreview(null); setPaste(''); onDone(displayName, result.cleanupWarnings)
    } catch (e) { if (!aborted(e)) setError(e.message) } finally { lock.current = false; setBusy(false) }
  }
  return h('div', { 'aria-busy': busy }, h('h3', { className: 'skm-section-title' }, '先预览，再保存'), h('p', { className: 'skm-hint' }, '递归识别文件夹和 ZIP / RAR / 7z 内的技能。单技能自动导为技能，多技能自动导为集合；确认名称后才写入技能库。'), h(ErrorMessage, { message: error }),
    preview ? h('form', { onSubmit: commit }, h('div', { className: 'skm-note' }, h(Icon, { name: preview.kind === 'collection' ? 'folder' : 'file' }), h('span', null, '已识别为', preview.kind === 'collection' ? '多技能集合' : '单个技能', ' · ' + preview.skills.length + ' 个技能 · 来源：' + source)),
      h(Field, { id: 'skm-import-name', label: preview.kind === 'collection' ? '集合名称' : '技能名称', value: displayName, onChange: value => { setDisplayName(value); if (preview.kind === 'skill' && preview.skills.length === 1) setNames({ [preview.skills[0].candidateId]: value }) }, hint: '支持中文显示名称。', disabled: busy }),
      h('div', { className: 'skm-list' }, preview.skills.map(s => h('div', { key: s.candidateId, className: 'skm-editor' }, preview.kind === 'collection' ? h(Field, { id: 'skm-candidate-' + s.candidateId, label: '技能名称', value: names[s.candidateId] || '', onChange: value => setNames(previous => ({ ...previous, [s.candidateId]: value })), disabled: busy }) : h('h3', { className: 'skm-name' }, names[s.candidateId]), h('p', { className: 'skm-hint' }, s.description || '暂无描述')))),
      preview.warnings?.length ? h('div', { className: 'skm-note', role: 'status' }, h(Icon, { name: 'alert' }), h('div', null, h('strong', null, '导入提醒'), h('ul', null, preview.warnings.map((warning, i) => h('li', { key: i }, typeof warning === 'string' ? warning : warning.message || JSON.stringify(warning)))))) : null,
      h('div', { className: 'skm-form-actions' }, h('button', { type: 'button', className: 'skm-secondary', disabled: busy, onClick: () => { setPreview(null); setError('') } }, '返回选择'), h('button', { type: 'submit', className: 'skm-primary', disabled: busy }, busy ? '保存中…' : '确认导入'))) : h('div', null,
      h('div', { className: 'skm-segment', role: 'group', 'aria-label': '导入方式' }, ['files', 'paste'].map(value => h('button', { key: value, disabled: busy, 'aria-pressed': mode === value, onClick: () => setMode(value) }, value === 'files' ? '本地文件' : '粘贴 Markdown'))),
      mode === 'files' ? h('div', { className: 'skm-upload' }, h('div', { className: 'skm-upload-icon' }, h(Icon, { name: 'upload', size: 24 })), h('h3', null, busy ? '正在读取并预览…' : '选择文件夹或压缩包'), h('p', null, '保留所有子目录与附属资源，由宿主安全检查并识别。'), h('div', { className: 'skm-upload-actions' }, h('button', { className: 'skm-primary', disabled: busy, onClick: () => dirRef.current?.click() }, '选择文件夹'), h('button', { className: 'skm-secondary', disabled: busy, onClick: () => fileRef.current?.click() }, '选择压缩包 / Markdown'))) : h('form', { onSubmit: e => { e.preventDefault(); if (!paste.trim()) { setError('请粘贴技能 Markdown。'); return }; previewSource(async () => ({ fileName: 'SKILL.md', content: paste }), '粘贴内容') } }, h(Field, { id: 'skm-import-paste', label: '技能 Markdown', multiline: true, value: paste, onChange: setPaste, disabled: busy }), h('button', { className: 'skm-primary', type: 'submit', disabled: busy }, busy ? '预览中…' : '预览导入')),
      h('input', { ref: dirRef, type: 'file', webkitdirectory: '', multiple: true, hidden: true, onChange: pickedDirectory }), h('input', { ref: fileRef, type: 'file', accept: '.zip,.rar,.7z,.md,.markdown', hidden: true, onChange: pickedFile }), h('p', { className: 'skm-hint' }, '仅导入可信来源的技能和脚本。格式支持、大小限制与路径安全均以宿主检查为准。')))
}
function CreateTab({ request, onDone }) {
  const [mode, setMode] = useState('quick')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const create = async e => {
    e.preventDefault()
    if (lock.current) return
    if (!displayName.trim() || !content.trim()) { setError('请填写技能名称与指令正文。'); return }
    lock.current = true; setBusy(true); setError('')
    try {
      await request('POST', '/library/create', { displayName: displayName.trim(), description, content })
      const savedName = displayName; setDisplayName(''); setDescription(''); setContent(''); onDone(savedName)
    } catch (e) { if (!aborted(e)) setError(e.message) } finally { lock.current = false; setBusy(false) }
  }
  return h('div', null, h('h3', { className: 'skm-section-title' }, '把你的工作方式，变成技能'), h('p', { className: 'skm-hint' }, '本地创建，不调用 AI。支持中文名称；保存后在技能库中开启当前会话开关。'), h('div', { className: 'skm-segment', role: 'group', 'aria-label': '创建方式' }, h('button', { 'aria-pressed': mode === 'quick', disabled: busy, onClick: () => setMode('quick') }, '新手快速创建'), h('button', { 'aria-pressed': mode === 'manual', disabled: busy, onClick: () => setMode('manual') }, '普通创建')),
    mode === 'quick' ? h(QuickCreate, { onDone, request, Field, ErrorMessage }) : h('form', { onSubmit: create, 'aria-busy': busy }, h(ErrorMessage, { message: error }), h(Field, { id: 'skm-create-name', label: '技能名称', hint: '可用中文描述用途，例如「每周项目复盘」。', value: displayName, onChange: setDisplayName, disabled: busy }), h(Field, { id: 'skm-create-description', label: '使用场景', optional: true, value: description, onChange: setDescription, disabled: busy, placeholder: '什么时候使用这个技能？' }), h(Field, { id: 'skm-create-content', label: '技能指令', multiline: true, hint: '使用 Markdown 写下明确目标、执行步骤与输出格式。', value: content, onChange: setContent, disabled: busy, placeholder: '# 目标\n\n1. 明确需求与约束\n2. 执行任务\n3. 验证并报告结果' }), h('div', { className: 'skm-form-actions' }, h('span', null, '保存到用户技能库，不自动启用'), h('button', { type: 'submit', className: 'skm-primary', disabled: busy }, busy ? '创建中…' : '创建技能'))))
}
function panelPosition(anchor) {
  // visualViewport tracks the usable area above a mobile software keyboard.
  const viewport = window.visualViewport
  const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0
  const viewportWidth = viewport?.width || window.innerWidth, viewportHeight = viewport?.height || window.innerHeight
  const rightEdge = leftEdge + viewportWidth, bottomEdge = topEdge + viewportHeight
  const width = Math.max(0, Math.min(760, viewportWidth - 24))
  const a = anchor || { left: leftEdge + 12, top: bottomEdge - 20, bottom: bottomEdge - 20 }
  const above = Math.max(0, a.top - topEdge - 20), below = Math.max(0, bottomEdge - a.bottom - 20)
  // On cramped viewports use a centered sheet instead of an unusably short popover.
  const availableHeight = Math.max(0, viewportHeight - 24)
  const height = Math.min(620, availableHeight, Math.max(above, below) < 360 ? availableHeight : Math.max(above, below))
  const top = Math.max(topEdge + 12, Math.min(bottomEdge - height - 12, Math.max(above, below) < 360 ? topEdge + (viewportHeight - height) / 2 : above >= below ? a.top - height - 8 : a.bottom + 8))
  return { width, height, left: Math.max(leftEdge + 12, Math.min(a.left, rightEdge - width - 12)), top }
}

function SkillPanel({ sessionId, triggerRef, onClose, onActivation, registerCloseGuard }) {
  const [tab, setTab] = useState('select')
  const [refreshKey, setRefreshKey] = useState(0)
  const [notice, setNotice] = useState('')
  const [position, setPosition] = useState(() => panelPosition(triggerRef.current.getBoundingClientRect()))
  const panelRef = useRef(null), tabRef = useRef(null)
  const closeRef = useRef(onClose); closeRef.current = onClose
  const controller = useRef(null)
  if (!controller.current) controller.current = new AbortController()
  const guardRef = useRef(null)
  const registerGuard = guard => { guardRef.current = guard }
  const canLeave = () => !guardRef.current || guardRef.current()
  const close = () => { if (canLeave()) closeRef.current() }
  const navigate = next => { if (next === tab || canLeave()) setTab(next) }
  useEffect(() => { registerCloseGuard(canLeave); return () => registerCloseGuard(null) }, [])
  const request = (method, path, body, signal) => {
    if (controller.current.signal.aborted) return Promise.reject(new DOMException('面板已关闭', 'AbortError'))
    return api(method, path, body, combineSignals(controller.current.signal, signal))
  }
  useEffect(() => {
    const panel = panelRef.current
    const focusables = () => Array.from(panel.querySelectorAll('button,input,textarea,select,summary,a[href],[tabindex]')).filter(el => !el.disabled && !el.closest('[hidden]') && el.tabIndex >= 0 && el.getClientRects().length)
    const first = panel.querySelector('input[type="search"]')
    ;(first || focusables()[0])?.focus()
    const keydown = e => {
      if (panel.hasAttribute('data-skm-modal') || e.isComposing || e.keyCode === 229) return
      const path = e.composedPath()
      // Inline rename owns Escape; nested collection modal owns its whole trap.
      if (e.key === 'Escape' && path.some(node => node.classList?.contains('skm-inline-rename'))) return
      if (!path.includes(panel) && !path.includes(triggerRef.current)) return
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
      if (e.key === 'Tab') {
        const els = focusables(); const index = els.indexOf(deepestActiveElement())
        if (!els.length) { e.preventDefault(); panel.focus() }
        else if (e.shiftKey && index <= 0) { e.preventDefault(); els[els.length - 1]?.focus() }
        else if (!e.shiftKey && (index === els.length - 1 || index === -1)) { e.preventDefault(); els[0]?.focus() }
      }
    }
    const outside = e => {
      if (panel.hasAttribute('data-skm-modal')) return
      const path = e.composedPath()
      if (path.includes(panel) || path.includes(triggerRef.current)) return
      // A pending/dirty editor does not consume the target input's pointer event.
      // Successful outside dismissal lets the browser focus that target naturally.
      if (canLeave()) closeRef.current({ restoreFocus: false })
    }
    const resize = () => setPosition(panelPosition(triggerRef.current?.getBoundingClientRect()))
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', resize)
    window.addEventListener('scroll', resize, true)
    window.visualViewport?.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('scroll', resize)
    return () => { controller.current.abort(); document.removeEventListener('keydown', keydown, true); document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', resize); window.removeEventListener('scroll', resize, true); window.visualViewport?.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('scroll', resize) }
  }, [])
  const done = (name, warnings) => {
    setRefreshKey(k => k + 1); setTab('select'); setNotice('已保存「' + (name || '技能') + '」，可在当前会话启用。' + (warnings?.length ? ' 提醒：' + warnings.join('；') : ''))
    tabRef.current?.focus()
  }
  const tabs = [{ id: 'select', label: '技能库', icon: 'skills' }, { id: 'import', label: '导入', icon: 'upload' }, { id: 'create', label: '新建', icon: 'plus' }]
  const changeTabKey = e => {
    if (e.isComposing || e.keyCode === 229 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    if (!canLeave()) return
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (tabs.findIndex(t => t.id === tab) + (e.key === 'ArrowRight' ? 1 : 2)) % 3
    setTab(tabs[next].id)
    panelRef.current.querySelector('#skm-tab-' + tabs[next].id)?.focus()
  }
  return h('div', { ref: panelRef, className: 'skm-panel', role: 'dialog', 'aria-modal': true, tabIndex: -1, 'aria-label': '技能管理器', style: position },
    h('header', { className: 'skm-header' }, h('span', { className: 'skm-logo' }, h(Icon, { name: 'skills', size: 23 })), h('div', { className: 'skm-header-copy' }, h('h2', { className: 'skm-title' }, '技能管理器'), h('p', { className: 'skm-subtitle' }, '管理技能与当前会话开关')), h('button', { className: 'skm-icon-btn', 'aria-label': '关闭技能管理器', onClick: close }, h(Icon, { name: 'close' }))),
    h('div', { className: 'skm-tabs', role: 'tablist', 'aria-label': '技能管理', onKeyDown: changeTabKey }, tabs.map(t => h('button', { key: t.id, ref: t.id === 'select' ? tabRef : undefined, id: 'skm-tab-' + t.id, role: 'tab', className: 'skm-tab', tabIndex: tab === t.id ? 0 : -1, 'aria-selected': tab === t.id, 'aria-controls': 'skm-page-' + t.id, onClick: () => navigate(t.id) }, h(Icon, { name: t.icon, size: 16 }), t.label))),
    h('div', { className: 'skm-body' }, notice ? h('div', { className: 'skm-success', role: 'status' }, h(Icon, { name: 'check', size: 16 }), h('span', null, notice), h('button', { className: 'skm-icon-btn', 'aria-label': '关闭保存提示', onClick: () => setNotice('') }, h(Icon, { name: 'close', size: 14 }))) : null,
      tabs.map(t => h('section', { key: t.id, className: 'skm-page', id: 'skm-page-' + t.id, role: 'tabpanel', 'aria-labelledby': 'skm-tab-' + t.id, hidden: tab !== t.id }, t.id === 'select' ? h(LibraryTab, { request, sessionId, refreshKey, onNavigate: navigate, onActivation, registerGuard }) : t.id === 'import' ? h(ImportTab, { request, onDone: done }) : h(CreateTab, { request, onDone: done })))),
    h('footer', { className: 'skm-footer' }, h('span', { title: '用户技能库；作用域、导入安全与会话权限以宿主为准。' }, '开关仅作用于当前会话 · 不写入草稿'), h('span', null, h('kbd', { className: 'skm-key' }, 'Esc'), ' 关闭')))
}

function ComposerButtonSlot(props) {
  const [openSession, setOpenSession] = useState(null)
  const [confirmed, setConfirmed] = useState(null)
  const triggerRef = useRef(null), session = useRef(props.sessionId), closeGuard = useRef(null)
  const countRequest = useRef(null), countSeq = useRef(0)
  session.current = props.sessionId
  // Render gating avoids showing a previous session's panel or count before effects run.
  const open = !!props.sessionId && openSession === props.sessionId
  const count = confirmed?.sessionId === props.sessionId ? confirmed : null
  useEffect(() => {
    setOpenSession(null); closeGuard.current = null; setConfirmed(null)
    if (!props.sessionId) return
    let alive = true
    const sessionId = props.sessionId
    const read = async () => {
      if (!alive || document.visibilityState === 'hidden' || countRequest.current) return
      const controller = new AbortController(), seq = ++countSeq.current
      countRequest.current = controller
      try {
        const data = await api('GET', '/activation?sessionId=' + encodeURIComponent(sessionId), undefined, controller.signal)
        if (!validActivation(data)) throw new Error('会话启用状态未确认')
        if (alive && session.current === sessionId && seq === countSeq.current) setConfirmed({ sessionId, count: new Set(data.skillIds).size, unavailable: data.available === false, reason: data.reason })
      } catch (e) {
        if (!aborted(e) && alive && session.current === sessionId && seq === countSeq.current) setConfirmed({ sessionId, count: null, reason: e.message })
      } finally { if (countRequest.current === controller) countRequest.current = null }
    }
    read()
    const visibility = () => { if (document.visibilityState !== 'hidden') read() }
    window.addEventListener('focus', read); document.addEventListener('visibilitychange', visibility)
    const interval = window.setInterval(read, 30000)
    return () => { alive = false; ++countSeq.current; countRequest.current?.abort(); countRequest.current = null; window.clearInterval(interval); window.removeEventListener('focus', read); document.removeEventListener('visibilitychange', visibility) }
  }, [props.sessionId])
  if (!composerScope?.sessions || !props.sessionId) return null
  const onActivation = data => {
    if (session.current !== props.sessionId) return
    ++countSeq.current; countRequest.current?.abort(); countRequest.current = null
    const valid = validActivation(data)
    setConfirmed({ sessionId: props.sessionId, count: valid ? new Set(data.skillIds).size : null, unavailable: data?.available === false, reason: data?.reason })
  }
  const close = ({ restoreFocus = true } = {}) => {
    const active = deepestActiveElement()
    if (active?.closest?.('.skm-panel')) active.blur()
    setOpenSession(null)
    if (restoreFocus && triggerRef.current?.isConnected && document.hasFocus()) triggerRef.current.focus({ preventScroll: true })
  }
  const toggle = () => { if (!open) setOpenSession(props.sessionId); else if (!closeGuard.current || closeGuard.current()) close() }
  const label = count?.count == null ? '当前会话已启用数量尚未确认' : '当前会话已启用 ' + count.count + ' 个技能' + (count.unavailable ? '；当前宿主不可用，非正在执行' : '（非正在执行）')
  return h(__Fragment, null,
    h(ShadowBoundary, null, h('span', { className: 'skm-trigger-group' },
      h('button', { type: 'button', className: 'skm-trigger', ref: triggerRef, title: '技能管理器', 'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: toggle }, h(Icon, { name: 'skills', size: 15 }), '技能'),
      h('span', { className: 'skm-count', role: 'status', 'aria-label': label, 'data-positive': count?.count > 0, title: label + (count?.reason ? ' · ' + count.reason : '') }, count?.count == null ? '—' : count.count))),
    open ? createPortal(h(ShadowBoundary, { key: props.sessionId, overlay: true, themeSource: () => triggerRef.current?.getRootNode().host }, h(SkillPanel, { sessionId: props.sessionId, triggerRef, onClose: close, onActivation, registerCloseGuard: guard => { closeGuard.current = guard } })), document.body) : null)
}
const __Fragment = require('react').Fragment

module.exports = {
  name: NS,
  inject: ['slots'],
  apply(ctx) {
    ctx.inject(['inputTriggers', 'sessions'], scope => {
      composerScope = scope
      scope.effect(() => () => { if (composerScope === scope) composerScope = null }, NS + ': composer scope')
    })
    ctx.effect(() => {
      const dispose = ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: NS, order: 60, label: () => '技能', inject: () => ({}) }, apiProps => h(ComposerButtonSlot, { sessionId: apiProps?.sessionId })))
      return () => { if (typeof dispose === 'function') dispose() }
    }, NS + ': input left button')
  },
}