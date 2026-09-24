// Entry point. Print mode (spec 4.7): ?print=<url of a .cv.json>[&template=<id>][&report=1] renders the pages
// only (no app UI, zoom 1, no localStorage) and exposes window.rectoReady for the CLI and smoke tests.
import { migrateFile } from './model/layout.js'
import { parse } from './model/markdown.js'
import { applyTemplate, loadTemplates } from './model/templates.js'
import { createPagesHost, layoutPages, paintViolations } from './render/pages.js'

const params = new URLSearchParams(location.search)
if (params.has('print')) window.rectoReady = printMode(params)
else appMode().catch(err => console.error('recto: boot failed', err))

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

// ---------- app mode (spec 5) ----------
// UI modules load dynamically so print mode never depends on them.

const TABS = { write: ['editor'], design: ['canvas', 'side'], check: ['side'] }

// A missing mount module (mid-build) leaves a placeholder; an error inside a mount is still an error.
async function mountOptional(path, name, root, store, ctx) {
  let mod
  try {
    mod = await import(path)
  } catch (err) {
    console.warn(`recto: ${path} unavailable`, err)
  }
  if (typeof mod?.[name] !== 'function') {
    root.replaceChildren(Object.assign(document.createElement('p'), { className: 'app-placeholder ui-muted', textContent: ctx.t('app.unavailable') }))
    return null
  }
  try {
    return (await mod[name](root, store, ctx)) ?? null
  } catch (err) {
    console.error(`recto: ${name} failed`, err)
    return null
  }
}

async function appMode() {
  const [i18n, dom, { createStore }, storageMod, { runPreflight }, { mountTopbar }] = await Promise.all([
    import('./ui/i18n.js'), import('./ui/dom.js'), import('./store.js'), import('./io/storage.js'),
    import('./preflight/rules.js'), import('./ui/topbar.js'),
  ])
  const { t } = i18n
  const { h, $, $$, on, clamp, isMod, isTyping } = dom
  await i18n.loadLocale(navigator.language)

  const storage = storageMod.createBrowserStorage()
  const store = createStore({ storage, runPreflight, locale: navigator.language })
  // the autosave is debounced; write it before the page goes away (saveDoc is synchronous localStorage)
  on(window, 'pagehide', () => store.flush())
  on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') store.flush() })
  const banners = h('div', { class: 'app-banners' })
  document.body.append(banners)

  function toast(msg, { action } = {}) {
    const el = h('div', { class: 'ui-toast' }, h('span', {}, msg),
      action && h('button', { class: 'ui-btn ui-btn--sm', type: 'button', onClick: () => { el.remove(); action.run() } }, action.label))
    $('#toasts').append(el)
    setTimeout(() => el.remove(), action ? 8000 : 5000)
  }

  function openDialog(el) {
    const dialog = el instanceof HTMLDialogElement ? el : h('dialog', { class: 'ui-dialog', closedby: 'any' }, el)
    dialog.addEventListener('close', () => dialog.remove(), { once: true })
    $('#dialogs').append(dialog)
    dialog.showModal()
    return () => dialog.close()
  }

  // actions: [[label, run?]]; every action dismisses the banner
  function banner(key, msg, actions, kind = 'is-info') {
    banners.querySelector(`[data-key="${key}"]`)?.remove()
    const el = h('div', { class: `ui-banner ${kind}`, role: 'status', dataset: { key } }, h('span', { class: 'ui-spacer' }, msg),
      actions.map(([label, run]) => h('button', { class: 'ui-btn ui-btn--sm', type: 'button', onClick: () => { el.remove(); run?.() } }, label)))
    banners.append(el)
  }

  const ctx = { t, runPreflight, canvas: null, editor: null, toast, openDialog }
  window.recto = { store, ctx } // console access for debugging

  const lastId = store.state.docs[0]?.id
  const firstRun = !(lastId && store.openDoc(lastId))
  if (firstRun) {
    try {
      const res = await fetch('samples/sample.cv.json')
      if (!res.ok) throw new Error(`sample: ${res.status}`)
      store.loadFile(await res.text())
    } catch (err) {
      console.warn('recto: sample unavailable, starting from the skeleton', err)
      store.newDoc()
    }
  }
  await storageMod.registerFonts(await storageMod.loadFonts())

  const topbar = mountTopbar($('#topbar'), store, ctx)
  ctx.canvas = await mountOptional('./ui/canvas.js', 'mountCanvas', $('#canvas'), store, ctx)
  ctx.editor = await mountOptional('./ui/editor.js', 'mountEditor', $('#editor'), store, ctx)
  await mountOptional('./ui/inspector.js', 'mountInspector', $('#inspector'), store, ctx)
  await mountOptional('./ui/panels.js', 'mountPanels', $('#panels'), store, ctx)

  mountTabs(store, ctx, dom)
  mountSplitters($('#main'), { $, $$, on, clamp })

  on(document, 'keydown', e => {
    if (!isMod(e) || e.altKey) return
    const key = e.key.toLowerCase()
    const run = (e.shiftKey ? { s: topbar.saveAs } : { s: topbar.save, o: topbar.open, p: topbar.print })[key]
    if (run) {
      e.preventDefault()
      run()
    } else if (key === 'z' && !isTyping(e.target)) { // inside text fields Cmd/Ctrl+Z stays native text undo
      e.preventDefault()
      e.shiftKey ? store.redo() : store.undo()
    }
  })

  storage.onExternalChange(id => {
    if (id !== store.state.docId) return
    // "Keep mine" re-saves this tab's version over the other tab's (renameDoc saves immediately)
    banner('external', t('app.external'), [[t('app.external.reload'), () => store.openDoc(id)], [t('app.external.keep'), () => store.renameDoc(store.state.name)]], '')
  })

  store.subscribe((s, changed) => {
    if (changed.has('content')) storageMod.requestPersistence()
    if (!changed.has('saveStatus')) return
    if (s.saveStatus === 'error') banner('quota', t('app.quota'), [[t('app.quota.export'), topbar.exportFile], [t('app.dismiss')]], 'is-error')
    else banners.querySelector('[data-key="quota"]')?.remove()
  })

  let title = document.title
  on(window, 'beforeprint', () => {
    title = document.title
    document.title = `${store.state.doc.header?.name || store.state.name || t('app.untitled')} — CV`
  })
  on(window, 'afterprint', () => { document.title = title })

  if (firstRun) {
    banner('first-run', t('app.firstRun'), [[t('app.save'), topbar.save], [t('app.dismiss')]])
    topbar.showTemplates()
  }
}

// Below 900 px the three panes become the tabs Write · Design · Check (state.ui.tab).
function mountTabs(store, ctx, { h, $, on }) {
  const tabs = Object.keys(TABS).map(tab => h('button', {
    class: 'ui-tab', type: 'button', role: 'tab', dataset: { tab }, 'aria-controls': TABS[tab][0],
    onClick: () => store.setUi({ tab }),
  }, ctx.t(`app.tab.${tab}`)))
  const bar = $('#apptabs')
  bar.replaceChildren(...tabs)
  on(bar, 'keydown', e => {
    const d = { ArrowLeft: -1, ArrowRight: 1 }[e.key]
    if (!d) return
    const i = (tabs.indexOf(e.target) + d + tabs.length) % tabs.length
    tabs[i].focus()
    store.setUi({ tab: tabs[i].dataset.tab })
  })
  const apply = ({ tab }) => {
    const current = TABS[tab] ? tab : 'write'
    $('#main').dataset.tab = current
    for (const b of tabs) {
      const selected = b.dataset.tab === current
      b.setAttribute('aria-selected', String(selected))
      b.tabIndex = selected ? 0 : -1
    }
    for (const id of ['editor', 'canvas', 'side']) $(`#${id}`).classList.toggle('is-active', TABS[current].includes(id))
  }
  store.subscribe((s, changed) => { if (changed.has('ui')) apply(s.ui) })
  apply(store.state.ui)
}

// Drag (or arrow keys on) a splitter to resize the editor or side pane.
function mountSplitters(main, { $, $$, on, clamp }) {
  const setWidth = (kind, px) => main.style.setProperty(kind === 'editor' ? '--ui-editor-w' : '--ui-side-w',
    `${Math.round(clamp(px, 260, main.clientWidth * 0.6))}px`)
  for (const el of $$('.app-splitter', main)) {
    const kind = el.dataset.split
    const pane = $(kind === 'editor' ? '#editor' : '#side')
    const widthAt = x => {
      const r = main.getBoundingClientRect()
      return kind === 'editor' ? x - r.left : r.right - x
    }
    on(el, 'pointerdown', e => {
      el.setPointerCapture(e.pointerId)
      const off = on(el, 'pointermove', ev => setWidth(kind, widthAt(ev.clientX)))
      el.addEventListener('pointerup', off, { once: true })
    })
    on(el, 'keydown', e => {
      const d = { ArrowLeft: -16, ArrowRight: 16 }[e.key]
      if (!d) return
      e.preventDefault()
      setWidth(kind, pane.offsetWidth + (kind === 'editor' ? d : -d))
    })
  }
}
