// CV file readers: DOCX, PDF, HTML, RTF, TXT/MD → plain text lines for the converter (Task 19).
// Pure: no DOM (Node has no DOMParser), only DecompressionStream/TextDecoder/Blob, so it runs in both.

const BULLETS = '•●▪■◦○·►➢\uF0B7\uF0A7\uF076\uF0D8\uF0FC\uF0A8'
const BULLET_START = new RegExp(`^[${BULLETS}]\\s*`)
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g
const DATEISH = /\b(?:19|20)\d{2}\b|\b(?:present|current|now|today|heute|aujourd'hui|actuel|hoy|oggi)\b/i

let cp1252
const winAnsi = () => (cp1252 ??= [...new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 256 }, (_, i) => i))])

function latin1(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return s
}

// Lenient: a truncated PDF stream still yields the text decoded before the error.
async function inflate(bytes, format, lenient = false) {
  const ds = new DecompressionStream(format)
  const writer = ds.writable.getWriter()
  writer.write(bytes).catch(() => {})
  writer.close().catch(() => {})
  const reader = ds.readable.getReader()
  const chunks = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
  } catch (err) {
    if (!lenient || !chunks.length) throw err
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out
}

// ---- shared text contract

// The last tab survives (as the right-aligned date gap) only when what follows looks like a date.
function resolveTabs(line, rightStop = false) {
  const parts = line.replace(/^[\t ]+|[\t ]+$/g, '').split('\t')
  if (parts.length < 2) return parts[0]
  const last = parts.pop()
  return parts.join(' ') + (rightStop || DATEISH.test(last) ? '\t' : ' ') + last
}

function cleanLine(line) {
  return line.replace(INVISIBLE, '')
    .replace(/[\uFB00-\uFB06]/g, c => c.normalize('NFKC')) // fi/fl ligatures from PDF ToUnicode maps
    .replace(/[^\S\t]+/g, ' ')
    .replace(/ *\t[\t ]*/g, '\t')
    .trim()
    .replace(/\t/g, '  ')
    .replace(BULLET_START, '• ')
    .trimEnd()
}

function tidy(raw) {
  return raw.replace(/\r\n?/g, '\n').split('\n').map(cleanLine).join('\n')
    .replace(/^•\n+(?=\S)/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', ndash: '–', mdash: '—', bull: '•', middot: '·', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', euro: '€', shy: '\u00AD', laquo: '«', raquo: '»', deg: '°' }
const decodeEntities = s => s.replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (m, dec, hex, name) =>
  dec || hex ? String.fromCodePoint(parseInt(dec ?? hex, dec ? 10 : 16) || 0xfffd) : ENTITIES[name.toLowerCase()] ?? m)

// ---- DOCX

function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('no zip directory')
  const entries = new Map()
  let at = view.getUint32(eocd + 16, true)
  for (let k = view.getUint16(eocd + 10, true); k > 0; k--) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('bad zip entry')
    const nameLen = view.getUint16(at + 28, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen))
    entries.set(name, { method: view.getUint16(at + 10, true), size: view.getUint32(at + 20, true), local: view.getUint32(at + 42, true) })
    at += 46 + nameLen + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
  }
  return async name => {
    const e = entries.get(name)
    if (!e) return null
    const start = e.local + 30 + view.getUint16(e.local + 26, true) + view.getUint16(e.local + 28, true)
    const data = bytes.subarray(start, start + e.size)
    if (e.method === 0) return data
    if (e.method === 8) return inflate(data, 'deflate-raw')
    throw new Error('unsupported zip method')
  }
}

const HEADING_STYLE = /^(heading|title|subtitle|berschrift|titre|titolo|kop|encabezado|t[ií]tulo)/i
const attr = (attrs, name) => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1] ?? ''

function docxLines(xml) {
  const out = []
  let sink = out
  const sinks = []
  const rows = []
  const paras = []
  let p = null
  let inText = false
  let inPPr = false
  let fallback = 0
  const emit = para => {
    const lines = para.text.split('\n').map(l => resolveTabs(l, para.rightTab))
    if (HEADING_STYLE.test(para.style)) sink.push('')
    if ((para.list || /^list ?bullet/i.test(para.style)) && lines[0]) lines[0] = '• ' + lines[0]
    sink.push(...lines)
  }
  for (const m of xml.matchAll(/<(\/?)([\w:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g)) {
    const [, close, tag, attrs, self, text] = m
    if (tag === 'mc:Fallback') { fallback += close ? -1 : self ? 0 : 1; continue }
    if (fallback) continue
    if (text !== undefined) { if (inText && p) p.text += decodeEntities(text); continue }
    if (tag === 'w:p') {
      if (self) sink.push('')
      else if (close) { if (p) emit(p); p = paras.pop() ?? null }
      else { if (p) paras.push(p); p = { text: '', style: '', list: false, rightTab: false } }
    } else if (tag === 'w:tr' && !self) {
      if (!close) { rows.push([]); continue }
      const cells = rows.pop() ?? []
      const filled = cells.map(c => c.filter(l => l.trim()))
      if (filled.every(c => c.length <= 1)) sink.push(resolveTabs(filled.flat().join('\t')))
      else sink.push(...cells.flat())
    } else if (tag === 'w:tc' && !self) {
      if (!close) { sinks.push(sink); sink = []; continue }
      rows.at(-1)?.push(sink)
      sink = sinks.pop() ?? out
    } else if (!p) {
      continue
    } else if (tag === 'w:pPr') {
      if (!self) inPPr = !close
    } else if (tag === 'w:t') {
      inText = !close && !self
    } else if (close) {
      continue
    } else if (tag === 'w:pStyle') {
      p.style = attr(attrs, 'w:val')
    } else if (tag === 'w:numId') {
      p.list = attr(attrs, 'w:val') !== '0'
    } else if (tag === 'w:tab') {
      if (!inPPr) p.text += '\t'
      else if (/w:val="(right|end)"/.test(attrs)) p.rightTab = true
    } else if (tag === 'w:br' || tag === 'w:cr') {
      p.text += '\n'
    } else if (tag === 'w:noBreakHyphen') {
      p.text += '-'
    }
  }
  return out
}

export async function extractDocx(bytes) {
  const read = unzip(bytes)
  const xml = await read('word/document.xml')
  if (!xml) throw new Error('no word/document.xml')
  return { text: tidy(docxLines(new TextDecoder().decode(xml)).join('\n')), warnings: [] }
}

// ---- HTML

const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul'])

export function extractHtml(html) {
  const src = html.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title|template|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, '')
  let out = ''
  const nl = () => { if (out && !out.endsWith('\n')) out += '\n' }
  for (const m of src.matchAll(/<(\/?)([a-zA-Z][\w-]*)(?:[^>"']|"[^"]*"|'[^']*')*>|<[!?][^>]*>|([^<]+)|</g)) {
    const [, close, name, text] = m
    if (text !== undefined) {
      const t = decodeEntities(text.replace(/\s+/g, ' '))
      out += !out || out.endsWith('\n') ? t.trimStart() : t
      continue
    }
    const tag = name?.toLowerCase()
    if (!tag) continue
    if (/^h[1-6]$/.test(tag)) {
      nl()
      if (!close && out && !out.endsWith('\n\n')) out += '\n'
    } else if (tag === 'td' || tag === 'th') {
      if (close) out += '\t'
    } else if (BLOCK.has(tag)) {
      nl()
      if (tag === 'li' && !close) out += '• '
    }
  }
  return { text: tidy(out.split('\n').map(l => resolveTabs(l)).join('\n')), warnings: [] }
}

// ---- RTF

const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'footnote', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'mmathPr', 'fldinst', 'pgdsctbl', 'revtbl', 'filetbl', 'nonshppict', 'shppict'])
const RTF_CHARS = { par: '\n', line: '\n', sect: '\n', page: '\n', row: '\n', tab: '\t', cell: '\t', bullet: '•', emdash: '—', endash: '–', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ' }

export function extractRtf(rtf) {
  const WORD = /([a-zA-Z]+)(-?\d+)? ?/y
  const stack = []
  let out = ''
  let skip = false
  let uc = 1
  let pending = 0 // fallback chars still to drop after a \uN
  const put = ch => {
    if (skip) return
    if (pending > 0) { pending--; return }
    out += ch
  }
  for (let i = 0; i < rtf.length;) {
    const c = rtf[i]
    if (c === '{') { stack.push({ skip, uc }); i++; continue }
    if (c === '}') { ({ skip, uc } = stack.pop() ?? { skip, uc }); i++; continue }
    if (c === '\n' || c === '\r') { i++; continue }
    if (c !== '\\') { put(c); i++; continue }
    const nx = rtf[i + 1]
    if (nx === "'") { put(winAnsi()[parseInt(rtf.substr(i + 2, 2), 16) & 255]); i += 4; continue }
    if (!/[a-zA-Z]/.test(nx ?? '')) {
      i += 2
      if (nx === '*') skip = true
      else if (nx === '~') put('\u00A0')
      else if (nx === '_') put('-')
      else if (nx === '\n' || nx === '\r') put('\n')
      else if (nx !== '-' && nx !== undefined) put(nx)
      continue
    }
    WORD.lastIndex = i + 1
    const [whole, word, param] = WORD.exec(rtf)
    i += 1 + whole.length
    pending = 0
    if (word === 'u') {
      put(String.fromCharCode(param < 0 ? +param + 65536 : +param))
      pending = uc
    } else if (word === 'uc') {
      uc = +param || 0
    } else if (word === 'pntext' || word === 'listtext') {
      put('• ')
      skip = true
    } else if (RTF_SKIP.has(word)) {
      skip = true
    } else if (RTF_CHARS[word]) {
      put(RTF_CHARS[word])
    }
  }
  return { text: tidy(out.split('\n').map(l => resolveTabs(l)).join('\n')), warnings: [] }
}

// ---- PDF

const WSC = new Uint8Array(256)
for (const c of [0, 9, 10, 12, 13, 32]) WSC[c] = 1
const DELIM = new Uint8Array(256)
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1
const ARR_OPEN = Symbol('['), ARR_CLOSE = Symbol(']'), DICT_OPEN = Symbol('<<'), DICT_CLOSE = Symbol('>>'), EOF = Symbol('eof')
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/
const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }

// Tokens: numbers, names ('/Name'), strings ({ s: bytes as latin1 }), operators/keywords ({ op }), booleans/null, symbols.
function lexer(s, pos = 0) {
  const n = s.length
  const isRegular = code => code > 255 || (!WSC[code] && !DELIM[code])
  function literal() {
    let depth = 1
    let out = ''
    for (pos++; pos < n; pos++) {
      const c = s[pos]
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) { pos++; return out }
      if (c !== '\\') { out += c; continue }
      const e = s[++pos]
      if (ESCAPES[e]) out += ESCAPES[e]
      else if (e >= '0' && e <= '7') {
        const oct = /^[0-7]{1,3}/.exec(s.substr(pos, 3))[0]
        out += String.fromCharCode(parseInt(oct, 8) & 255)
        pos += oct.length - 1
      } else if (e === '\r') { if (s[pos + 1] === '\n') pos++ } else if (e !== '\n') out += e
    }
    return out
  }
  function hex() {
    const end = s.indexOf('>', pos)
    const digits = s.slice(pos + 1, end < 0 ? n : end).replace(/[^0-9a-fA-F]/g, '')
    pos = end < 0 ? n : end + 1
    let out = ''
    for (let i = 0; i < digits.length; i += 2) out += String.fromCharCode(parseInt(digits.substr(i, 2).padEnd(2, '0'), 16))
    return out
  }
  function next() {
    for (;;) {
      while (pos < n && WSC[s.charCodeAt(pos)]) pos++
      if (s[pos] !== '%') break
      while (pos < n && s[pos] !== '\n' && s[pos] !== '\r') pos++
    }
    if (pos >= n) return EOF
    const c = s[pos]
    if (c === '(') return { s: literal() }
    if (c === '<') {
      if (s[pos + 1] === '<') { pos += 2; return DICT_OPEN }
      return { s: hex() }
    }
    if (c === '>' && s[pos + 1] === '>') { pos += 2; return DICT_CLOSE }
    if (c === '[') { pos++; return ARR_OPEN }
    if (c === ']') { pos++; return ARR_CLOSE }
    if (c === '/') {
      const start = ++pos
      while (pos < n && isRegular(s.charCodeAt(pos))) pos++
      return '/' + s.slice(start, pos).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    }
    const start = pos
    while (pos < n && isRegular(s.charCodeAt(pos))) pos++
    if (pos === start) { pos++; return next() } // stray delimiter
    const word = s.slice(start, pos)
    if (NUMBER.test(word)) return +word
    if (word === 'true' || word === 'false') return word === 'true'
    if (word === 'null') return null
    return { op: word }
  }
  // Values; with refs, "n g R" becomes { ref: n }.
  function value(tok = next(), refs = true) {
    if (tok === ARR_OPEN) {
      const arr = []
      for (let t = next(); t !== ARR_CLOSE && t !== EOF; t = next()) arr.push(value(t, refs))
      return arr
    }
    if (tok === DICT_OPEN) {
      const dict = new Map()
      for (let t = next(); t !== DICT_CLOSE && t !== EOF; t = next()) {
        if (typeof t === 'string') dict.set(t.slice(1), value(next(), refs))
      }
      return dict
    }
    if (refs && Number.isInteger(tok)) {
      const save = pos
      const gen = next()
      if (Number.isInteger(gen) && next()?.op === 'R') return { ref: tok }
      pos = save
    }
    return tok
  }
  return { next, value, get pos() { return pos }, set pos(p) { pos = p } }
}

class Pdf {
  constructor(bytes) {
    this.bytes = bytes
    this.s = latin1(bytes)
    this.offsets = new Map()
    for (const m of this.s.matchAll(/(?<!\d)(\d+)\s+\d+\s+obj\b/g)) this.offsets.set(+m[1], m.index + m[0].length)
    this.inStm = new Map()
    this.cache = new Map()
  }

  // Object streams are inflated up front so get() stays synchronous.
  async loadObjStms() {
    const starts = [...this.offsets].sort((a, b) => a[1] - b[1])
    for (const m of this.s.matchAll(/\/Type\s*\/ObjStm\b/g)) {
      const owner = starts.findLast(([, off]) => off <= m.index)
      const stm = owner && this.get(owner[0])
      if (!stm?.dict) continue
      const data = await this.decode(stm).catch(() => null)
      if (!data) continue
      const text = latin1(data)
      const lex = lexer(text)
      const first = this.resolve(stm.dict.get('First')) ?? 0
      for (let k = this.resolve(stm.dict.get('N')) ?? 0; k > 0; k--) {
        const num = lex.next()
        const off = lex.next()
        if (!Number.isInteger(num) || !Number.isInteger(off)) break
        if (!this.offsets.has(num) && !this.inStm.has(num)) this.inStm.set(num, { text, at: first + off })
      }
    }
  }

  get(num) {
    if (this.cache.has(num)) return this.cache.get(num)
    this.cache.set(num, undefined) // guards self-referencing /Length
    let val
    if (this.offsets.has(num)) {
      const lex = lexer(this.s, this.offsets.get(num))
      val = lex.value()
      if (val instanceof Map) {
        const save = lex.pos
        if (lex.next()?.op === 'stream') val = this.stream(val, lex.pos)
        else lex.pos = save
      }
    } else if (this.inStm.has(num)) {
      const { text, at } = this.inStm.get(num)
      val = lexer(text, at).value()
    }
    this.cache.set(num, val)
    return val
  }

  stream(dict, pos) {
    const s = this.s
    if (s[pos] === '\r') pos++
    if (s[pos] === '\n') pos++
    const len = this.resolve(dict.get('Length'))
    let end = Number.isInteger(len) && /^\s*endstream/.test(s.substr(pos + len, 20)) ? pos + len : -1
    if (end < 0) {
      end = s.indexOf('endstream', pos)
      if (end < 0) end = s.length
      if (s[end - 1] === '\n') end--
      if (s[end - 1] === '\r') end--
    }
    return { dict, raw: this.bytes.subarray(pos, end) }
  }

  resolve(v) {
    return v && typeof v === 'object' && 'ref' in v ? this.get(v.ref) : v
  }

  async decode(stm) {
    let data = stm.raw
    for (const f of [this.resolve(stm.dict.get('Filter')) ?? []].flat().map(f => this.resolve(f))) {
      if (f !== '/FlateDecode' && f !== '/Fl') return null
      data = await inflate(data, 'deflate', true)
    }
    return data
  }

  pages() {
    const out = []
    const seen = new Set()
    const walk = (node, inherited) => {
      if (!(node instanceof Map) || seen.has(node)) return
      seen.add(node)
      const res = this.resolve(node.get('Resources')) ?? inherited
      const kids = this.resolve(node.get('Kids'))
      if (Array.isArray(kids)) kids.forEach(k => walk(this.resolve(k), res))
      else if (node.get('Type') === '/Page' || node.has('Contents')) out.push({ node, res })
    }
    const nums = [...this.offsets.keys(), ...this.inStm.keys()].sort((a, b) => a - b)
    const catalog = nums.map(n => this.get(n)).findLast(v => v instanceof Map && v.get('Type') === '/Catalog')
    if (catalog) walk(this.resolve(catalog.get('Pages')))
    if (!out.length) {
      for (const n of nums) {
        const v = this.get(n)
        if (v instanceof Map && v.get('Type') === '/Page') out.push({ node: v, res: this.resolve(v.get('Resources')) })
      }
    }
    return out
  }

  async content(contents) {
    const parts = []
    for (const ref of [this.resolve(contents) ?? []].flat()) {
      const stm = this.resolve(ref)
      const data = stm?.raw && await this.decode(stm).catch(() => null)
      if (data) parts.push(latin1(data))
    }
    return parts.join('\n')
  }
}

// ---- PDF fonts

const GLYPH_NAMES = { space: ' ', bullet: '•', endash: '–', emdash: '—', quoteright: '’', quoteleft: '‘', quotedblleft: '“', quotedblright: '”', quotesingle: "'", hyphen: '-', periodcentered: '·', ellipsis: '…', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', middot: '·', minus: '−', copyright: '©', registered: '®', trademark: '™', Euro: '€' }
const glyphChar = name => name.length === 1 ? name
  : GLYPH_NAMES[name] ?? (/^uni([0-9A-F]{4})$/.exec(name) ? String.fromCharCode(parseInt(name.slice(3), 16)) : '')

function utf16(hex) {
  if (hex.length <= 2) return String.fromCharCode(parseInt(hex || '0', 16))
  const units = []
  for (let i = 0; i + 4 <= hex.length; i += 4) units.push(parseInt(hex.substr(i, 4), 16))
  return units
}

function parseCMap(text) {
  const map = new Map()
  const str = u => typeof u === 'string' ? u : String.fromCharCode(...u)
  for (const [, body] of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, src, dst] of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(src, 16), str(utf16(dst)))
  }
  for (const [, body] of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, dst] of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const a = parseInt(lo, 16)
      const b = Math.min(parseInt(hi, 16), a + 0xffff)
      if (dst[0] === '[') {
        [...dst.matchAll(/<([0-9a-fA-F]*)>/g)].forEach(([, h], k) => map.set(a + k, str(utf16(h))))
        continue
      }
      const base = utf16(dst.slice(1, -1))
      for (let c = a; c <= b; c++) {
        if (typeof base === 'string') { map.set(c, String.fromCharCode(base.charCodeAt(0) + c - a)); continue }
        const units = [...base]
        units[units.length - 1] += c - a
        map.set(c, String.fromCharCode(...units))
      }
    }
  }
  return map
}

async function loadFont(pdf, dict) {
  const r = v => pdf.resolve(v)
  const twoByte = dict.get('Subtype') === '/Type0'
  let toUnicode = null
  const tu = r(dict.get('ToUnicode'))
  if (tu?.raw) {
    const data = await pdf.decode(tu).catch(() => null)
    if (data) toUnicode = parseCMap(latin1(data))
  }
  const widths = new Map()
  let dflt = 500
  if (twoByte) {
    const desc = r(r(dict.get('DescendantFonts'))?.[0])
    if (desc instanceof Map) {
      dflt = r(desc.get('DW')) ?? 1000
      const w = r(desc.get('W')) ?? []
      for (let i = 0; i < w.length;) {
        const first = r(w[i])
        const next = r(w[i + 1])
        if (Array.isArray(next)) { next.forEach((v, k) => widths.set(first + k, r(v))); i += 2 } else { for (let c = first; c <= next; c++) widths.set(c, r(w[i + 2])); i += 3 }
      }
    }
  } else {
    const first = r(dict.get('FirstChar')) ?? 0
    for (const [k, v] of (r(dict.get('Widths')) ?? []).entries()) widths.set(first + k, r(v))
  }
  const enc = [...winAnsi()]
  const encoding = r(dict.get('Encoding'))
  if (encoding instanceof Map) {
    let code = 0
    for (const d of r(encoding.get('Differences')) ?? []) {
      if (typeof d === 'number') code = d
      else if (typeof d === 'string') enc[code++ & 255] = glyphChar(d.slice(1))
    }
  }
  return {
    twoByte,
    glyphs(str) {
      const out = []
      const step = twoByte ? 2 : 1
      for (let i = 0; i < str.length; i += step) {
        const code = twoByte ? (str.charCodeAt(i) << 8) | (str.charCodeAt(i + 1) || 0) : str.charCodeAt(i)
        out.push({ code, text: toUnicode?.get(code) ?? (twoByte ? '' : enc[code]), w: (widths.get(code) ?? dflt) / 1000 })
      }
      return out
    }
  }
}

// ---- PDF content streams

const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]
]
const IDENTITY = [1, 0, 0, 1, 0, 0]

async function fontsOf(pdf, res, cache) {
  const fonts = new Map()
  const dict = pdf.resolve(res?.get?.('Font'))
  if (!(dict instanceof Map)) return fonts
  for (const [name, ref] of dict) {
    const key = ref?.ref ?? ref
    if (!cache.has(key)) {
      const fd = pdf.resolve(ref)
      cache.set(key, fd instanceof Map ? loadFont(pdf, fd) : null)
    }
    fonts.set(name, await cache.get(key))
  }
  return fonts
}

async function runContent(pdf, src, res, ctm0, items, fontCache, depth = 0) {
  const fonts = await fontsOf(pdf, res, fontCache)
  const lex = lexer(src)
  const gstack = []
  let ctm = ctm0
  let tm = IDENTITY, lm = IDENTITY
  let font = null, fs = 0, tc = 0, tw = 0, th = 1, tl = 0
  let ops = []
  const translate = (m, tx, ty) => [m[0], m[1], m[2], m[3], tx * m[0] + ty * m[2] + m[4], tx * m[1] + ty * m[3] + m[5]]
  const moveLine = (tx, ty) => { lm = translate(lm, tx, ty); tm = lm }
  const show = str => {
    if (!font || typeof str !== 'string') return
    const m = mul(tm, ctm)
    let text = ''
    let adv = 0
    for (const g of font.glyphs(str)) {
      text += g.text
      adv += (g.w * fs + tc + (!font.twoByte && g.code === 32 ? tw : 0)) * th
    }
    if (text) items.push({ x: m[4], y: m[5], xEnd: m[4] + adv * m[0], size: Math.abs(fs) * Math.hypot(m[2], m[3]) || 1, text })
    tm = translate(tm, adv, 0)
  }
  for (let tok = lex.next(); tok !== EOF; tok = lex.next()) {
    if (tok === ARR_OPEN || tok === DICT_OPEN) { ops.push(lex.value(tok, false)); continue }
    if (!tok || typeof tok !== 'object' || !('op' in tok)) { ops.push(typeof tok === 'object' && tok && 's' in tok ? tok.s : tok); continue }
    const o = ops
    ops = []
    switch (tok.op) {
      case 'q': gstack.push(ctm); break
      case 'Q': ctm = gstack.pop() ?? ctm; break
      case 'cm': if (o.length >= 6) ctm = mul(o.slice(-6), ctm); break
      case 'BT': tm = lm = IDENTITY; break
      case 'Tf': font = fonts.get(String(o[0]).slice(1)) ?? null; fs = +o[1] || 0; break
      case 'Td': moveLine(+o[0] || 0, +o[1] || 0); break
      case 'TD': tl = -(+o[1] || 0); moveLine(+o[0] || 0, +o[1] || 0); break
      case 'Tm': if (o.length >= 6) tm = lm = o.slice(-6).map(Number); break
      case 'T*': moveLine(0, -tl); break
      case 'TL': tl = +o[0] || 0; break
      case 'Tc': tc = +o[0] || 0; break
      case 'Tw': tw = +o[0] || 0; break
      case 'Tz': th = (+o[0] || 100) / 100; break
      case 'Tj': show(o[0]); break
      case "'": moveLine(0, -tl); show(o[0]); break
      case '"': tw = +o[0] || 0; tc = +o[1] || 0; moveLine(0, -tl); show(o[2]); break
      case 'TJ':
        for (const el of Array.isArray(o[0]) ? o[0] : []) {
          if (typeof el === 'number') tm = translate(tm, -el / 1000 * fs * th, 0)
          else show(el?.s)
        }
        break
      case 'ID': { // inline image data: skip to EI
        const end = src.indexOf('EI', lex.pos)
        lex.pos = end < 0 ? src.length : end + 2
        break
      }
      case 'Do': {
        const xo = pdf.resolve(pdf.resolve(res?.get?.('XObject'))?.get?.(String(o[0]).slice(1)))
        if (depth < 8 && xo?.dict?.get('Subtype') === '/Form') {
          const data = await pdf.decode(xo).catch(() => null)
          const matrix = pdf.resolve(xo.dict.get('Matrix'))
          const m = Array.isArray(matrix) && matrix.length === 6 ? mul(matrix.map(Number), ctm) : ctm
          if (data) await runContent(pdf, latin1(data), pdf.resolve(xo.dict.get('Resources')) ?? res, m, items, fontCache, depth + 1)
        }
        break
      }
    }
  }
}

// Brief: lines by y (desc) then x; a space for gaps > 0.25 em, two spaces for gaps > 3 em.
function joinLine(items) {
  items.sort((a, b) => a.x - b.x)
  let out = ''
  let end = -Infinity
  for (const it of items) {
    const gap = it.x - end
    if (out && gap > 3 * it.size) out += '\t'
    else if (out && gap > 0.25 * it.size && !/\s$/.test(out) && !/^\s/.test(it.text)) out += ' '
    out += it.text
    end = Math.max(end, it.xEnd)
  }
  return out
}

function pageText(items) {
  items.sort((a, b) => b.y - a.y)
  const lines = []
  for (const it of items) {
    const line = lines.at(-1)
    if (line && line.y - it.y <= Math.max(1, 0.4 * line.size)) {
      line.items.push(it)
      line.size = Math.max(line.size, it.size)
    } else {
      lines.push({ y: it.y, size: it.size, items: [it] })
    }
  }
  let out = ''
  lines.forEach((line, k) => {
    const prev = lines[k - 1]
    if (prev && prev.y - line.y > 1.8 * Math.max(prev.size, line.size)) out += '\n'
    out += joinLine(line.items) + '\n'
  })
  return out
}

export async function extractPdf(bytes) {
  const pdf = new Pdf(bytes)
  if (!pdf.s.slice(0, 1024).includes('%PDF')) throw new Error('not a PDF')
  if (/\/Encrypt\b/.test(pdf.s)) return { text: '', warnings: ['encrypted-pdf'] }
  await pdf.loadObjStms()
  const pages = pdf.pages()
  if (!pages.length) throw new Error('no pages')
  const fontCache = new Map()
  const texts = []
  for (const { node, res } of pages) {
    const items = []
    await runContent(pdf, await pdf.content(node.get('Contents')), res, IDENTITY, items, fontCache)
    texts.push(pageText(items))
  }
  const text = tidy(texts.join('\n'))
  return text ? { text, warnings: [] } : { text: '', warnings: ['scanned-pdf'] }
}

// ---- TXT / MD, detection, entry point

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  if (bytes.subarray(0, 4096).includes(0)) throw new Error('binary data')
  return new TextDecoder().decode(bytes)
}

// Plain text keeps alignment gaps (3+ spaces or tabs) so a right-aligned date can still be split off.
const txtText = bytes => tidy(decodeText(bytes).split(/\r\n?|\n/).map(l => resolveTabs(l.replace(/ {3,}/g, '\t'))).join('\n'))
const mdText = bytes => decodeText(bytes).replace(INVISIBLE, '').replace(/\r\n?/g, '\n')

const EXTENSIONS = { docx: 'docx', pdf: 'pdf', rtf: 'rtf', html: 'html', htm: 'html', xhtml: 'html', txt: 'txt', text: 'txt', md: 'md', markdown: 'md' }

export function detectKind(name, bytes) {
  const head = latin1(bytes.subarray(0, 1024))
  if (head.startsWith('PK\x03\x04')) return 'docx'
  if (head.startsWith('%PDF')) return 'pdf'
  if (head.startsWith('{\\rtf')) return 'rtf'
  if (/^(\xef\xbb\xbf)?\s*</.test(head)) return 'html'
  const ext = /\.([a-z0-9]+)$/i.exec(name ?? '')?.[1].toLowerCase()
  if (ext) return EXTENSIONS[ext] ?? null
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)
  return utf16 || !bytes.subarray(0, 4096).includes(0) ? 'txt' : null
}

const READERS = {
  docx: extractDocx,
  pdf: extractPdf,
  html: bytes => extractHtml(decodeText(bytes)),
  rtf: bytes => extractRtf(latin1(bytes)),
  txt: bytes => ({ text: txtText(bytes), warnings: [] }),
  md: bytes => ({ text: mdText(bytes), warnings: [] })
}

/** Never throws. kind is null for unsupported formats (.doc, images, unknown binaries). */
export async function extractFile(file) {
  let bytes
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch {
    return { text: '', kind: null, warnings: ['unreadable'] }
  }
  const kind = detectKind(file.name, bytes)
  if (!kind) return { text: '', kind: null, warnings: ['unsupported-format'] }
  try {
    const { text, warnings } = await READERS[kind](bytes)
    return { text, kind, warnings: text || warnings.length ? warnings : ['unreadable'] }
  } catch {
    return { text: '', kind, warnings: ['unreadable'] }
  }
}
