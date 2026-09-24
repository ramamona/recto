// WCAG 2.x colour contrast. Pure: accepts the colour strings getComputedStyle and the layout produce.

const KEYWORDS = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 }
}
const RGB = /^rgba?\(\s*([\d.]+)(?:\s*,\s*|\s+)([\d.]+)(?:\s*,\s*|\s+)([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/

export function parseColor (s) {
  if (typeof s !== 'string') return null
  const v = s.trim().toLowerCase()
  if (Object.hasOwn(KEYWORDS, v)) return { ...KEYWORDS[v] }
  let m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/)
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1]
    const n = i => parseInt(h.slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
  }
  m = v.match(RGB)
  if (!m) return null
  const [r, g, b] = m.slice(1, 4).map(Number)
  const a = m[4] === undefined ? 1 : Number(m[4])
  return [r, g, b].every(c => c <= 255) && a <= 1 ? { r, g, b, a } : null
}

const hex2 = c => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')
export const toHex = ({ r, g, b }) => '#' + hex2(r) + hex2(g) + hex2(b)

// Source-over onto an opaque backdrop.
export function composite (top, bottom) {
  const a = top.a ?? 1
  const mix = k => top[k] * a + bottom[k] * (1 - a)
  return { r: mix('r'), g: mix('g'), b: mix('b'), a: 1 }
}

const linear = c => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
export const relativeLuminance = ({ r, g, b }) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)

const toColor = c => typeof c === 'string' ? parseColor(c) : c

// NaN when either colour is unparseable, so `ratio < min` checks stay silent.
export function contrastRatio (fg, bg) {
  let a = toColor(fg)
  let b = toColor(bg)
  if (!a || !b) return NaN
  if (b.a !== undefined && b.a < 1) b = composite(b, KEYWORDS.white)
  if (a.a !== undefined && a.a < 1) a = composite(a, b)
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  // truncate, never round up: 4.499 must not pass a 4.5 threshold
  return Math.floor(((hi + 0.05) / (lo + 0.05)) * 100 + 1e-9) / 100
}

export const bestTextColor = bg =>
  contrastRatio('#ffffff', bg) > contrastRatio('#000000', bg) ? '#ffffff' : '#000000'
