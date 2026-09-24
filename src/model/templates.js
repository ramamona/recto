// Templates (spec 5.2): applyTemplate is pure; loadTemplates is a thin fetch wrapper for the browser.
import { normalizeLayout } from './layout.js'

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)

// normalizeLayout fills every missing field with its default, so this equals
// "defaultLayout() deep-merged with the template's grid/theme/header.align/margins/decor".
export function applyTemplate(layout, template) {
  const old = normalizeLayout(layout)
  const t = isObj(template?.layout) ? template.layout : {}
  const { size, width, height, targetPages } = old.page
  return normalizeLayout({
    lang: old.lang,
    customCss: old.customCss,
    page: { size, width, height, targetPages, margins: t.page?.margins },
    grid: t.grid,
    header: { align: t.header?.align, photo: old.header.photo },
    theme: t.theme,
    decor: t.decor,
    sectionDefaults: template?.sectionDefaults,
    sections: Object.fromEntries(Object.entries(old.sections).filter(([, c]) => c.hidden === true).map(([id]) => [id, { hidden: true }])),
  })
}

/** Fetch `<base>index.json` ({ templates: [id…] }) then each `<base><id>.json`; failures are skipped. */
export async function loadTemplates(base = 'templates/') {
  const get = async url => {
    const r = await fetch(url)
    if (!r.ok) throw new Error(url)
    return r.json()
  }
  let ids
  try { ids = (await get(`${base}index.json`)).templates } catch { return [] }
  const all = await Promise.all((Array.isArray(ids) ? ids : [])
    .filter(id => typeof id === 'string' && /^[a-z0-9-]+$/.test(id))
    .map(id => get(`${base}${id}.json`).then(t => isObj(t) ? { ...t, id } : null, () => null)))
  return all.filter(Boolean)
}
