// Templates gallery (spec 5.3): a modal grid with a live page-1 thumbnail of the current content per template.
import { h, uid } from './dom.js'
import { applyTemplate } from '../model/templates.js'
import { createPagesHost, layoutPages } from '../render/pages.js'

const PX_PER_MM = 96 / 25.4
const THUMB_W = 184 // px; matches .app-thumb in app.css

// Each card gets its own pages host; the container clips it to page 1, scaled with transform.
async function renderThumb(host, doc, layout) {
  const { width, height } = layout.page
  const scale = THUMB_W / (width * PX_PER_MM)
  host.style.width = `${width * PX_PER_MM}px`
  host.style.transform = `scale(${scale})`
  host.parentElement.style.height = `${height * PX_PER_MM * scale}px`
  await layoutPages(doc, layout, createPagesHost(host))
}

export function openGallery(store, ctx, templates) {
  const { t } = ctx
  const titleId = uid('gallery')
  const { doc, layout } = store.state
  let close

  function apply(template) {
    close()
    store.applyTemplate(template)
    ctx.toast(t('gallery.applied', { name: template.name ?? template.id }), { action: { label: t('app.undo'), run: () => store.undo() } })
  }

  const cards = templates.map(template => {
    const host = h('div', { class: 'app-thumb__host' })
    const card = h('button', { class: 'app-gallery__card', type: 'button', onClick: () => apply(template) },
      h('div', { class: 'app-thumb', inert: true }, host),
      h('span', { class: 'app-gallery__name' }, template.name ?? template.id),
      template.description && h('span', { class: 'app-gallery__desc ui-muted' }, template.description))
    return { card, host, layout: applyTemplate(layout, template) }
  })

  const dialog = h('dialog', { class: 'ui-dialog ui-dialog--wide', 'aria-labelledby': titleId, closedby: 'any' },
    h('header', { class: 'ui-dialog__head' },
      h('h2', { class: 'ui-dialog__title', id: titleId }, t('gallery.title')),
      h('span', { class: 'ui-spacer' }),
      h('button', { class: 'ui-btn ui-btn--ghost', type: 'button', onClick: () => close() }, t('gallery.keep'))),
    h('div', { class: 'ui-dialog__body' },
      h('div', { class: 'app-gallery' }, cards.length ? cards.map(c => c.card) : h('p', { class: 'app-gallery__empty ui-muted' }, t('gallery.empty')))))
  close = ctx.openDialog(dialog)

  // one at a time, in order, so the first cards appear first; stop once the dialog is closed
  const renderAll = async () => {
    for (const c of cards) {
      if (!dialog.open) return
      await renderThumb(c.host, doc, c.layout).catch(err => console.warn('gallery: thumbnail failed', err))
    }
  }
  renderAll()
  return close
}
