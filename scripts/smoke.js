// End-to-end smoke test (spec 12): validates every template file, renders the sample with each one through
// print mode in headless Chrome, and checks preflight, pagination, the paint invariant and the PDF.
// PDFs go to out/<template>.pdf. Usage: node scripts/smoke.js   (exit 1 on any failure)
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer, listen } from '../serve.js'
import { launch, countPdfPages } from '../cli/chrome.js'
import { normalizeLayout } from '../src/model/layout.js'
import { parse } from '../src/model/markdown.js'

const ROOT = new URL('../', import.meta.url)
const OUT = new URL('out/', ROOT)
const SAMPLE = '/samples/sample.cv.json'
const READY_TIMEOUT = 30000
const MAX_FILL = 0.92 // a template must leave >= 8 % slack on its last page
const LAYOUT_KEYS = ['grid', 'theme', 'header', 'page', 'decor'] // what applyTemplate takes from a template

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const readJson = async path => JSON.parse(await readFile(new URL(path, ROOT), 'utf8'))
const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase() // headings may be uppercased by CSS

// Every value the template sets must survive normalizeLayout unchanged (a typo or out-of-range value would
// otherwise be silently replaced by a default). Returns the paths that did not survive.
function lost(given, kept, path = []) {
  if (Array.isArray(given)) {
    if (!Array.isArray(kept) || kept.length !== given.length) return [path.join('.')]
    return given.flatMap((v, i) => lost(v, kept[i], [...path, i]))
  }
  if (isObj(given)) return isObj(kept) ? Object.entries(given).flatMap(([k, v]) => lost(v, kept[k], [...path, k])) : [path.join('.')]
  return Object.is(given, kept) ? [] : [`${path.join('.')}=${JSON.stringify(given)}`]
}

function validateTemplate(id, t) {
  const problems = []
  if (!isObj(t)) return ['not a JSON object']
  if (t.id !== id) problems.push(`id "${t.id}" does not match the file name`)
  for (const k of ['name', 'description']) if (typeof t[k] !== 'string' || !t[k].trim()) problems.push(`missing ${k}`)
  if (!Number.isInteger(t.targetPages) || t.targetPages < 1 || t.targetPages > 10) problems.push('targetPages must be an integer 1–10')
  if (!isObj(t.layout)) return [...problems, 'missing layout']
  if (!isObj(t.sectionDefaults)) problems.push('missing sectionDefaults')
  for (const k of Object.keys(t.layout)) if (!LAYOUT_KEYS.includes(k)) problems.push(`layout.${k} is not taken from templates`)
  for (const k of Object.keys(t.layout.page ?? {})) if (k !== 'margins') problems.push(`layout.page.${k} is not taken from templates`)
  for (const k of Object.keys(t.layout.header ?? {})) if (k !== 'align') problems.push(`layout.header.${k} is not taken from templates`)
  const n = normalizeLayout({ ...t.layout, sectionDefaults: t.sectionDefaults })
  for (const p of lost(t.layout, n)) problems.push(`layout.${p} is invalid (changed by normalizeLayout)`)
  for (const p of lost(t.sectionDefaults ?? {}, n.sectionDefaults)) problems.push(`sectionDefaults.${p} is invalid (changed by normalizeLayout)`)
  return problems
}

function withTimeout(promise, ms, what) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const hasPdftotext = () => !spawnSync('pdftotext', ['-v']).error

// pdftotext -raw emits content-stream order: the order an ATS reads.
function pdfTextProblems(pdfPath, r, doc) {
  const { stdout } = spawnSync('pdftotext', ['-raw', '-enc', 'UTF-8', pdfPath, '-'], { encoding: 'utf8' })
  const text = norm(stdout)
  const problems = []
  const email = doc.header?.contacts?.find(c => c.kind === 'email')?.text
  for (const s of [doc.header?.name, email]) if (s && !text.includes(norm(s))) problems.push(`PDF text lacks "${s}"`)
  const titles = [...new Set(r.placement.map(p => p.sectionId).filter(Boolean))]
    .map(id => doc.sections.find(s => s.id === id)?.title).filter(Boolean)
  let at = 0
  for (const title of titles) {
    const i = text.indexOf(norm(title), at)
    if (i < 0) { problems.push(`PDF text: section "${title}" missing or out of placement order`); break }
    at = i + 1
  }
  const pages = stdout.split('\f').map(norm).filter(Boolean)
  r.report.pages.forEach(({ firstText, lastText }, i) => {
    const page = pages[i] ?? ''
    if (!page.startsWith(norm(firstText))) problems.push(`PDF page ${i + 1} does not start with "${firstText}"`)
    if (!page.endsWith(norm(lastText))) problems.push(`PDF page ${i + 1} does not end with "${lastText}"`)
  })
  return problems
}

async function runTemplate(browser, base, t, doc, pdftotext) {
  const page = await browser.newPage(`${base}/?print=${encodeURIComponent(SAMPLE)}&template=${t.id}&report=1`)
  try {
    const r = await withTimeout(page.evaluate('window.rectoReady'), READY_TIMEOUT, 'rectoReady')
    if (!r?.report) throw new Error('rectoReady resolved without a report')
    if (!Array.isArray(r.issues)) throw new Error('rectoReady resolved without preflight issues')
    const { pageCount, lastPageFill, flags } = r.report
    const pdf = await page.pdf()
    const pdfPath = fileURLToPath(new URL(`${t.id}.pdf`, OUT))
    await writeFile(pdfPath, pdf)
    const pdfPages = countPdfPages(pdf)
    const errors = r.issues.filter(i => i.severity === 'error')
    const problems = [
      ...errors.map(i => `preflight error ${i.rule} ${JSON.stringify(i.vars ?? {})}`),
      pageCount <= t.targetPages ? null : `${pageCount} pages, target ${t.targetPages}`,
      pageCount === t.targetPages && lastPageFill > MAX_FILL ? `last page ${Math.round(lastPageFill * 100)} % full (max ${MAX_FILL * 100} %)` : null,
      ...flags.filter(f => f.kind === 'overflow' || f.kind === 'verify-failed').map(f => `${f.kind} flag p${f.page} ${f.colId}`),
      ...r.violations.map(v => `paint violation ${v.selector} ${v.prop}=${v.value} "${v.text}"`),
      pdfPages === pageCount ? null : `PDF has ${pdfPages} pages, report says ${pageCount}`,
      ...(pdftotext ? pdfTextProblems(pdfPath, r, doc) : [])
    ].filter(Boolean)
    return {
      template: t.id, pages: pageCount, target: t.targetPages, lastPageFill, errors: errors.length,
      warnings: r.issues.filter(i => i.severity === 'warn').length, violations: r.violations.length, pdfPages, problems
    }
  } finally {
    await page.close().catch(() => {})
  }
}

async function loadTemplates() {
  let ids
  try {
    ids = (await readJson('templates/index.json')).templates
  } catch (err) {
    return { templates: [], problems: [`templates/index.json: ${err.message}`] }
  }
  if (!Array.isArray(ids) || !ids.length) return { templates: [], problems: ['templates/index.json lists no templates'] }
  const templates = []
  const problems = []
  for (const id of ids) {
    try {
      const t = await readJson(`templates/${id}.json`)
      const bad = validateTemplate(id, t)
      if (bad.length) problems.push(...bad.map(p => `${id}: ${p}`))
      else templates.push(t)
    } catch (err) {
      problems.push(`${id}: ${err.message}`)
    }
  }
  return { templates, problems }
}

async function main() {
  const { templates, problems } = await loadTemplates()
  for (const p of problems) console.error(`FAIL ${p}`)
  if (!templates.length) {
    console.error('smoke: no valid templates')
    process.exitCode = 1
    return
  }
  const doc = parse((await readJson(SAMPLE.slice(1))).content)
  const pdftotext = hasPdftotext()
  if (!pdftotext) console.log('smoke: pdftotext not found, skipping PDF text checks')
  await mkdir(OUT, { recursive: true })
  const server = createServer()
  const { url } = await listen(server, { port: 0 })
  const browser = await launch()
  const results = []
  try {
    for (const t of templates) {
      try {
        results.push(await runTemplate(browser, url, t, doc, pdftotext))
      } catch (err) {
        results.push({ template: t.id, problems: [err.message] })
      }
    }
  } finally {
    await browser.close()
    server.close()
  }
  console.table(results.map(({ problems, ...row }) => ({ ...row, ok: problems.length === 0 })))
  const failed = results.filter(r => r.problems.length)
  for (const r of failed) for (const p of r.problems) console.error(`FAIL ${r.template}: ${p}`)
  const bad = failed.length + (problems.length ? 1 : 0)
  console.log(bad ? `smoke: ${failed.length} of ${results.length} templates failed${problems.length ? ', invalid template files' : ''}` : `smoke: all ${results.length} templates passed`)
  process.exitCode = bad ? 1 : 0
}

await main()
