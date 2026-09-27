#!/usr/bin/env node
// Recto CLI (spec 10). Exit codes: 0 ok, 1 preflight errors (check) or PDF page-count mismatch (export),
// 2 usage, input or environment error. Diagnostics go to stderr; `check` issues to stdout.
import { readFile, writeFile, access } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { parse } from '../src/model/markdown.js'
import { defaultLayout, migrateFile } from '../src/model/layout.js'
import { applyTemplate } from '../src/model/templates.js'
import { toJsonResume, fromJsonResume } from '../src/io/jsonresume.js'
import { extractText } from '../src/preflight/ats.js'
import { runPreflight } from '../src/preflight/rules.js'
import { atsReport } from '../src/ats/score.js'
import { evaluateJob } from '../src/jobs/evaluate.js'
import { fetchJob } from '../src/jobs/fetch.js'
import { extractHtml } from '../src/io/extract.js'
import { localSuggestions } from '../src/suggest/local.js'
import { validateSuggestions } from '../src/ai/guard.js'
import { normalizeProfile } from '../src/profile.js'
import { createServer, listen } from '../serve.js'
import { launch, countPdfPages } from './chrome.js'

const ROOT = new URL('../', import.meta.url)
const DOC_ROUTE = '/__cli/doc.json'
const READY_TIMEOUT = 60000

const USAGE = `Usage:
  recto export <in> -o <out> [--template <id>]
  recto check <in> [--template <id>]
  recto ats <in> [--template <id>] [--json]
  recto evaluate <in> --job <file.txt|url> [--profile <profile.json>] [--json]
  recto tips <in> [--json]
  recto apply <in> --edits <edits.json> [--allow-new-facts] [-o <out>] [--json]
  recto profile [--set key=value ...] [--file <profile.json>] [--json]

Input:  .cv.json (Recto), .json (Recto or JSON Resume), .md / .txt (Recto Markdown)
Output: .pdf (needs Chrome/Chromium; set CHROME_PATH), .txt (ATS text), .json (JSON Resume), .cv.json (Recto)
check prints preflight issues and exits 1 on errors. Without a browser it runs the content rules only.
ats exits 1 on grade F or any critical item. apply exits 1 when any edit was refused.
evaluate and profile use ./profile.json when --profile/--file is not given.`

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

// Preflight issues plus the render report when a browser is available (else content rules only, with a note).
async function preflight(file) {
  const doc = parse(file.content)
  const input = { source: file.content, doc, layout: file.layout }
  try {
    return await withPrintPage(file, ({ report, placement }) => ({ ...input, report, placement, issues: runPreflight({ ...input, report, placement }) }))
  } catch (err) {
    process.stderr.write(`note: no browser render (${err.message.split('\n')[0]}); content rules only\n`)
    return { ...input, issues: runPreflight(input) }
  }
}

async function check(file) {
  const { issues } = await preflight(file)
  for (const i of issues) {
    const where = i.line ? `line ${i.line}: ` : i.page ? `page ${i.page}: ` : ''
    process.stdout.write(`${i.severity.padEnd(5)} ${where}${t(i.msg, i.vars)} [${i.rule}]\n`)
  }
  const count = s => issues.filter(i => i.severity === s).length
  process.stdout.write(`${count('error')} errors, ${count('warn')} warnings, ${count('info')} info\n`)
  return count('error') ? 1 : 0
}

const print = s => process.stdout.write(s + '\n')
const printJson = v => print(JSON.stringify(v, null, 2))

async function ats(file, { json }) {
  const r = atsReport(await preflight(file))
  if (json) printJson(r)
  else {
    print(`ATS score ${r.score}/100 (${r.grade})`)
    for (const c of r.checks) {
      print(`${c.id.padEnd(9)} ${c.earned}/${c.weight}`)
      for (const i of c.items) print(`  ${i.severity.padEnd(8)} ${i.line ? `line ${i.line}: ` : ''}${t(i.msg, i.vars)}`)
    }
    const f = r.fields
    print(`Parsed: ${[f.name, f.email, f.phone, f.location].filter(Boolean).join(' · ')}; ${f.work?.length ?? 0} jobs`)
  }
  return r.grade === 'F' || r.checks.some(c => c.items.some(i => i.severity === 'critical')) ? 1 : 0
}

async function readJson(path, what) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    throw new UsageError(`cannot read ${what} ${path}: ${err.code ?? err.message}`)
  }
}
const exists = path => access(path).then(() => true, () => false)
const profilePath = async given => given ?? ((await exists('profile.json')) ? 'profile.json' : null)

async function loadJob(src) {
  if (!/^https?:\/\//i.test(src)) {
    try { return { text: await readFile(src, 'utf8') } } catch (err) { throw new UsageError(`cannot read job ${src}: ${err.code ?? err.message}`) }
  }
  // ATS APIs first, then the page itself as text.
  const webFetch = async url => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return extractHtml(await res.text()).text
  }
  try {
    return await fetchJob(src, { webFetch })
  } catch {
    throw new UsageError(`could not fetch ${src}; save the posting text to a file and pass that`)
  }
}

async function evaluate(file, { job: jobSrc, profile, json }) {
  if (!jobSrc) throw new UsageError('evaluate needs --job <file.txt|url>')
  const path = await profilePath(profile)
  const prof = path ? normalizeProfile(await readJson(path, 'profile')) : undefined
  const job = await loadJob(jobSrc)
  const doc = parse(file.content)
  const r = evaluateJob({ source: file.content, doc, layout: file.layout }, job, { profile: prof })
  if (json) { printJson(r); return 0 }
  const { role, gates } = r
  print(`${role.tldr || 'Role'}\n${role.archetype} · ${role.seniority} · remote: ${role.remote}`)
  print(`Gates: liveness ${gates.liveness?.status ?? 'unknown'}; location ${gates.geo?.mismatch ? 'MISMATCH' : 'ok'}` +
    `; work auth ${gates.workAuth?.tier ?? 'n/a'}; deal-breakers ${gates.dealBreakers ? gates.dealBreakers.map(d => d.term).join(', ') || 'none' : 'n/a'}`)
  print('\nImportance  Match    Requirement / evidence')
  for (const row of r.rows) {
    print(`${row.importance.padEnd(11)} ${row.match.padEnd(8)} ${row.jdSignal}`)
    if (row.evidence) print(`${''.padEnd(21)}line ${row.evidence.line}: ${row.evidence.text}`)
  }
  if (r.dropped) print(`(${r.dropped} more requirements not shown)`)
  print(`\nScore ${r.score}/5 → ${r.recommendation}${r.caps.length ? ` (capped: ${r.caps.join(', ')})` : ''}`)
  print(`Legitimacy: ${r.legitimacy.level}${r.legitimacy.signals.length ? ` (${r.legitimacy.signals.map(x => x.code).join(', ')})` : ''}`)
  return 0
}

function tips(file, { json }) {
  const list = localSuggestions(file.content, parse(file.content), file.layout?.lang ?? 'en')
  if (json) printJson(list)
  else {
    for (const s of list) print(`line ${s.line}: ${t(s.message, s.vars)} [${s.code}]`)
    print(`${list.length} tips`)
  }
  return 0
}

async function apply(file, input, { edits: editsPath, 'allow-new-facts': allowNew, output, json }) {
  if (!editsPath) throw new UsageError('apply needs --edits <edits.json>')
  const raw = await readJson(editsPath, 'edits')
  const edits = Array.isArray(raw) ? raw : raw?.suggestions // review/tailor output is { suggestions: [...] }
  if (!Array.isArray(edits)) throw new UsageError(`${editsPath} must be a JSON array (or { "suggestions": [...] }) of { line, expect, replacement }`)
  const checked = validateSuggestions(file.content, parse(file.content), edits)
  const refused = checked.filter(e => !(e.status === 'ok' || (e.status === 'new-facts' && allowNew)))
  const accepted = checked.filter(e => !refused.includes(e))
  const lines = file.content.split('\n')
  for (const e of accepted) {
    if (!json) print(`@@ line ${e.line}\n-${lines[e.line - 1]}\n+${e.replacement}`)
    lines[e.line - 1] = e.replacement
  }
  for (const e of refused) {
    const why = e.status === 'new-facts' ? `new facts not in the CV: ${e.newFacts.join(', ')} (use --allow-new-facts)` : e.status
    process.stderr.write(`refused line ${e.line}: ${why}\n`)
  }
  if (json) printJson({ applied: accepted.map(e => e.line), refused: refused.map(({ line, status, newFacts }) => ({ line, status, newFacts })) })
  if (accepted.length) {
    const out = output ?? input
    const updated = { ...file, content: lines.join('\n') }
    const lower = out.toLowerCase()
    const resumeIn = out === input && !lower.endsWith('.cv.json') && lower.endsWith('.json') && (await readJson(input, 'input'))?.format !== 'recto'
    if (/\.(md|txt)$/.test(lower)) await writeFile(out, updated.content)
    else if (lower.endsWith('.json') && !resumeIn) await writeFile(out, JSON.stringify(updated, null, 2) + '\n')
    else await exportFile(updated, out)
    if (!json) print(`${accepted.length} applied, ${refused.length} refused → ${out}`)
  } else if (!json) print(`nothing applied, ${refused.length} refused`)
  return refused.length ? 1 : 0
}

const LISTS = ['authorizedIn', 'locations', 'targetRoles', 'dealBreakers']
async function profile({ set = [], file, json }) {
  const path = file ?? 'profile.json'
  const current = (await exists(path)) ? await readJson(path, 'profile') : {}
  for (const kv of set) {
    const at = kv.indexOf('=')
    if (at < 1) throw new UsageError(`--set expects key=value, got "${kv}"`)
    const key = kv.slice(0, at)
    const value = kv.slice(at + 1)
    current[key] = LISTS.includes(key) ? value.split(',').map(s => s.trim()).filter(Boolean)
      : key === 'needsSponsorship' ? value === 'true' : value
  }
  const out = normalizeProfile(current)
  if (set.length) await writeFile(path, JSON.stringify(out, null, 2) + '\n')
  if (json) printJson(out)
  else for (const [k, v] of Object.entries(out)) print(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
  return 0
}

const COMMANDS = ['export', 'check', 'ats', 'evaluate', 'tips', 'apply', 'profile']

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' }, template: { type: 'string' }, help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' }, job: { type: 'string' }, profile: { type: 'string' }, edits: { type: 'string' },
      'allow-new-facts': { type: 'boolean' }, set: { type: 'string', multiple: true }, file: { type: 'string' }
    }
  })
  if (values.help) {
    process.stdout.write(USAGE + '\n')
    return 0
  }
  const [cmd, input, ...rest] = positionals
  if (cmd === 'profile' && !input) return profile(values)
  if (!COMMANDS.includes(cmd) || cmd === 'profile' || !input || rest.length) throw new UsageError(`expected one of: ${COMMANDS.join(', ')} (see --help)`)
  if (cmd === 'export' && !/\.(pdf|txt|json)$/i.test(values.output ?? '')) throw new UsageError('export needs -o <out.pdf|out.txt|out.json>')
  const file = await withTemplate(await readInput(input), values.template)
  if (cmd === 'check') return check(file)
  if (cmd === 'ats') return ats(file, values)
  if (cmd === 'evaluate') return evaluate(file, values)
  if (cmd === 'tips') return tips(file, values)
  if (cmd === 'apply') return apply(file, input, values)
  return (await exportFile(file, values.output)) ?? 0
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (err) {
  const usage = err instanceof UsageError || err.code?.startsWith('ERR_PARSE_ARGS')
  process.stderr.write(`recto: ${err.message}\n${usage ? '\n' + USAGE + '\n' : ''}`)
  process.exitCode = 2
}
