// Import review (Task 19): the converted Markdown, editable, next to a live preview in the current
// document's layout, with the converter's low-confidence notes. "Import" creates a new document.
import { h, uid, debounce } from './dom.js'
import { parse } from '../model/markdown.js'
import { createPagesHost, layoutPages } from '../render/pages.js'

const PX_PER_MM = 96 / 25.4
const KEEP = [['page'], ['grid'], ['theme'], ['sectionDefaults'], ['decor'], ['header', 'align'], ['lang']]

// Selects 1-based line `n` of the textarea and scrolls it into view.
function selectLine(area, n) {
  const lines = area.value.split('\n')
  const k = Math.min(Math.max(1, n), lines.length) - 1
  const start = lines.slice(0, k).reduce((sum, l) => sum + l.length + 1, 0)
  area.focus()
  area.setSelectionRange(start, start + lines[k].length)
  area.scrollTop = Math.max(0, (k - 2) * (parseFloat(getComputedStyle(area).lineHeight) || 16))
}

/** Opens the review dialog; `onPaste` (optional) opens the paste-text dialog instead. Returns close(). */
export function openImportReview(store, ctx, { content = '', notes = [], warnings = [], fileName = '', name = '', onPaste } = {}) {
  const { t } = ctx
  const layout = store.state.layout
  const titleId = uid('import')
  let close

  const area = h('textarea', { class: 'ui-textarea app-import__src', 'aria-label': t('import.review.source') })
  Object.assign(area, { value: content, spellcheck: false })
  const noteList = notes.length ? h('div', { class: 'app-import__notes' },
    h('h3', { class: 'ui-group__title' }, t('import.review.notes')),
    h('ul', {}, notes.map(n => h('li', {}, h('button', { class: 'app-import__note', type: 'button', onClick: () => selectLine(area, n.line) },
      t(`import.note.${n.code}`, { line: n.line, ...n.vars })))))) : null
  const warning = warnings.length ? h('div', { class: 'app-import__warn', role: 'alert' },
    h('span', {}, warnings.map(w => t(`import.warn.${w}`)).join(' ')),
    onPaste && h('button', { class: 'ui-btn ui-btn--sm', type: 'button', onClick: () => { close(); onPaste() } }, t('import.review.paste'))) : null

  const host = h('div', { class: 'app-import__host', inert: true })
  const frame = h('div', { class: 'app-import__frame' }, host)
  const pages = createPagesHost(host)
  let seq = 0
  async function render() {
    const mine = ++seq
    const scale = Math.min(1, frame.clientWidth / (layout.page.width * PX_PER_MM)) || 0.5
    host.style.width = `${layout.page.width * PX_PER_MM}px`
    host.style.transform = `scale(${scale})`
    try {
      await layoutPages(parse(area.value), layout, pages)
    } catch (err) { console.warn('import: preview failed', err) }
    if (mine === seq) host.parentElement.style.height = `${host.offsetHeight * scale}px`
  }

  const go = h('button', { class: 'ui-btn ui-btn--primary', type: 'button', onClick: importDoc }, t('import.review.go'))
  const sync = () => { go.disabled = !area.value.trim() }
  const later = debounce(render, 250)
  area.addEventListener('input', () => { sync(); later() })
  sync()

  function importDoc() {
    const text = area.value
    if (!text.trim()) return
    close()
    store.newDoc()
    if (name) store.renameDoc(name)
    store.setLayout(KEEP.map(path => ({ path, value: path.reduce((o, k) => o?.[k], layout) })))
    store.setContent(text)
    ctx.toast(t('app.paste.done'))
  }

  const dialog = h('dialog', { class: 'ui-dialog ui-dialog--wide app-import', 'aria-labelledby': titleId, closedby: 'any' },
    h('header', { class: 'ui-dialog__head' },
      h('h2', { class: 'ui-dialog__title', id: titleId }, fileName ? t('import.review.titleFile', { file: fileName }) : t('import.review.title'))),
    h('div', { class: 'ui-dialog__body app-import__body' },
      warning,
      h('p', { class: 'ui-muted app-import__hint' }, t('import.review.hint')),
      h('div', { class: 'app-import__grid' },
        h('div', { class: 'app-import__left' }, area, noteList),
        h('section', { class: 'app-import__preview', 'aria-label': t('import.review.preview') }, frame))),
    h('footer', { class: 'ui-dialog__foot' },
      h('button', { class: 'ui-btn', type: 'button', onClick: () => close() }, t('app.cancel')), go))
  close = ctx.openDialog(dialog)
  dialog.addEventListener('close', () => later.cancel())
  render()
  return close
}
