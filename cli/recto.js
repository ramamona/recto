#!/usr/bin/env node
// Recto CLI (spec 10). Exit codes: 0 ok, 1 preflight errors (check) or PDF page-count mismatch (export),
// 2 usage, input or environment error. Diagnostics go to stderr; `check` issues to stdout.
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { parse } from '../src/model/markdown.js'
import { defaultLayout, migrateFile } from '../src/model/layout.js'
import { applyTemplate } from '../src/model/templates.js'
import { toJsonResume, fromJsonResume } from '../src/io/jsonresume.js'
import { extractText } from '../src/preflight/ats.js'
import { runPreflight } from '../src/preflight/rules.js'
import { createServer, listen } from '../serve.js'
import { launch, countPdfPages } from './chrome.js'

const ROOT = new URL('../', import.meta.url)
const DOC_ROUTE = '/__cli/doc.json'
const READY_TIMEOUT = 60000

const USAGE = `Usage:
  recto export <in> -o <out> [--template <id>]
  recto check <in> [--template <id>]

Input:  .cv.json (Recto), .json (Recto or JSON Resume), .md / .txt (Recto Markdown)
Output: .pdf (needs Chrome/Chromium; set CHROME_PATH), .txt (ATS text), .json (JSON Resume), .cv.json (Recto)
check prints preflight issues and exits 1 on errors. Without a browser it runs the content rules only.`

class UsageError extends Error {}

const strings = JSON.parse(await readFile(new URL('locales/en.json', ROOT), 'utf8'))
const t = (key, vars = {}) => (strings[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
const warn = msg => process.stderr.write(`warning: ${msg}\n`)

async function readInput(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    throw new UsageError(`cannot read ${path}: ${err.code ?? err.message}`)
  }
  const lower = path.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.txt')) {
    const name = basename(path).replace(/\.(md|txt)$/i, '')
    return { format: 'recto', version: 1, name, content: text.replace(/\r\n?/g, '\n'), layout: defaultLayout() }
  }
  if (!lower.endsWith('.json')) throw new UsageError(`unsupported input ${path} (use .cv.json, .json, .md or .txt)`)
  let json
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new UsageError(`${path} is not valid JSON: ${err.message}`)
  }
  if (lower.endsWith('.cv.json') || json?.format === 'recto') {
    const { file, warnings } = migrateFile(json)
    warnings.forEach(code => warn(t(`file.${code}`)))
    return file
  }
  const { content, layout, warnings } = fromJsonResume(json)
  warnings.forEach(w => warn(t(`jsonresume.${w.code}`, w.vars)))
  return { format: 'recto', version: 1, name: basename(path).replace(/\.json$/i, ''), content, layout }
}

// Templates are applied here (same pure applyTemplate the browser uses), so every output path agrees.
async function withTemplate(file, id) {
  if (!id) return file
  const read = async name => JSON.parse(await readFile(new URL(`templates/${name}.json`, ROOT), 'utf8'))
  let template
  try {
    const { templates } = await read('index')
    if (/^[a-z0-9-]+$/.test(id) && templates.includes(id)) template = await read(id)
  } catch {}
  if (!template) throw new UsageError(`unknown template "${id}"`)
  return { ...file, layout: applyTemplate(file.layout, { ...template, id }) }
}

// Renders through print mode (spec 4.7); the caller gets { report, placement } and the open page.
async function withPrintPage(file, fn) {
  const server = createServer({ extra: { [DOC_ROUTE]: { body: JSON.stringify(file), type: 'application/json' } } })
  const { url } = await listen(server, { port: 0 })
  let browser
  try {
    browser = await launch()
    const page = await browser.newPage(`${url}/?print=${encodeURIComponent(DOC_ROUTE)}`)
    const ready = await page.evaluate('window.rectoReady', { timeout: READY_TIMEOUT })
    if (!ready?.report) throw new Error('print mode resolved without a render report')
    return await fn(ready, page)
  } finally {
    await browser?.close()
    server.close()
  }
}

async function exportFile(file, out) {
  const lower = out.toLowerCase()
  if (lower.endsWith('.cv.json')) return writeFile(out, JSON.stringify(file, null, 2) + '\n')
  if (lower.endsWith('.json')) {
    const { json, warnings } = toJsonResume(file)
    warnings.forEach(w => warn(t(`jsonresume.${w.code}`, w.vars)))
    return writeFile(out, JSON.stringify(json, null, 2) + '\n')
  }
  if (lower.endsWith('.txt')) return writeFile(out, extractText(parse(file.content), file.layout) + '\n')
  return withPrintPage(file, async ({ report }, page) => {
    const pdf = await page.pdf()
    await writeFile(out, pdf)
    const pages = countPdfPages(pdf)
    if (pages === report.pageCount) return 0
    process.stderr.write(`error: PDF has ${pages} pages but the render report says ${report.pageCount}\n`)
    return 1
  })
}

async function check(file) {
  const doc = parse(file.content)
  const input = { source: file.content, doc, layout: file.layout }
  let issues
  try {
    issues = await withPrintPage(file, ({ report, placement }) => runPreflight({ ...input, report, placement }))
  } catch (err) {
    process.stderr.write(`note: no browser render (${err.message.split('\n')[0]}); content rules only\n`)
    issues = runPreflight(input)
  }
  for (const i of issues) {
    const where = i.line ? `line ${i.line}: ` : i.page ? `page ${i.page}: ` : ''
    process.stdout.write(`${i.severity.padEnd(5)} ${where}${t(i.msg, i.vars)} [${i.rule}]\n`)
  }
  const count = s => issues.filter(i => i.severity === s).length
  process.stdout.write(`${count('error')} errors, ${count('warn')} warnings, ${count('info')} info\n`)
  return count('error') ? 1 : 0
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { output: { type: 'string', short: 'o' }, template: { type: 'string' }, help: { type: 'boolean', short: 'h' } }
  })
  if (values.help) {
    process.stdout.write(USAGE + '\n')
    return 0
  }
  const [cmd, input, ...rest] = positionals
  if (!['export', 'check'].includes(cmd) || !input || rest.length) throw new UsageError('expected "export <in> -o <out>" or "check <in>"')
  if (cmd === 'export' && !/\.(pdf|txt|json)$/i.test(values.output ?? '')) throw new UsageError('export needs -o <out.pdf|out.txt|out.json>')
  const file = await withTemplate(await readInput(input), values.template)
  return cmd === 'check' ? check(file) : (await exportFile(file, values.output)) ?? 0
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (err) {
  const usage = err instanceof UsageError || err.code?.startsWith('ERR_PARSE_ARGS')
  process.stderr.write(`recto: ${err.message}\n${usage ? '\n' + USAGE + '\n' : ''}`)
  process.exitCode = 2
}
