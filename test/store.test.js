import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../src/store.js'
import { createMemoryStorage, createBrowserStorage } from '../src/io/storage.js'
import { fontsToBase64, base64ToBlob } from '../src/io/files.js'

const tick = () => new Promise(r => setTimeout(r, 5))

function setup(opts = {}) {
  const storage = opts.storage ?? createMemoryStorage()
  const store = createStore({ storage, debounceMs: 0, ...opts })
  store.newDoc()
  return { store, storage }
}

// Injectable clock: advance(ms) moves time forward.
function clock(start = Date.UTC(2026, 0, 1)) {
  let t = start
  const now = () => new Date(t)
  now.advance = ms => { t += ms }
  return now
}

const ids = store => store.state.doc.sections.map(s => s.id)
const replaceLine = (content, from, to) => content.split('\n').map(l => l === from ? to : l).join('\n')

test('newDoc has the skeleton with 4 sections and a locale page size', () => {
  const { store } = setup()
  assert.deepEqual(ids(store), ['summary', 'experience', 'education', 'skills'])
  assert.ok(store.state.doc.header.name)
  assert.equal(store.state.layout.page.size, 'Letter') // default locale en-US
  assert.equal(setup({ locale: 'de-DE' }).store.state.layout.page.size, 'A4')
  assert.equal(store.state.canUndo, false)
  assert.equal(store.state.saveStatus, 'browser')
  assert.deepEqual(store.state.docs.map(d => d.id), [store.state.docId])
})

test('setContent updates content and doc', () => {
  const { store } = setup()
  store.setContent('# Jane\n\n## Work\nx')
  assert.equal(store.state.content, '# Jane\n\n## Work\nx')
  assert.equal(store.state.doc.header.name, 'Jane')
  assert.deepEqual(ids(store), ['work'])
})

test('typing through a heading rename keeps the section config', () => {
  const now = clock()
  const { store } = setup({ now })
  store.setLayout([{ path: ['sections', 'experience', 'variant'], value: 'timeline' }])
  const base = store.state.content
  for (const title of ['Experien', 'Experienc', 'Experience']) {
    now.advance(100)
    store.setContent(replaceLine(base, '## Experience', `## ${title}`))
  }
  assert.equal(store.state.layout.sections.experience.variant, 'timeline')
  assert.equal(store.state.layout.sections.experien, undefined)
})

test('setLayout with the same coalesceKey is one undo step', () => {
  const { store } = setup()
  const before = store.state.layout
  store.setLayout([{ path: ['page', 'margins', 'left'], value: 20 }], { coalesceKey: 'margin-left' })
  store.setLayout([{ path: ['page', 'margins', 'left'], value: 24 }], { coalesceKey: 'margin-left' })
  assert.equal(store.state.layout.page.margins.left, 24)
  store.undo()
  assert.deepEqual(store.state.layout, before)
  assert.equal(store.state.canUndo, false)
})

test('setLayout without a key, or with a different key, makes separate steps', () => {
  const { store } = setup()
  store.setLayout([{ path: ['grid', 'gutter'], value: 10 }])
  store.setLayout([{ path: ['grid', 'gutter'], value: 12 }])
  store.setLayout([{ path: ['grid', 'gutter'], value: 14 }], { coalesceKey: 'a' })
  store.setLayout([{ path: ['grid', 'gutter'], value: 16 }], { coalesceKey: 'b' })
  store.undo()
  assert.equal(store.state.layout.grid.gutter, 14)
  store.undo()
  store.undo()
  assert.equal(store.state.layout.grid.gutter, 10)
})

test('a setLayout that changes nothing adds no history', () => {
  const { store } = setup()
  store.setLayout([{ path: ['grid', 'gutter'], value: 8 }])
  assert.equal(store.state.canUndo, false)
})

test('undo then redo restores content and layout', () => {
  const { store } = setup()
  const c0 = store.state.content
  store.setContent('# A')
  store.setLayout([{ path: ['theme', 'density'], value: 0.9 }])
  const after = { content: store.state.content, layout: store.state.layout }
  store.undo()
  store.undo()
  assert.equal(store.state.content, c0)
  assert.equal(store.state.canRedo, true)
  store.redo()
  store.redo()
  assert.deepEqual({ content: store.state.content, layout: store.state.layout }, after)
  assert.equal(store.state.doc.header.name, 'A')
  assert.equal(store.state.canRedo, false)
  store.redo() // no-op
  assert.equal(store.state.content, '# A')
})

test('a new edit after undo clears redo', () => {
  const { store } = setup()
  store.setContent('# A')
  store.undo()
  store.setLayout([{ path: ['grid', 'gutter'], value: 3 }])
  assert.equal(store.state.canRedo, false)
})

test('text edits within 1 s coalesce into one undo step', () => {
  const now = clock()
  const { store } = setup({ now })
  const c0 = store.state.content
  store.setContent('# A')
  now.advance(400)
  store.setContent('# AB')
  now.advance(900)
  store.setContent('# ABC')
  now.advance(1500)
  store.setContent('# ABCD')
  store.undo()
  assert.equal(store.state.content, '# ABC')
  store.undo()
  assert.equal(store.state.content, c0)
})

test('moveSection moves source lines and sets the column in one undo step', () => {
  const { store } = setup()
  store.setLayout([{ path: ['grid', 'columns'], value: [{ id: 'main', width: 2 }, { id: 'side', width: 1 }] }])
  store.moveSection('summary', 'side') // no section in 'side' yet → EOF
  assert.deepEqual(ids(store), ['experience', 'education', 'skills', 'summary'])
  assert.equal(store.state.layout.sections.summary.column, 'side')
  store.moveSection('skills', 'side') // after the last section placed in 'side'
  assert.deepEqual(ids(store), ['experience', 'education', 'summary', 'skills'])
  store.moveSection('education', 'side', 'summary')
  assert.deepEqual(ids(store), ['experience', 'education', 'summary', 'skills'])
  assert.equal(store.state.layout.sections.education.column, 'side')
  store.undo()
  assert.deepEqual(ids(store), ['experience', 'education', 'summary', 'skills'])
  assert.equal(store.state.layout.sections.education, undefined)
  store.undo()
  assert.deepEqual(ids(store), ['experience', 'education', 'skills', 'summary'])
  assert.equal(store.state.layout.sections.skills, undefined)
})

test('moveSection within the same column does not add a column override', () => {
  const { store } = setup()
  store.moveSection('skills', 'main', 'summary')
  assert.deepEqual(ids(store), ['skills', 'summary', 'experience', 'education'])
  assert.deepEqual(store.state.layout.sections, {})
})

test('applyFix: content, stale content, layout and action fixes', () => {
  const { store } = setup()
  const c0 = store.state.content
  const lines = c0.split('\n')
  const stale = { fix: { kind: 'content', edits: [{ line: 1, expect: 'nope', text: '# X' }] } }
  assert.equal(store.applyFix(stale), false)
  assert.equal(store.state.content, c0)
  assert.equal(store.state.canUndo, false)
  assert.equal(store.applyFix({ fix: { kind: 'content', edits: [{ line: 1, expect: lines[0], text: '# Fixed' }] } }), true)
  assert.equal(store.state.doc.header.name, 'Fixed')
  assert.equal(store.applyFix({ fix: { kind: 'layout', ops: [{ path: ['theme', 'lineHeight'], value: 1.25 }] } }), true)
  assert.equal(store.state.layout.theme.lineHeight, 1.25)
  assert.equal(store.applyFix({ fix: { kind: 'action', action: 'fit-pages', pages: 1 } }), false)
  assert.equal(store.applyFix({ rule: 'x' }), false)
  store.undo()
  store.undo()
  assert.equal(store.state.content, c0)
})

test('applyTemplate keeps hidden sections, one undo step', () => {
  const { store } = setup()
  store.setLayout([{ path: ['sections', 'skills'], value: { hidden: true, variant: 'tags' } }])
  store.applyTemplate({ layout: { theme: { colorAccent: '#aa0000' } }, sectionDefaults: {} })
  assert.equal(store.state.layout.theme.colorAccent, '#aa0000')
  assert.deepEqual(store.state.layout.sections, { skills: { hidden: true } })
  store.undo()
  assert.equal(store.state.layout.sections.skills.variant, 'tags')
})

test('loadFile of garbage gives a usable doc and invalid-file warning', () => {
  const { store } = setup()
  const first = store.state.docId
  store.loadFile('garbage')
  assert.notEqual(store.state.docId, first)
  assert.ok(store.state.warnings.includes('invalid-file'))
  assert.equal(store.state.content, '')
  assert.equal(store.state.layout.version, 1)
  assert.equal(store.state.docs.length, 2)
})

test('loadFile of a container returns the file, keeps fonts out of storage, tracks the handle', () => {
  const { store, storage } = setup()
  const handle = { name: 'jane.cv.json' }
  const file = store.loadFile({ format: 'recto', version: 1, name: 'Jane', content: '# Jane', layout: {}, fonts: [{ family: 'F', data: 'AA==' }] }, { handle })
  assert.equal(file.fonts.length, 1)
  assert.equal(store.state.name, 'Jane')
  assert.deepEqual(store.state.warnings, [])
  assert.equal(store.state.saveStatus, 'file')
  assert.equal(store.state.file.name, 'jane.cv.json')
  assert.equal(store.handle, handle)
  assert.equal(storage.loadDoc(store.state.docId).fonts, undefined)
  assert.equal(store.toContainer().fonts, undefined)
  assert.deepEqual(Object.keys(store.toContainer()), ['format', 'version', 'name', 'content', 'layout'])
})

test('handles are kept per document', () => {
  const { store } = setup()
  const a = store.state.docId
  store.markSaved({ name: 'a.cv.json', handle: { name: 'a.cv.json' } })
  store.newDoc()
  assert.equal(store.handle, null)
  assert.equal(store.state.file, null)
  store.openDoc(a)
  assert.equal(store.handle.name, 'a.cv.json')
  assert.equal(store.state.file.name, 'a.cv.json')
})

test('markSaved sets file status; an edit returns to browser status', () => {
  const now = clock()
  const { store } = setup({ now })
  store.markSaved({ name: 'x.cv.json' })
  assert.equal(store.state.saveStatus, 'file')
  assert.deepEqual(store.state.file, { name: 'x.cv.json', savedAt: now() })
  store.setContent('# B')
  assert.equal(store.state.saveStatus, 'browser')
  assert.equal(store.state.file.name, 'x.cv.json')
})

test('saveDoc quota failure sets saveStatus error; a later success clears it', async () => {
  let fail = true
  const mem = createMemoryStorage()
  const storage = { ...mem, saveDoc: (id, c) => fail ? { ok: false, error: 'quota' } : mem.saveDoc(id, c) }
  const { store } = setup({ storage })
  assert.equal(store.state.saveStatus, 'error')
  store.setContent('# Q')
  await tick()
  assert.equal(store.state.saveStatus, 'error')
  fail = false
  store.setContent('# R')
  await tick()
  assert.equal(store.state.saveStatus, 'browser')
})

test('duplicateDoc makes a new id with a (copy) name', () => {
  const { store, storage } = setup()
  store.renameDoc('Jane CV')
  store.setContent('# Jane')
  const a = store.state.docId
  store.duplicateDoc()
  assert.notEqual(store.state.docId, a)
  assert.equal(store.state.name, 'Jane CV (copy)')
  assert.equal(store.state.content, '# Jane')
  assert.equal(storage.loadDoc(a).content, '# Jane') // pending edit flushed before switching
  assert.deepEqual(store.state.docs.map(d => d.name).sort(), ['Jane CV', 'Jane CV (copy)'])
})

test('deleteDoc removes it from the index and opens another doc', async () => {
  const { store, storage } = setup()
  const a = store.state.docId
  store.newDoc()
  const b = store.state.docId
  store.deleteDoc(a)
  assert.deepEqual(store.state.docs.map(d => d.id), [b])
  assert.equal(storage.loadDoc(a), null)
  store.setContent('# pending')
  store.deleteDoc(b) // current doc: opens a fresh one, the deleted doc is not re-saved
  await tick()
  assert.equal(storage.loadDoc(b), null)
  assert.notEqual(store.state.docId, b)
  assert.equal(store.state.docs.length, 1)
})

test('openDoc reads the stored doc; unknown id returns false', () => {
  const { store } = setup()
  const a = store.state.docId
  store.setContent('# Stored')
  store.newDoc()
  assert.equal(store.openDoc(a), true)
  assert.equal(store.state.content, '# Stored')
  assert.equal(store.state.canUndo, false)
  assert.equal(store.openDoc('missing'), false)
  assert.equal(store.state.docId, a)
})

test('subscribers get changedKeys; unsubscribe stops calls', () => {
  const { store } = setup()
  const calls = []
  const off = store.subscribe((state, keys) => calls.push([state, keys]))
  store.setContent('# Z')
  assert.equal(calls.length, 1)
  assert.ok(calls[0][1].has('content'))
  assert.ok(calls[0][1].has('doc'))
  assert.equal(calls[0][0], store.state)
  store.setCaretLine(3)
  assert.deepEqual([...calls[1][1]], ['caretLine'])
  off()
  store.setContent('# Y')
  assert.equal(calls.length, 2)
})

test('state is a frozen snapshot', () => {
  const { store } = setup()
  const s = store.state
  store.setContent('# New')
  assert.notEqual(store.state, s)
  assert.ok(Object.isFrozen(store.state))
})

test('reveal increments seq; select, setUi, setRender', () => {
  const seen = []
  const runPreflight = args => { seen.push(args); return [{ rule: 'r', severity: 'warn' }] }
  const { store } = setup({ runPreflight })
  store.reveal(4)
  store.reveal(4)
  assert.deepEqual(store.state.reveal, { line: 4, seq: 2 })
  store.select({ kind: 'section', id: 'skills' })
  assert.deepEqual(store.state.selection, { kind: 'section', id: 'skills' })
  store.setUi({ xray: true })
  assert.equal(store.state.ui.xray, true)
  assert.equal(store.state.ui.panel, 'check')
  store.setRender({ report: { pageCount: 1 }, placement: [] })
  assert.deepEqual(store.state.issues, [{ rule: 'r', severity: 'warn' }])
  assert.equal(seen[0].source, store.state.content)
  assert.equal(seen[0].doc, store.state.doc)
  assert.equal(seen[0].lang, 'en')
  assert.deepEqual(seen[0].report, { pageCount: 1 })
  assert.ok(seen[0].now instanceof Date)
})

test('autosave is debounced', async () => {
  const mem = createMemoryStorage()
  let saves = 0
  const storage = { ...mem, saveDoc: (id, c) => (saves++, mem.saveDoc(id, c)) }
  const { store } = setup({ storage })
  saves = 0
  store.setContent('# One')
  store.setContent('# Two')
  assert.equal(saves, 0)
  await tick()
  assert.equal(saves, 1)
  assert.equal(storage.loadDoc(store.state.docId).content, '# Two')
})

test('memory storage: round trip, index newest first, corrupt JSON → null', () => {
  const s = createMemoryStorage()
  assert.deepEqual(s.saveDoc('a', { name: 'A', content: 'x', fonts: [{ family: 'F', data: '' }] }), { ok: true })
  s.saveDoc('b', { name: 'B', content: 'y' })
  assert.deepEqual(s.loadDoc('a'), { name: 'A', content: 'x' })
  assert.deepEqual(s.listDocs().map(d => [d.id, d.name]), [['b', 'B'], ['a', 'A']])
  s.saveDoc('a', { name: 'A2', content: 'z' })
  assert.deepEqual(s.listDocs().map(d => d.id), ['a', 'b'])
  assert.equal(typeof s.listDocs()[0].updatedAt, 'number')
  s.deleteDoc('a')
  assert.deepEqual(s.listDocs().map(d => d.id), ['b'])
  assert.equal(s.loadDoc('a'), null)
  assert.equal(typeof s.onExternalChange(() => {}), 'function')
})

function fakeLs(setItem) {
  const m = new Map()
  return { getItem: k => m.get(k) ?? null, setItem: setItem ?? ((k, v) => m.set(k, v)), removeItem: k => m.delete(k), m }
}

test('browser storage maps quota errors and survives corrupt data', () => {
  const quota = createBrowserStorage(fakeLs(() => { throw new DOMException('full', 'QuotaExceededError') }))
  assert.deepEqual(quota.saveDoc('a', { name: 'A' }), { ok: false, error: 'quota' })
  const other = createBrowserStorage(fakeLs(() => { throw new Error('boom') }))
  assert.deepEqual(other.saveDoc('a', { name: 'A' }), { ok: false, error: 'unknown' })
  const ls = fakeLs()
  ls.m.set('recto:index', '{nope')
  ls.m.set('recto:doc:x', '{nope')
  const s = createBrowserStorage(ls)
  assert.deepEqual(s.listDocs(), [])
  assert.equal(s.loadDoc('x'), null)
  const none = createBrowserStorage(null) // localStorage blocked
  assert.deepEqual(none.listDocs(), [])
  assert.deepEqual(none.saveDoc('a', {}), { ok: false, error: 'unknown' })
})

test('fonts round trip through base64', async () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => i % 256)
  const [f] = await fontsToBase64([{ family: 'My Font', blob: new Blob([bytes]) }])
  assert.equal(f.family, 'My Font')
  const back = new Uint8Array(await base64ToBlob(f.data, 'font/woff2').arrayBuffer())
  assert.deepEqual(back, bytes)
  assert.equal(base64ToBlob(f.data, 'font/woff2').type, 'font/woff2')
})
