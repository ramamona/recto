// App store (spec 5.1): one frozen state snapshot, actions, { content, layout } history, autosave.
// Pure apart from the timer: storage and preflight are injected.
import { parse } from './model/markdown.js'
import { defaultLayout, migrateFile, applyLayoutOps, renameSectionIds, placeSections, sectionConfig } from './model/layout.js'
import { applyContentEdits, moveSectionSource } from './model/edits.js'
import { applyTemplate as templateLayout } from './model/templates.js'

const SKELETON = `# Your Name
you@example.com · +1 555 000 0000 · City, Country

## Summary
Two or three sentences about what you do best and what you are looking for.

## Experience
### Job title | Organisation | Jan 2024 – Present | City
- What you achieved, with a number if you can

## Education
### Degree | University | 2018 – 2022 | City

## Skills
- Skill, skill, skill
`

const LETTER_LOCALES = ['en-US', 'en-CA', 'es-MX', 'fr-CA']
const HISTORY_MAX = 100
const TEXT_COALESCE_MS = 1000

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
const sameLayout = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b)

export function createStore({ storage, runPreflight = () => [], now = () => new Date(), locale = 'en-US', debounceMs = 500 }) {
  let state = Object.freeze({
    docId: null, name: '', content: '', layout: defaultLayout(), doc: parse(''),
    report: null, issues: [], placement: null,
    selection: null, caretLine: 1, reveal: null,
    file: null, saveStatus: 'browser', warnings: [],
    ui: { zoom: 'fit', xray: false, tab: 'write', panel: 'check', dialog: null },
    canUndo: false, canRedo: false, docs: storage.listDocs(),
  })
  const subs = new Set()
  const files = new Map() // docId → { file: { name, savedAt }, handle, status }, in memory only
  let past = [], future = [], last = null // last = { key, at } of the newest history entry, for coalescing
  let timer = null

  function set(patch) {
    const changed = new Set(Object.keys(patch).filter(k => patch[k] !== state[k]))
    if (!changed.size) return
    state = Object.freeze({ ...state, ...patch })
    for (const fn of subs) fn(state, changed)
  }

  const history = () => ({ canUndo: past.length > 0, canRedo: future.length > 0 })
  const toContainer = () => ({ format: 'recto', version: 1, name: state.name, content: state.content, layout: state.layout })

  function save() {
    clearTimeout(timer)
    timer = null
    if (!state.docId) return
    const r = storage.saveDoc(state.docId, toContainer())
    const saveStatus = !r.ok ? 'error' : state.saveStatus === 'error' ? 'browser' : state.saveStatus
    set({ saveStatus, docs: storage.listDocs() })
  }
  const flush = () => { if (timer) save() }

  // Show a snapshot (content re-parsed only when it changed) and schedule the autosave.
  function show({ content, layout }, doc = content === state.content ? state.doc : parse(content)) {
    set({
      content, layout, doc, ...history(),
      saveStatus: state.saveStatus === 'file' ? 'browser' : state.saveStatus,
    })
    clearTimeout(timer)
    timer = setTimeout(save, debounceMs)
  }

  // One undoable change. `key` coalesces with the newest entry: 'text' within 1 s, layout keys always.
  function commit({ content = state.content, layout = state.layout }, key = null) {
    const doc = content === state.content ? state.doc : parse(content)
    layout = renameSectionIds(state.doc, doc, layout)
    if (doc === state.doc && sameLayout(layout, state.layout)) return false
    const at = now().getTime()
    if (!(key && last?.key === key && (key !== 'text' || at - last.at <= TEXT_COALESCE_MS))) {
      past.push({ content: state.content, layout: state.layout })
      if (past.length > HISTORY_MAX) past.shift()
    }
    future = []
    last = key && { key, at }
    show({ content, layout }, doc)
    return true
  }

  function step(from, to) {
    if (!from.length) return
    to.push({ content: state.content, layout: state.layout })
    last = null
    show(from.pop())
  }

  // Switch to a document: history, selection and render results start fresh.
  function load(id, { name, content, layout }, warnings = []) {
    const cur = files.get(state.docId)
    if (cur) cur.status = state.saveStatus === 'file' ? 'file' : 'browser'
    const next = files.get(id)
    clearTimeout(timer)
    timer = null
    past = []
    future = []
    last = null
    set({
      docId: id, name, content, layout, doc: parse(content), warnings,
      report: null, issues: [], placement: null, selection: null, caretLine: 1, reveal: null,
      file: next?.file ?? null, saveStatus: next?.status ?? 'browser',
      canUndo: false, canRedo: false, docs: storage.listDocs(),
    })
  }

  function newDoc() {
    flush()
    load(uid(), { name: '', content: SKELETON, layout: defaultLayout(LETTER_LOCALES.includes(locale) ? 'Letter' : 'A4') })
    save()
  }

  function openDoc(id) {
    flush()
    const stored = storage.loadDoc(id)
    if (!stored) return false
    const { file, warnings } = migrateFile(stored)
    load(id, file, warnings)
    return true
  }

  return {
    get state() { return state },
    /** File System Access handle of the open document, or null. */
    get handle() { return files.get(state.docId)?.handle ?? null },

    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },

    setContent: text => commit({ content: String(text ?? '') }, 'text'),
    setLayout: (ops, { coalesceKey } = {}) =>
      commit({ layout: applyLayoutOps(state.layout, ops) }, coalesceKey == null ? null : `layout:${coalesceKey}`),

    moveSection(id, toColId, beforeSectionId = null) {
      const { doc, layout } = state
      const section = doc.sections.find(s => s.id === id)
      const placed = placeSections(doc, layout)[toColId]
      if (!section || !placed) return false
      const after = beforeSectionId == null ? placed.at(-1)?.section.id ?? null : null
      const ops = sectionConfig(layout, section).column === toColId ? [] : [{ path: ['sections', id, 'column'], value: toColId }]
      return commit({
        content: moveSectionSource(state.content, doc, id, beforeSectionId, after),
        layout: applyLayoutOps(layout, ops),
      })
    },

    /** Content and layout fixes; false for `action` fixes (the caller runs them) and stale content fixes. */
    applyFix(issue) {
      const fix = issue?.fix
      if (fix?.kind === 'layout') return commit({ layout: applyLayoutOps(state.layout, fix.ops) })
      if (fix?.kind !== 'content') return false
      const { content, stale } = applyContentEdits(state.content, fix.edits)
      return !stale && commit({ content })
    },

    applyTemplate: template => commit({ layout: templateLayout(state.layout, template) }),

    undo: () => step(past, future),
    redo: () => step(future, past),

    select: sel => set({ selection: sel ?? null }),
    setCaretLine: n => set({ caretLine: n }),
    reveal: line => set({ reveal: { line, seq: (state.reveal?.seq ?? 0) + 1 } }),
    setUi: patch => set({ ui: { ...state.ui, ...patch } }),
    setRender({ report = null, placement = null } = {}) {
      const { content: source, doc, layout } = state
      const issues = runPreflight({ source, doc, layout, report, placement, now: now(), lang: layout.lang })
      set({ report, placement, issues })
    },

    newDoc,
    openDoc,
    duplicateDoc() {
      flush()
      const copy = { ...toContainer(), name: `${state.name} (copy)`.trim() }
      load(uid(), copy)
      save()
    },
    renameDoc(name) {
      set({ name: String(name ?? '') })
      save()
    },
    deleteDoc(id) {
      storage.deleteDoc(id)
      files.delete(id)
      if (id !== state.docId) return set({ docs: storage.listDocs() })
      clearTimeout(timer) // the deleted doc must not be re-saved
      timer = null
      const next = storage.listDocs()[0]
      if (!next || !openDoc(next.id)) newDoc()
    },

    /** Import a `*.cv.json` (object or text) as a new document; returns the migrated file, `fonts` included. */
    loadFile(container, { handle = null } = {}) {
      flush()
      const { file, warnings } = migrateFile(container)
      const id = uid()
      if (handle) files.set(id, { file: { name: handle.name, savedAt: now() }, handle, status: 'file' })
      load(id, file, warnings)
      save()
      return file
    },

    markSaved({ name, savedAt = now(), handle } = {}) {
      const file = { name, savedAt }
      files.set(state.docId, { file, handle: handle === undefined ? files.get(state.docId)?.handle ?? null : handle, status: 'file' })
      set({ file, saveStatus: 'file' })
    },

    toContainer,
    /** Write a pending autosave now (page hide/unload); no-op when nothing is pending. */
    flush,
  }
}
