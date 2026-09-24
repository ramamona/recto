// Tiny DOM helpers shared by UI modules. Text always goes through textContent/append, never innerHTML.

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'type', 'min', 'max', 'step', 'placeholder',
  'title', 'tabIndex', 'id', 'htmlFor', 'name', 'multiple', 'readOnly', 'spellcheck', 'accept', 'href', 'src', 'alt', 'open'])
const SVG_NS = 'http://www.w3.org/2000/svg'

function applyProps(el, props, svg) {
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue
    if (k === 'innerHTML' || k === 'outerHTML') throw new Error('h(): raw HTML is not allowed')
    if (k === 'class') svg ? el.setAttribute('class', v) : (el.className = v)
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (!svg && PROPS.has(k)) el[k] = v
    else el.setAttribute(k, v === true ? '' : String(v))
  }
}

function appendAll(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue
    el.append(c instanceof Node ? c : String(c))
  }
}

/** h('button', { class: 'ui-btn', onClick }, 'Save') → HTMLElement */
export function h(tag, props, ...children) {
  const el = document.createElement(tag)
  applyProps(el, props, false)
  appendAll(el, children)
  return el
}

/** svg('path', { d: 'M0 0L10 10' }) → SVGElement */
export function svg(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag)
  applyProps(el, props, true)
  appendAll(el, children)
  return el
}

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

/** addEventListener that returns its own remover. */
export function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts)
  return () => target.removeEventListener(type, fn, opts)
}

/** Replace all children of el. */
export function replaceChildren(el, ...children) {
  el.replaceChildren()
  appendAll(el, children)
  return el
}

export function debounce(fn, ms) {
  let timer = null
  let lastArgs = null
  const d = (...args) => {
    lastArgs = args
    clearTimeout(timer)
    timer = setTimeout(() => { timer = null; fn(...lastArgs) }, ms)
  }
  d.cancel = () => { clearTimeout(timer); timer = null }
  d.flush = () => { if (timer) { d.cancel(); fn(...lastArgs) } }
  return d
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

let seq = 0
export const uid = (prefix = 'id') => `${prefix}-${++seq}`

/** True when keyboard focus is in a text-editing control (shortcuts should not steal keys). */
export function isTyping(target = document.activeElement) {
  if (!target) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  return tag === 'INPUT' && !['checkbox', 'radio', 'range', 'color', 'button', 'file'].includes(target.type)
}

/** Cmd on macOS, Ctrl elsewhere. */
export const isMod = e => (navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey)
