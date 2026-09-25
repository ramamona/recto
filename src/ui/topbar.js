// Top bar (spec 5.3): document switcher, file open/save, import/export, templates, undo/redo,
// ATS / job score chips, save status and the light/dark toggle. Returns the actions main.js binds to shortcuts.
import { h, uid } from './dom.js'
import { openFile, saveFile, download, fontsToBase64, base64ToBlob } from '../io/files.js'
import { loadFonts, saveFont, registerFonts } from '../io/storage.js'
import { toJsonResume, fromJsonResume } from '../io/jsonresume.js'
import { fromPlainText } from '../io/plaintext.js'
import { extractText } from '../preflight/ats.js'
import { loadTemplates } from '../model/templates.js'
import { openGallery } from './gallery.js'
import { openImportReview } from './import-review.js'

const THEME_KEY = 'recto:theme'
const CHECKLIST_KEY = 'recto:print-checklist'

const lsGet = k => { try { return localStorage.getItem(k) } catch { return null } }
const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch { /* site data blocked: not remembered */ } }
const UPLOAD_ACCEPT = '.pdf,.docx,.txt,.md,.html,.htm,.rtf,.json'
const stem = name => String(name).replace(/(\.cv)?\.[^.]*$/i, '')
const isChromium = () => !!navigator.userAgentData?.brands?.some(b => b.brand === 'Chromium')

// Native popover menu anchored under its button; `items()` is rebuilt on every open.
function menu(label, items, props = {}) {
  const pop = h('div', { class: 'ui-menu', popover: 'auto', id: uid('menu'), role: 'menu' })
  const btn = h('button', { class: 'ui-btn ui-btn--ghost', type: 'button', popovertarget: pop.id, 'aria-haspopup': 'menu', ...props }, label, h('span', { 'aria-hidden': 'true' }, ' ▾'))
  const fill = () => pop.replaceChildren(...items().map(it => it === '-' ? h('div', { class: 'ui-menu__sep' })
    : it.label ? h('div', { class: 'ui-menu__label' }, it.label)
    : h('button', {
      class: 'ui-menu__item', type: 'button', role: 'menuitem', dataset: it.action ? { action: it.action } : undefined,
      'aria-current': it.current ? 'true' : undefined,
      onClick: () => { pop.hidePopover(); it.run() },
    }, it.text, it.kbd && h('span', { class: 'ui-kbd' }, it.kbd))))
  pop.addEventListener('beforetoggle', e => {
    if (e.newState !== 'open') return
    fill()
    const r = btn.getBoundingClientRect()
    Object.assign(pop.style, { inset: 'auto', top: `${r.bottom + 4}px`, left: `${Math.max(8, Math.min(r.left, innerWidth - 216))}px` })
  })
  fill() // items exist before the first open, so actions are reachable by selector
  return [btn, pop]
}

export function dialogBox(title, body, actions) {
  const id = uid('dlg')
  return h('dialog', { class: 'ui-dialog', 'aria-labelledby': id, closedby: 'any' },
    h('header', { class: 'ui-dialog__head' }, h('h2', { class: 'ui-dialog__title', id }, title)),
    h('div', { class: 'ui-dialog__body' }, body),
    h('footer', { class: 'ui-dialog__foot' }, actions))
}

// Confirm/cancel dialog; `onConfirm` runs after it closes.
export function ask(ctx, { title, body, confirm, danger = false, onConfirm }) {
  let close
  const ok = h('button', { class: `ui-btn ${danger ? 'ui-btn--danger' : 'ui-btn--primary'}`, type: 'button', onClick: () => { close(); onConfirm() } }, confirm)
  close = ctx.openDialog(dialogBox(title, body, [h('button', { class: 'ui-btn', type: 'button', onClick: () => close() }, ctx.t('app.cancel')), ok]))
  return ok
}

export function mountTopbar(root, store, ctx) {
  const { t } = ctx
  let templates = null
  const base = () => {
    const { name, doc } = store.state
    return ((name || doc.header?.name || 'cv').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim() || 'cv')
  }
  const toastWarnings = list => {
    if (list.length) ctx.toast(list.length > 1 ? `${list[0]} ${t('app.warnings.more', { count: list.length - 1 })}` : list[0])
  }
  const failed = err => {
    console.error(err)
    ctx.toast(t('app.file.failed'))
  }

  // ---------- files ----------
  async function containerText() {
    const container = store.toContainer()
    const used = JSON.stringify(container.layout)
    const fonts = (await loadFonts()).filter(f => used.includes(JSON.stringify(`font:${f.family}`)))
    if (fonts.length) container.fonts = await fontsToBase64(fonts)
    return JSON.stringify(container, null, 2)
  }

  async function save(as = false) {
    try {
      const r = await saveFile({ suggestedName: `${base()}.cv.json`, text: await containerText(), handle: as ? null : store.handle })
      if (r) store.markSaved({ name: r.name, handle: r.handle })
    } catch (err) { failed(err) }
  }

  async function installFonts(fonts = []) {
    const list = fonts.map(f => ({ family: f.family, blob: base64ToBlob(f.data) }))
    await Promise.all(list.map(f => saveFont(f.family, f.blob).catch(() => {}))) // IndexedDB may be unavailable
    await registerFonts(list)
  }

  // Loads a picked file as a new document: Markdown, JSON Resume, or a Recto container (anything else).
  async function load({ name, text, handle = null }) {
    if (/\.(md|markdown|txt)$/i.test(name)) return store.loadFile({ format: 'recto', version: 1, name: stem(name), content: text })
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON: loadFile reports invalid-file */ }
    const isRecto = json?.format === 'recto' || typeof json?.content === 'string'
    if (json && typeof json === 'object' && !Array.isArray(json) && !isRecto) {
      const r = fromJsonResume(json) // never keep the handle: saving would overwrite the JSON Resume file
      store.loadFile({ format: 'recto', version: 1, name: stem(name), content: r.content, layout: r.layout })
      return toastWarnings(r.warnings.map(w => t(`jsonresume.${w.code}`, w.vars)))
    }
    const file = store.loadFile(json ? { ...json, name: json.name || stem(name) } : text, { handle })
    toastWarnings(store.state.warnings.map(w => t(`file.${w}`)))
    if (file.fonts) await installFonts(file.fonts)
  }

  async function pick(accept, keepHandle) {
    try {
      const f = await openFile({ accept })
      if (f) await load(keepHandle ? f : { ...f, handle: null })
    } catch (err) { failed(err) }
  }
  const open = () => pick('.json', true)

  // ---------- import an existing CV: extract text, convert, review ----------
  function review(text, { warnings = [], fileName = '', kind = '' } = {}) {
    const recto = kind === 'md' && /^# /m.test(text) // already Recto Markdown: no conversion
    const { content, notes } = recto ? { content: text, notes: [] } : fromPlainText(text, store.state.layout.lang)
    const name = fileName ? stem(fileName) : t('app.paste.docName')
    openImportReview(store, ctx, { content, notes, warnings, fileName, name, onPaste: pasteText })
  }

  async function importFile(file) {
    try {
      if (/\.json$/i.test(file.name)) return await load({ name: file.name, text: await file.text() })
      const { extractFile } = await import('../io/extract.js') // loaded on first use: PDF/DOCX readers are big
      const { text, kind, warnings } = await extractFile(file)
      review(text, { warnings, fileName: file.name, kind })
    } catch (err) { failed(err) }
  }

  // openFile() reads text only; binary formats need the File itself.
  function upload() {
    const input = h('input', { type: 'file', accept: UPLOAD_ACCEPT })
    input.addEventListener('change', () => input.files[0] && importFile(input.files[0]))
    input.click()
  }

  function pasteText() {
    const area = h('textarea', { class: 'ui-textarea app-paste', rows: 14, autofocus: true, 'aria-label': t('app.paste.label'), placeholder: t('app.paste.placeholder') })
    ask(ctx, {
      title: t('app.paste.title'), body: [h('p', { class: 'ui-muted' }, t('app.paste.hint')), area], confirm: t('app.import'),
      onConfirm() { if (area.value.trim()) review(area.value) },
    })
  }

  // Drop a file anywhere on the app to import it.
  const dropZone = h('div', { class: 'app-drop', hidden: true }, h('p', { class: 'app-drop__msg' }, t('import.drop')))
  document.body.append(dropZone)
  const hasFiles = e => e.dataTransfer?.types?.includes('Files')
  let depth = 0
  addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; dropZone.hidden = false } }, true)
  addEventListener('dragleave', e => { if (hasFiles(e) && --depth <= 0) { depth = 0; dropZone.hidden = true } }, true)
  addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }, true)
  addEventListener('drop', e => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    depth = 0
    dropZone.hidden = true
    const file = e.dataTransfer.files[0]
    if (file) importFile(file)
  }, true)

  // ---------- export and print ----------
  // Logical order (spec 6.2), same as the CLI .txt; the page-marked stream download lives in the Review tab.
  const exportTxt = () => {
    try {
      const { doc, layout } = store.state
      download(`${base()}.txt`, extractText(doc, layout), 'text/plain;charset=utf-8')
    } catch (err) { failed(err) }
  }
  const exportJsonResume = () => {
    try {
      const { json, warnings } = toJsonResume(store.state)
      download(`${base()}.resume.json`, JSON.stringify(json, null, 2), 'application/json')
      toastWarnings(warnings.map(w => t(`jsonresume.${w.code}`, w.vars)))
    } catch (err) { failed(err) }
  }
  const exportFile = () => containerText().then(text => download(`${base()}.cv.json`, text, 'application/json'), failed)

  function print() {
    const run = () => ctx.canvas?.print ? ctx.canvas.print() : window.print()
    if (isChromium() || lsGet(CHECKLIST_KEY)) return run()
    ask(ctx, {
      title: t('app.print.title'), confirm: t('app.print.go'),
      body: [h('p', {}, t('app.print.intro')), h('ul', { class: 'app-checklist' },
        ['paper', 'scale', 'headers', 'backgrounds'].map(k => h('li', {}, t(`app.print.${k}`))))],
      onConfirm() { lsSet(CHECKLIST_KEY, '1'); run() },
    })
  }

  async function showTemplates() {
    templates ??= loadTemplates()
    openGallery(store, ctx, await templates)
  }

  // ---------- documents ----------
  const untitled = () => store.state.name || t('app.untitled')
  function rename() {
    const input = h('input', { class: 'ui-input app-rename', value: store.state.name, autofocus: true, 'aria-label': t('app.doc.name') })
    const ok = ask(ctx, { title: t('app.doc.rename'), body: input, confirm: t('app.doc.renameGo'), onConfirm: () => store.renameDoc(input.value.trim()) })
    input.addEventListener('keydown', e => { if (e.key === 'Enter') ok.click() })
  }
  function remove() {
    const { docId } = store.state
    ask(ctx, {
      title: t('app.doc.deleteTitle'), body: h('p', {}, t('app.doc.deleteConfirm', { name: untitled() })),
      confirm: t('app.doc.deleteGo'), danger: true, onConfirm: () => store.deleteDoc(docId),
    })
  }

  // ---------- UI ----------
  const [docBtn, docMenu] = menu('', () => [
    { label: t('app.doc.list') },
    ...store.state.docs.map(d => ({ text: d.name || t('app.untitled'), current: d.id === store.state.docId, run: () => store.openDoc(d.id) })),
    '-',
    { text: t('app.doc.new'), action: 'doc-new', run: () => store.newDoc() },
    { text: t('app.doc.duplicate'), action: 'doc-duplicate', run: () => store.duplicateDoc() },
    { text: t('app.doc.rename'), action: 'doc-rename', run: rename },
    { text: t('app.doc.delete'), action: 'doc-delete', run: remove },
  ], { class: 'ui-btn ui-btn--ghost app-doc', title: t('app.doc.switch') })
  const docName = h('span', { class: 'app-doc__name' })
  docBtn.prepend(docName)

  const [importBtn, importMenu] = menu(t('app.import'), () => [
    { text: t('app.import.upload'), action: 'import-upload', run: upload },
    { text: t('app.import.cv'), action: 'import-cv', run: () => pick('.json') },
    { text: t('app.import.md'), action: 'import-md', run: () => pick('.md,.markdown,.txt') },
    { text: t('app.import.jsonresume'), action: 'import-jsonresume', run: () => pick('.json') },
    { text: t('app.import.paste'), action: 'import-paste', run: pasteText },
  ])
  const [exportBtn, exportMenu] = menu(t('app.export'), () => [
    { text: t('app.export.pdf'), action: 'export-pdf', kbd: t('app.kbd.print'), run: print },
    { text: t('app.export.txt'), action: 'export-txt', run: exportTxt },
    { text: t('app.export.jsonresume'), action: 'export-jsonresume', run: exportJsonResume },
    { text: t('app.export.cv'), action: 'export-cv', run: exportFile },
  ])

  const btn = (action, label, run, props = {}) =>
    h('button', { class: 'ui-btn ui-btn--ghost', type: 'button', dataset: { action }, onClick: run, ...props }, label)
  const undo = btn('undo', '↶', () => store.undo(), { class: 'ui-btn ui-btn--ghost ui-btn--icon', 'aria-label': t('app.undo'), title: t('app.undo') })
  const redo = btn('redo', '↷', () => store.redo(), { class: 'ui-btn ui-btn--ghost ui-btn--icon', 'aria-label': t('app.redo'), title: t('app.redo') })
  const openPanel = panel => ctx.openPanel ? ctx.openPanel(panel) : store.setUi({ panel })
  const chip = (action, panel) => h('button', { class: 'ui-badge app-chip', type: 'button', dataset: { action }, onClick: () => openPanel(panel) })
  const atsChip = chip('ats-chip', 'review')
  const matchChip = chip('match-chip', 'job')
  const starChip = chip('score-chip', 'job')
  const status = h('span', { class: 'app-status ui-muted' })
  const jobsBtn = btn('jobs', t('jobs.button'), () => ctx.openJobsDialog?.())
  const aiBtn = btn('ai', '', () => ctx.openAiDialog?.(), { class: 'ui-btn ui-btn--ghost app-ai' })
  const aiLabel = () => {
    aiBtn.textContent = aiBtn.title = ctx.ai?.label() ?? t('ai.button')
  }
  addEventListener('recto:ai', aiLabel) // AI_EVENT from ai-dialog.js
  aiLabel()
  const themeBtn = btn('theme', '◐', toggleTheme, { class: 'ui-btn ui-btn--ghost ui-btn--icon', 'aria-label': t('app.theme'), title: t('app.theme') })

  root.replaceChildren(
    h('span', { class: 'app-brand' }, 'Recto'),
    docBtn, docMenu,
    h('span', { class: 'ui-sep' }),
    btn('open', t('app.open'), open),
    btn('save', t('app.save'), () => save()),
    btn('save-as', t('app.saveAs'), () => save(true)),
    importBtn, importMenu, exportBtn, exportMenu,
    btn('templates', t('app.templates'), showTemplates),
    h('span', { class: 'ui-sep' }),
    undo, redo,
    h('span', { class: 'ui-spacer' }),
    jobsBtn, aiBtn,
    h('span', { class: 'ui-sep' }),
    atsChip, matchChip, starChip, status, themeBtn,
  )

  // ---------- theme ----------
  const dark = () => document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches)
  function setTheme(theme) {
    if (theme) document.documentElement.dataset.theme = theme
    themeBtn.setAttribute('aria-pressed', String(dark()))
  }
  function toggleTheme() {
    const theme = dark() ? 'light' : 'dark'
    lsSet(THEME_KEY, theme)
    setTheme(theme)
  }
  setTheme(/^(light|dark)$/.test(lsGet(THEME_KEY)) ? lsGet(THEME_KEY) : null)

  // ---------- live parts ----------
  function badgeText(issues) {
    const n = { error: 0, warn: 0, info: 0 }
    for (const i of issues) n[i.severity] = (n[i.severity] ?? 0) + 1
    const parts = [['error', 'errors'], ['warn', 'warnings']].filter(([k]) => n[k]).map(([k, key]) => t(`app.badge.${key}${n[k] === 1 ? '.one' : ''}`, { count: n[k] }))
    return parts.join(' · ') || (n.info ? t('app.badge.info', { count: n.info }) : t('app.badge.none'))
  }
  // ATS 86 · B always (the issue count moves to its tooltip); Match and ★ only while the Job tab shows a job
  const GRADE_KIND = { A: 'is-ok', B: 'is-ok', C: 'is-warn', D: 'is-error', F: 'is-error' }
  function chips({ ats, issues, activeJob }) {
    atsChip.textContent = ats ? t('app.chip.ats', ats) : t('app.chip.atsPending')
    atsChip.className = `ui-badge app-chip ${ats ? GRADE_KIND[ats.grade] : ''}`
    atsChip.title = `${badgeText(issues)} · ${t('app.chip.atsOpen')}`
    const match = activeJob?.match, score = activeJob?.score
    matchChip.hidden = match == null
    matchChip.textContent = t('app.chip.match', { match: Math.round(match) })
    matchChip.title = t('app.chip.jobOpen')
    starChip.hidden = score == null
    starChip.textContent = t('app.chip.score', { score: Number(score).toFixed(1) })
    starChip.title = t('app.chip.jobOpen')
  }
  function statusText({ saveStatus, file }) {
    if (saveStatus === 'error') return t('app.status.error')
    if (saveStatus === 'file' && file) {
      const time = new Date(file.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      return t('app.status.file', { file: file.name, time })
    }
    return t('app.status.browser')
  }
  function update(s) {
    docName.textContent = untitled()
    undo.disabled = !s.canUndo
    redo.disabled = !s.canRedo
    chips(s)
    status.textContent = statusText(s)
    status.classList.toggle('is-error', s.saveStatus === 'error')
  }
  const KEYS = ['name', 'docs', 'canUndo', 'canRedo', 'issues', 'ats', 'activeJob', 'saveStatus', 'file']
  store.subscribe((s, changed) => { if (KEYS.some(k => changed.has(k))) update(s) })
  update(store.state)

  return { save: () => save(), saveAs: () => save(true), open, print, exportFile, showTemplates }
}
