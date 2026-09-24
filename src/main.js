// Entry point. Print mode (spec 4.7): ?print=<url of a .cv.json>[&template=<id>][&report=1] renders the pages
// only (no app UI, zoom 1, no localStorage) and exposes window.rectoReady for the CLI and smoke tests.
import { migrateFile } from './model/layout.js'
import { parse } from './model/markdown.js'
import { applyTemplate, loadTemplates } from './model/templates.js'
import { createPagesHost, layoutPages, paintViolations } from './render/pages.js'

const params = new URLSearchParams(location.search)
if (params.has('print')) window.rectoReady = printMode(params)

async function loadFont({ family, data }) {
  try {
    const face = new FontFace(family, Uint8Array.from(atob(data), c => c.charCodeAt(0)))
    document.fonts.add(await face.load())
  } catch (err) {
    console.warn(`print: embedded font "${family}" could not be loaded`, err) // reported as fontsMissing
  }
}

async function withTemplate(layout, id) {
  if (!id) return layout
  const template = (await loadTemplates()).find(t => t.id === id)
  if (template) return applyTemplate(layout, template)
  console.warn(`print: unknown template "${id}", rendering without it`)
  return layout
}

async function preflight(input) {
  const rules = await import('./preflight/rules.js').catch(() => null) // absent until the preflight module lands
  if (!rules) return null
  try {
    return rules.runPreflight(input)
  } catch (err) {
    console.error('print: preflight failed', err)
    return null
  }
}

async function printMode(params) {
  const url = params.get('print')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`print: could not load ${url} (${res.status})`)
  const { file } = migrateFile(await res.text())
  const layout = await withTemplate(file.layout, params.get('template'))
  await Promise.all((file.fonts ?? []).map(loadFont))
  const doc = parse(file.content)
  document.title = `${doc.header?.name || file.name || 'Untitled'} — CV` // becomes the PDF title
  // pages only: whatever app shell markup the page has is replaced by the pages host
  const mount = document.createElement('div')
  mount.id = 'recto-print'
  document.body.replaceChildren(mount)
  document.body.style.margin = '0'
  const host = createPagesHost(mount)
  const { report, placement } = await layoutPages(doc, layout, host)
  const violations = params.get('report') === '1' ? paintViolations(host) : []
  const issues = await preflight({ source: file.content, doc, layout, report, placement })
  return { report, issues, placement, violations }
}
