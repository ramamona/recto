// Browser render check (Task 8): renders the sample plus generated docs in headless Chrome through print mode
// (?print=…&report=1) and asserts the paint invariant, pagination and PDF page counts. PDFs go to out/.
// Usage: node scripts/render-check.js   (exit 1 on any failure)
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, listen } from '../serve.js'
import { launch, countPdfPages } from '../cli/chrome.js'

const OUT = new URL('../out/', import.meta.url)
const READY_TIMEOUT = 30000
// 1×1 grey PNG: exercises the photo path (decode, explicit mm size) without a binary fixture
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const LONG_URL = 'https://example.com/' + 'averyveryverylongpathsegment'.repeat(4).slice(0, 100)

const container = (content, layout) => JSON.stringify({ format: 'recto', version: 1, name: 'check', content, layout })

function stressDoc() {
  const entries = Array.from({ length: 40 }, (_, i) => [
    `### Engineer ${i + 1} | Company ${i + 1} | Jan ${1990 + i} – Dec ${1991 + i} | City ${i + 1}`,
    `- Delivered project ${i + 1} end to end, coordinating three teams and cutting lead time by a third`,
    '- Wrote the runbook, the dashboards and the migration plan, then handed the service over to operations'
  ].join('\n'))
  const content = [
    '# Stress Test', 'Load Tester', 'stress@example.com · +1 555 000 0000 · example.com', '',
    '## Summary', 'A deliberately long document: forty entries, a sidebar with a background and an unbreakable URL.', '',
    '## Experience', ...entries, '',
    '## Links', `- ${LONG_URL}`, '',
    '## Skills', '- **Languages:** Go, Rust, TypeScript, Python, SQL', '- **Infra:** Kubernetes, Terraform, AWS', '',
    '## Languages', '- **English:** Native', '- **German:** Fluent', ''
  ].join('\n')
  return container(content, {
    version: 1,
    grid: { columns: [{ id: 'side', width: 1, bg: '#eef2f7' }, { id: 'main', width: 2.2 }], gutter: 8, headerSpan: 'main', readingOrder: ['main', 'side'] },
    header: { photo: { src: PHOTO, size: 22, shape: 'circle', position: 'left' } },
    sectionDefaults: { '*': { column: 'main' }, skills: { column: 'side', variant: 'tags' }, languages: { column: 'side', variant: 'grid' } },
    sections: {
      links: { column: 'side' },
      experience: { panel: { bg: '#fafafa', border: 'solid', borderColor: '#d4d4d8', borderWidth: 0.3, radius: 2, padding: 3 } }
    },
    decor: [
      { kind: 'rect', x: 0, y: 0, w: 210, h: 6, fill: '#1d4ed8', pages: 'all', z: 'back' },
      { kind: 'line', x: 16, y: 287, w: 178, h: 0, stroke: '#94a3b8', strokeWidth: 0.4, pages: 'all', z: 'front' }
    ]
  })
}

// Three columns, every section variant, the 'left' date gutter, a photo on the right, a panel with rules.
function variantsDoc(sample) {
  return container(sample, {
    version: 1,
    grid: {
      columns: [
        { id: 'left', width: 0.9, bg: '#1f2937', bleed: true, textColor: '#f9fafb', mutedColor: '#d1d5db', accentColor: '#93c5fd' },
        { id: 'main', width: 2 },
        { id: 'right', width: 1 }
      ],
      gutter: 6, headerSpan: 'main'
    },
    header: { align: 'center', photo: { src: PHOTO, size: 20, shape: 'rounded', position: 'right' } },
    theme: { dateStyle: 'left', headingRule: 'bar', headingCase: 'small-caps', bulletChar: '▪', linkStyle: 'accent' },
    sectionDefaults: {
      '*': { column: 'main' }, // unconfigured sections default to the first visual column (spec 3.4)
      experience: { variant: 'timeline' },
      projects: { variant: 'compact', column: 'right' },
      certifications: { column: 'right' },
      skills: { variant: 'tags', column: 'left' },
      languages: { variant: 'grid', column: 'left' }
    },
    sections: { education: { ruleAbove: true, ruleBelow: true, panel: { bg: '#f4f4f5', border: 'dashed' } } },
    decor: [{ kind: 'ellipse', x: 185, y: 262, w: 18, h: 18, fill: '#1d4ed8', opacity: 0.2, pages: 'first', z: 'back' }]
  })
}

function belowDoc(sample) {
  return container(sample, {
    version: 1,
    page: { size: 'Letter' },
    header: { align: 'right', photo: { src: PHOTO, size: 18, shape: 'square', position: 'left' } },
    theme: { dateStyle: 'below', headingRule: 'above', headingCase: 'none', linkStyle: 'underline', nameCase: 'upper', bulletChar: '' }
  })
}

const inlineDoc = sample => container(sample, { version: 1, theme: { dateStyle: 'inline', headingRule: 'none', colorHeading: 'text' } })

// Page-only CSS (the hidden measuring page has no data-page) makes real pages taller than measured,
// which exercises the verify loop (spec 4.3 step 5): mild drift must be absorbed, extreme drift flagged.
const driftDoc = (base, margin) => {
  const file = JSON.parse(base)
  return JSON.stringify({ ...file, layout: { ...file.layout, customCss: `[data-page] .cv-li { margin-top: ${margin}mm; }` } })
}

const PRINT_ROOT = "document.getElementById('recto-print').shadowRoot"
const colsJs = `[...${PRINT_ROOT}.querySelectorAll('.cv-page .cv-col')]
  .filter(c => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1)
  .map(c => c.closest('.cv-page').dataset.page + ':' + c.dataset.col)`

// Entries of the 'left' date style whose date wraps onto a second line (distinct line-box tops > 4 px apart)
const wrappedDatesJs = root => `[...${root}.querySelectorAll('.cv-entry[data-head="left"] .cv-date')].filter(el => {
  const r = document.createRange(); r.selectNodeContents(el)
  const tops = [...r.getClientRects()].map(x => x.top).sort((a, b) => a - b)
  return tops.some((t, i) => i && t - tops[i - 1] > 4)
}).map(el => el.textContent)`

const noFlags = (r, kinds = ['overflow', 'verify-failed']) =>
  r.report.flags.filter(f => kinds.includes(f.kind)).map(f => `${f.kind} p${f.page} ${f.colId}`)

const CASES = [
  { name: 'sample', url: '/samples/sample.cv.json', expect: r => [
    ...noFlags(r),
    r.report.pageCount <= 2 ? null : `sample has ${r.report.pageCount} pages (max 2)`
  ] },
  { name: 'stress', route: '/__check/stress.cv.json', body: stressDoc, maxMs: 5000, expect: r => [
    ...noFlags(r),
    r.report.pageCount >= 3 ? null : `stress rendered ${r.report.pageCount} pages (min 3)`,
    r.placement.some(p => p.sectionId === 'experience' && p.page >= 2) ? null : 'panel section did not split across pages'
  ] },
  { name: 'variants', route: '/__check/variants.cv.json', body: variantsDoc, wrappedDates: true, expect: noFlags },
  { name: 'below', route: '/__check/below.cv.json', body: belowDoc, expect: noFlags },
  { name: 'inline', route: '/__check/inline.cv.json', body: inlineDoc, expect: noFlags },
  { name: 'verify', route: '/__check/verify.cv.json', body: sample => driftDoc(container(sample, {}), 2), expect: noFlags },
  { name: 'verify-failed', route: '/__check/verify-failed.cv.json', body: () => driftDoc(stressDoc(), 20), overflowOk: true, expect: r => [
    r.report.flags.some(f => f.kind === 'verify-failed') ? null : 'extreme drift did not raise verify-failed'
  ] },
  { name: 'empty', route: '/__check/empty.cv.json', body: () => container('', {}), expect: r => [r.report.pageCount === 1 ? null : 'empty doc is not one page'] },
  { name: 'degenerate', route: '/__check/degenerate.cv.json', body: () => container('# Only Name\n## \n## Skills\n---\n##', {}), expect: r => [r.report.pageCount === 1 ? null : 'degenerate doc is not one page'] }
]

function withTimeout(promise, ms, what) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function runCase(browser, base, c) {
  const url = c.route ?? c.url
  const started = Date.now()
  const page = await browser.newPage(`${base}/?print=${encodeURIComponent(url)}&report=1`)
  try {
    const r = await withTimeout(page.evaluate('window.rectoReady'), READY_TIMEOUT, 'rectoReady')
    if (!r?.report) throw new Error('rectoReady resolved without a report')
    const ms = Date.now() - started
    const overflowing = await page.evaluate(colsJs, { awaitPromise: false })
    const pdf = await page.pdf()
    await writeFile(new URL(`${c.name}.pdf`, OUT), pdf)
    const pdfPages = countPdfPages(pdf)
    const problems = [
      ...r.violations.map(v => `paint violation ${v.selector} ${v.prop}=${v.value} "${v.text}"`),
      ...(c.overflowOk ? [] : overflowing.map(id => `column overflows its cell (page:col ${id})`)),
      pdfPages === r.report.pageCount ? null : `PDF has ${pdfPages} pages, report says ${r.report.pageCount}`,
      c.maxMs && ms >= c.maxMs ? `took ${ms} ms (max ${c.maxMs})` : null,
      ...(c.wrappedDates ? (await page.evaluate(wrappedDatesJs(PRINT_ROOT), { awaitPromise: false })).map(d => `date wraps: "${d}"`) : []),
      ...c.expect(r)
    ].filter(Boolean)
    return { name: c.name, ms, pages: r.report.pageCount, pdfPages, fill: r.report.lastPageFill, flags: r.report.flags.length, violations: r.violations.length, problems, report: r.report }
  } finally {
    await page.close().catch(() => {})
  }
}

// App mode below 900 px on the Write tab, where the canvas pane is not shown (review finding: a display:none
// canvas measured every height as 0, so the report said one empty page). The live report must match print
// mode, and the print stylesheet must lay the canvas out wherever the tab left it.
async function appCase(browser, base, printReport) {
  const page = await browser.newPage('about:blank')
  const cdp = (method, params) => browser.send(method, params, page.sessionId)
  try {
    await cdp('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false })
    await cdp('Page.navigate', { url: `${base}/` })
    // resolve once a report exists and has not changed for 500 ms
    const r = await withTimeout(page.evaluate(`new Promise(res => {
      let last = null, since = 0
      const poll = () => {
        const rep = window.recto?.store?.state.report
        if (rep && rep === last && Date.now() - since > 500) return res({ tab: window.recto.store.state.ui.tab, pageCount: rep.pageCount, fill: rep.lastPageFill })
        if (rep !== last) { last = rep; since = Date.now() }
        setTimeout(poll, 50)
      }
      poll()
    })`), READY_TIMEOUT, 'app report')
    const canvasVisible = () => page.evaluate(`(s => s.display !== 'none' && s.visibility === 'visible' && s.position === 'static')(getComputedStyle(document.getElementById('canvas')))`, { awaitPromise: false })
    // an edit inside the 500 ms autosave debounce must reach localStorage when the page is hidden
    const flushed = await page.evaluate(`(() => {
      const { store } = window.recto
      store.setContent(store.state.content + '\\n<!-- pagehide -->')
      window.dispatchEvent(new PageTransitionEvent('pagehide'))
      return JSON.parse(localStorage.getItem('recto:doc:' + store.state.docId)).content.endsWith('<!-- pagehide -->')
    })()`, { awaitPromise: false })
    await cdp('Emulation.setEmulatedMedia', { media: 'print' })
    const printable = await canvasVisible()
    const problems = [
      r.tab === 'write' ? null : `app opened on the ${r.tab} tab, expected write`,
      r.pageCount === printReport.pageCount ? null : `app reports ${r.pageCount} pages at 800 px, print mode ${printReport.pageCount}`,
      Math.abs(r.fill - printReport.lastPageFill) < 0.02 ? null : `app lastPageFill ${r.fill} at 800 px, print mode ${printReport.lastPageFill}`,
      printable ? null : 'canvas pane is not laid out for print from the Write tab',
      flushed ? null : 'pending autosave was not written on pagehide'
    ].filter(Boolean)
    return { name: 'app-800px', pages: r.pageCount, fill: r.fill, problems }
  } finally {
    await page.close().catch(() => {})
  }
}

async function main() {
  const sample = JSON.parse(await readFile(new URL('../samples/sample.cv.json', import.meta.url), 'utf8')).content
  const extra = Object.fromEntries(CASES.filter(c => c.route).map(c => [c.route, { body: c.body(sample), type: 'application/json' }]))
  await mkdir(OUT, { recursive: true })
  const server = createServer({ extra })
  const { url } = await listen(server, { port: 0 })
  const browser = await launch()
  const results = []
  try {
    for (const c of CASES) {
      try {
        results.push(await runCase(browser, url, c))
      } catch (err) {
        results.push({ name: c.name, problems: [err.message] })
      }
    }
    const sampleReport = results.find(r => r.name === 'sample')?.report
    if (sampleReport) {
      try {
        results.push(await appCase(browser, url, sampleReport))
      } catch (err) {
        results.push({ name: 'app-800px', problems: [err.message] })
      }
    }
  } finally {
    await browser.close()
    server.close()
  }
  console.table(results.map(({ name, ms, pages, pdfPages, fill, flags, violations, problems }) =>
    ({ name, ms, pages, pdfPages, fill, flags, violations, ok: problems.length === 0 })))
  const sampleReport = results.find(r => r.name === 'sample')?.report
  if (sampleReport) console.log('sample report:', JSON.stringify({ ...sampleReport, textStyles: `${sampleReport.textStyles.length} entries` }, null, 2))
  const failed = results.filter(r => r.problems.length)
  for (const r of failed) for (const p of r.problems) console.error(`FAIL ${r.name}: ${p}`)
  console.log(failed.length ? `render-check: ${failed.length} of ${results.length} cases failed` : `render-check: all ${results.length} cases passed`)
  process.exitCode = failed.length ? 1 : 0
}

await main()
