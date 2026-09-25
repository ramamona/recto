import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChrome } from '../cli/chrome.js'
import { extractFile, extractDocx, extractPdf, extractHtml, extractRtf, detectKind } from '../src/io/extract.js'

const enc = s => new TextEncoder().encode(s)
const bin = s => Uint8Array.from(s, c => c.charCodeAt(0) & 255)
const blob = (bytes, name) => Object.assign(new Blob([bytes]), { name })

async function deflate(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream(format))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

// ---- tiny zip writer (deflate-raw + CRC32)

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = bytes => (bytes.reduce((c, b) => CRC[(c ^ b) & 255] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0

async function zip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const raw = enc(text)
    const data = await deflate(raw, 'deflate-raw')
    const nameBytes = enc(name)
    const head = new DataView(new ArrayBuffer(30))
    head.setUint32(0, 0x04034b50, true)
    head.setUint16(4, 20, true)
    head.setUint16(8, 8, true)
    head.setUint32(14, crc32(raw), true)
    head.setUint32(18, data.length, true)
    head.setUint32(22, raw.length, true)
    head.setUint16(26, nameBytes.length, true)
    const cen = new DataView(new ArrayBuffer(46))
    cen.setUint32(0, 0x02014b50, true)
    cen.setUint16(4, 20, true)
    cen.setUint16(6, 20, true)
    cen.setUint16(10, 8, true)
    cen.setUint32(16, crc32(raw), true)
    cen.setUint32(20, data.length, true)
    cen.setUint32(24, raw.length, true)
    cen.setUint16(28, nameBytes.length, true)
    cen.setUint32(42, offset, true)
    const local = concat([new Uint8Array(head.buffer), nameBytes, data])
    locals.push(local)
    centrals.push(concat([new Uint8Array(cen.buffer), nameBytes]))
    offset += local.length
  }
  const cd = concat(centrals)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, centrals.length, true)
  end.setUint16(10, centrals.length, true)
  end.setUint32(12, cd.length, true)
  end.setUint32(16, offset, true)
  return concat([...locals, cd, new Uint8Array(end.buffer)])
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const para = (text, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
const style = id => `<w:pStyle w:val="${id}"/>`
const bullet = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
${para('Jane Doe', style('Title'))}
${para('jane@example.com · +1 555 0100')}
${para('Experience', style('Heading1'))}
<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9360"/></w:tabs></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Engineer, Acme</w:t></w:r><w:r><w:tab/><w:t>Jan 2020 – Present</w:t></w:r></w:p>
${para('Built   the thing &amp; more', style('ListParagraph') + bullet)}
${para('Shipped it', bullet)}
<w:p><w:r><w:t>Tools:</w:t></w:r><w:r><w:tab/><w:t>Go, Rust</w:t></w:r></w:p>
<w:p/>
${para('Educa\u00ADtion\u200B', style('Heading2'))}
<w:tbl><w:tr><w:tc>${para('B.S. Physics, MIT')}</w:tc><w:tc>${para('2012 – 2016')}</w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>Line one</w:t><w:br/><w:t>Line two</w:t></w:r><w:r><w:delText>gone</w:delText></w:r></w:p>
<w:p><w:r><mc:AlternateContent><mc:Choice><w:txbxContent>${para('Box text')}</w:txbxContent></mc:Choice><mc:Fallback><w:txbxContent>${para('Box text')}</w:txbxContent></mc:Fallback></mc:AlternateContent></w:r></w:p>
</w:body></w:document>`

const DOCX_TEXT = `Jane Doe
jane@example.com · +1 555 0100

Experience
Engineer, Acme  Jan 2020 – Present
• Built the thing & more
• Shipped it
Tools: Go, Rust

Education
B.S. Physics, MIT  2012 – 2016
Line one
Line two
Box text`

const makeDocx = () => zip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'word/document.xml': DOCUMENT
})

test('extractDocx: title, headings, bullets, right-aligned date tab, table row, soft break, text box once', async () => {
  const { text, warnings } = await extractDocx(await makeDocx())
  assert.equal(text, DOCX_TEXT)
  assert.deepEqual(warnings, [])
})

test('extractFile routes a .docx through the zip reader', async () => {
  const r = await extractFile(blob(await makeDocx(), 'cv.docx'))
  assert.equal(r.kind, 'docx')
  assert.equal(r.text, DOCX_TEXT)
})

// ---- tiny PDF writer

const F2_CMAP = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
1 beginbfchar <0001> <2022> endbfchar
2 beginbfrange <0120> <017E> <0020> <0002> <0002> [<2013>] endbfrange
endcmap end end`
// F2 codes: ASCII c → 0x100 + c; 0x0001 → •, 0x0002 → –
const hex2 = s => '<' + [...s].map(c => (c === '•' ? 1 : c === '–' ? 2 : 0x100 + c.charCodeAt(0)).toString(16).padStart(4, '0')).join('') + '>'

const PAGE1 = `BT /F1 18 Tf 72 720 Td (Jane Doe) Tj ET
BT /F1 12 Tf 72 660 Td (EXPERIENCE) Tj ET
BT /F1 10 Tf 72 640 Td (Engineer, Acme) Tj 400 0 Td (Jan 2020 ) Tj (\\226 Present) Tj ET
BT /F2 10 Tf 1 0 0 1 72 624 Tm [${hex2('•')} -300 ${hex2('Built things')}] TJ ET
q 1 0 0 1 72 608 cm BT /F1 10 Tf (Shipped) Tj ET Q
BT /F1 10 Tf 1 0 0 1 112 608 Tm (stuff) Tj ET
BT /F1 10 Tf 72 700 Td (jane@example.com) Tj ET`
const PAGE2 = `BT /F1 12 Tf 72 720 Td (EDUCATION) Tj 0 -16 Td /F2 10 Tf ${hex2('B.S. Physics – MIT')} Tj ET`

const PDF_TEXT = `Jane Doe
jane@example.com

EXPERIENCE
Engineer, Acme  Jan 2020 – Present
• Built things
Shipped stuff

EDUCATION
B.S. Physics – MIT`

// objects: [num, dictSource, streamText?]; pages listed in /Kids order but numbered in reverse
async function buildPdf(contents, { compress = false, objstm = false, extraTrailer = '', resources } = {}) {
  const n = contents.length
  const pageNums = contents.map((_, k) => 10 + 2 * (n - 1 - k))
  const res = resources ?? '<< /Font << /F1 3 0 R /F2 4 0 R >> >>'
  const objs = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, `<< /Type /Pages /Kids [${pageNums.map(p => `${p} 0 R`).join(' ')}] /Count ${n} /Resources ${res} >>`],
    [3, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 150 /Widths [${Array(119).fill(500).join(' ')}] >>`],
    [4, '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>'],
    [5, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 500 /W [1 [600]] >>'],
    [6, '<<>>', F2_CMAP],
    ...contents.flatMap((c, k) => [
      [pageNums[k], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageNums[k] + 1} 0 R >>`],
      [pageNums[k] + 1, '<<>>', c]
    ])
  ]
  const parts = [bin('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')]
  let size = parts[0].length
  const push = bytes => { parts.push(bytes); size += bytes.length }
  const writeObj = async ([num, dict, stream]) => {
    if (stream === undefined) return push(bin(`${num} 0 obj\n${dict}\nendobj\n`))
    let data = bin(stream)
    let extra = ''
    if (compress) { data = await deflate(data, 'deflate'); extra = ' /Filter /FlateDecode' }
    push(bin(`${num} 0 obj\n<< /Length ${data.length}${extra} >>\nstream\n`))
    push(data)
    push(bin('\nendstream\nendobj\n'))
  }
  if (objstm) {
    const plain = objs.filter(o => o[2] === undefined)
    let body = ''
    const header = plain.map(([num, dict]) => { const at = body.length; body += dict + '\n'; return `${num} ${at}` }).join(' ') + '\n'
    const data = await deflate(bin(header + body), 'deflate')
    push(bin(`99 0 obj\n<< /Type /ObjStm /N ${plain.length} /First ${header.length} /Length ${data.length} /Filter /FlateDecode >>\nstream\n`))
    push(data)
    push(bin('\nendstream\nendobj\n'))
    for (const o of objs.filter(o => o[2] !== undefined)) await writeObj(o)
  } else {
    for (const o of objs) await writeObj(o)
  }
  push(bin(`trailer\n<< /Root 1 0 R ${extraTrailer}>>\nstartxref\n${size}\n%%EOF\n`))
  return concat(parts)
}

for (const [label, opts] of [['uncompressed', {}], ['FlateDecode', { compress: true }], ['object stream', { compress: true, objstm: true }]]) {
  test(`extractPdf (${label}): page order from /Kids, y then x, spaces, date gap, ToUnicode, WinAnsi`, async () => {
    const { text, warnings } = await extractPdf(await buildPdf([PAGE1, PAGE2], opts))
    assert.equal(text, PDF_TEXT)
    assert.deepEqual(warnings, [])
  })
}

test('extractPdf: image-only PDF → scanned-pdf', async () => {
  const pdf = await buildPdf(['q 100 0 0 100 0 0 cm /Im1 Do Q'], { resources: '<< /XObject << /Im1 7 0 R >> >>' })
  assert.deepEqual(await extractPdf(pdf), { text: '', warnings: ['scanned-pdf'] })
  assert.deepEqual((await extractFile(blob(pdf, 'scan.pdf'))).warnings, ['scanned-pdf'])
})

test('extractPdf: encrypted → encrypted-pdf', async () => {
  const pdf = await buildPdf([PAGE1], { extraTrailer: '/Encrypt 50 0 R ' })
  assert.deepEqual(await extractPdf(pdf), { text: '', warnings: ['encrypted-pdf'] })
})

test('extractPdf: a 3-page PDF extracts in < 300 ms', async () => {
  const page = k => Array.from({ length: 50 }, (_, i) => `BT /F1 10 Tf 72 ${760 - i * 14} Td (Page ${k} line ${i} with some ordinary words) Tj 380 0 Td (2019 \\226 2021) Tj ET`).join('\n')
  const pdf = await buildPdf([page(1), page(2), page(3)], { compress: true })
  await extractPdf(pdf) // warm up
  const t0 = performance.now()
  const { text } = await extractPdf(pdf)
  const ms = performance.now() - t0
  assert.equal(text.split('\n').filter(Boolean).length, 150)
  assert.match(text, /^Page 1 line 0 with some ordinary words {2}2019 – 2021$/m)
  assert.ok(ms < 300, `took ${ms.toFixed(0)} ms`)
})

// ---- HTML, RTF, TXT

test('extractHtml: scripts/styles stripped, blocks → lines, li → bullets, headings, table date cells', () => {
  const html = `<!doctype html><html><head><title>CV</title><style>p{color:red}</style></head>
<body><script>alert(1)</script><!-- note -->
<h1>Jane&nbsp;Doe</h1><p>jane@example.com &middot; Berlin</p>
<h2>Experience</h2>
<table><tr><td><b>Engineer</b>, Acme</td><td>2020 &ndash; Present</td></tr></table>
<ul><li>Built
  things</li><li><p>Shipped &amp; ran</p></li></ul>
<div>Tail<br>end</div></body></html>`
  assert.deepEqual(extractHtml(html), {
    text: 'Jane Doe\njane@example.com · Berlin\n\nExperience\nEngineer, Acme  2020 – Present\n• Built things\n• Shipped & ran\nTail\nend',
    warnings: []
  })
})

test('extractRtf: control words, groups, \\par, \\u escapes, bullets, hex escapes', () => {
  const rtf = String.raw`{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0 Arial;}{\f1 Symbol;}}{\colortbl;\red0\green0\blue0;}{\*\generator Riched20;}{\info{\title Secret}}
\pard\b Jane Doe\b0\par
jane@example.com \'b7 M\'fcnchen\par
\par
Experience\par
Engineer, Acme\tab Jan 2020 \endash  Present\par
{\pntext\f1\'b7\tab}Built things\par
\bullet\tab Shipped \u8220?it\u8221?\par
Caf\u233\'65 done\par}`
  assert.deepEqual(extractRtf(rtf), {
    text: 'Jane Doe\njane@example.com · München\n\nExperience\nEngineer, Acme  Jan 2020 – Present\n• Built things\n• Shipped “it”\nCafé done',
    warnings: []
  })
})

test('extractFile: txt keeps right-aligned date gaps, strips BOM and invisible chars; md passes through', async () => {
  const txt = await extractFile(blob(enc('\uFEFFJane Doe\r\nEngineer, Acme          2020 – Present\r\nso\u00ADft   words \uFB01ne\n'), 'cv.txt'))
  assert.deepEqual(txt, { text: 'Jane Doe\nEngineer, Acme  2020 – Present\nsoft words fine', kind: 'txt', warnings: [] })
  const md = await extractFile(blob(enc('# Jane\r\n\r\n- a  \n    - b\n'), 'cv.md'))
  assert.deepEqual(md, { text: '# Jane\n\n- a  \n    - b\n', kind: 'md', warnings: [] })
  const utf16 = new Uint8Array([0xff, 0xfe, ...[...'Hi Jane'].flatMap(c => [c.charCodeAt(0), 0])])
  assert.equal((await extractFile(blob(utf16, 'cv.txt'))).text, 'Hi Jane')
})

test('detectKind: magic bytes first, then extension', () => {
  assert.equal(detectKind('x.txt', bin('PK\x03\x04rest')), 'docx')
  assert.equal(detectKind('x.docx', bin('%PDF-1.7')), 'pdf')
  assert.equal(detectKind('cv.doc', bin('{\\rtf1 hi}')), 'rtf')
  assert.equal(detectKind('cv.doc', bin('  <html>')), 'html')
  assert.equal(detectKind('cv.htm', bin('hello')), 'html')
  assert.equal(detectKind('cv.MD', bin('# hi')), 'md')
  assert.equal(detectKind(undefined, bin('plain text')), 'txt')
  assert.equal(detectKind('cv.doc', bin('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1\0\0')), null)
  assert.equal(detectKind('photo.png', bin('\x89PNG\r\n\x1a\n\0\0')), null)
})

test('extractFile never throws: garbage → unreadable, .doc/images → unsupported-format', async () => {
  const garbage = Uint8Array.from({ length: 2000 }, (_, i) => (i * 7919 + 13) % 251)
  for (const name of ['cv.pdf', 'cv.docx', 'cv.txt']) {
    const r = await extractFile(blob(garbage, name))
    assert.deepEqual([r.text, r.warnings], ['', ['unreadable']], name)
  }
  assert.deepEqual((await extractFile(blob(bin('%PDF-1.4\n garbage'), 'x.pdf'))).warnings, ['unreadable'])
  assert.deepEqual((await extractFile(blob(bin('PK\x03\x04 broken zip'), 'x.docx'))).warnings, ['unreadable'])
  const doc = await extractFile(blob(bin('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1\0\0\0'), 'old.doc'))
  assert.deepEqual(doc, { text: '', kind: null, warnings: ['unsupported-format'] })
  assert.deepEqual((await extractFile(blob(bin('\x89PNG\r\n\x1a\n\0\0'), 'me.png'))).warnings, ['unsupported-format'])
  assert.deepEqual((await extractFile({ name: 'x.pdf', arrayBuffer: () => Promise.reject(new Error('io')) })).warnings, ['unreadable'])
})

// ---- a real Chrome-printed PDF of the sample

const chrome = findChrome()
test('extractPdf reads a Chrome-printed PDF of the sample in order', { skip: !chrome && 'no Chrome/Chromium found', timeout: 120000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recto-extract-'))
  try {
    const cli = fileURLToPath(new URL('../cli/recto.js', import.meta.url))
    const sample = fileURLToPath(new URL('../samples/sample.cv.json', import.meta.url))
    const out = join(dir, 'sample.pdf')
    await new Promise((resolve, reject) => execFile(process.execPath, [cli, 'export', sample, '-o', out], { timeout: 110000 }, err => err ? reject(err) : resolve()))
    const { text, warnings } = await extractPdf(await readFile(out))
    assert.deepEqual(warnings, [])
    const lines = text.split('\n').map(l => l.trim().toLowerCase())
    const within = needle => lines.findIndex(l => l.includes(needle))
    const heading = title => lines.indexOf(title) // section titles sit on their own line
    const order = [
      within('alex morgan'), within('alex.morgan@example.com'), heading('summary'), heading('experience'), within('lumen labs'),
      ...['projects', 'education', 'skills', 'languages', 'certifications'].map(heading)
    ]
    assert.ok(order.every(i => i >= 0), `missing: ${JSON.stringify(order)}\n${text}`)
    assert.deepEqual([...order].sort((a, b) => a - b), order, text)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
