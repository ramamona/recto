// Inspector (spec 5.3 Right): Page, Theme, Section, Decor and CSS tabs. Controls are built from field
// descriptors and write through store.setLayout. A tab is rebuilt only when its shape changes; otherwise
// values sync in place, so a slider drag or an open colour picker never loses its element.
import { ENUMS, FONT_PRESETS, PAGE_SIZES, RANGES, VARIANTS, applyLayoutOps, getPath, sectionConfig } from '../model/layout.js'
import { LANGS } from '../model/categories.js'
import { remix } from '../model/remix.js'
import { FONT_STACKS } from '../render/theme.js'
import { downscalePhoto, registerFonts, saveFont } from '../io/storage.js'
import { h, uid } from './dom.js'

const TABS = ['page', 'theme', 'section', 'decor', 'css']
const SIDES = ['top', 'right', 'bottom', 'left']
const SIZES = ['sizeName', 'sizeSection', 'sizeEntry', 'sizeBody', 'sizeSmall']
const GAPS = ['gapParagraph', 'gapEntry', 'gapSection']
const COLORS = ['colorText', 'colorMuted', 'colorAccent', 'colorRule', 'colorPage']
const FONTS = ['fontHeading', 'fontBody', 'fontMono']
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const REMIX_TRIES = 10

const fmt = v => typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : ''
const toPicker = v => !HEX.test(v ?? '') ? '#000000' : v.length === 4 ? '#' + [...v.slice(1)].map(c => c + c).join('') : v.slice(0, 7)
const isActive = el => el === document.activeElement
const issueKey = i => `${i.rule}|${i.sectionId ?? ''}|${i.line ?? ''}`

/** Accessible tab bar (roving tabindex, arrow keys). Shared with panels.js. */
export function makeTabs(ids, label, onPick, name) {
  const buttons = ids.map(id => h('button', {
    type: 'button', class: 'ui-tab', role: 'tab', id: uid('tab'), dataset: { tab: id }, onClick: () => onPick(id),
  }, label(id)))
  const bar = h('div', { class: 'ui-tabs', role: 'tablist', 'aria-label': name }, buttons)
  bar.addEventListener('keydown', e => {
    const i = buttons.indexOf(document.activeElement)
    const moves = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: ids.length - 1 }
    if (i < 0 || !(e.key in moves)) return
    e.preventDefault()
    const n = (moves[e.key] + ids.length) % ids.length
    onPick(ids[n])
    buttons[n].focus()
  })
  const select = id => {
    for (const b of buttons) {
      const on = b.dataset.tab === id
      b.setAttribute('aria-selected', String(on))
      b.tabIndex = on ? 0 : -1
    }
    return buttons.find(b => b.dataset.tab === id)
  }
  return { bar, buttons, select }
}

// ---------- controls: each returns { el, set(value, force) } and reports edits through commit(value) ----------

function numberControl(d, id, key, commit) {
  const el = h('input', { class: 'ui-input', type: 'number', id, min: d.min, max: d.max, step: d.step ?? 1, dataset: { key } })
  el.addEventListener('change', () => {
    const v = parseFloat(el.value)
    commit(Number.isFinite(v) ? v : undefined, !Number.isFinite(v))
  })
  return { el, set: (v, force) => { if (force || !isActive(el)) el.value = fmt(v) } }
}

function rangeControl(d, id, key, commit) {
  const input = h('input', { class: 'ui-input', type: 'range', id, min: d.min, max: d.max, step: d.step, dataset: { key } })
  const out = h('output', { class: 'insp-readout', htmlFor: id })
  input.addEventListener('input', () => commit(parseFloat(input.value)))
  return {
    el: h('span', { class: 'insp-range' }, input, out),
    set: (v, force) => {
      if (force || !isActive(input)) input.value = String(v)
      out.value = fmt(v)
    },
  }
}

function selectControl(d, id, key, commit) {
  const el = h('select', { class: 'ui-select', id, dataset: { key } },
    d.options.map(o => h('option', { value: o.value, style: o.style }, o.label)))
  el.addEventListener('change', () => commit(el.value))
  return { el, set: v => { el.value = String(v ?? '') } }
}

function toggleControl(d, id, key, commit) {
  const el = h('input', { class: 'ui-check', type: 'checkbox', id, dataset: { key } })
  el.addEventListener('change', () => commit(el.checked))
  return { el, set: v => { el.checked = !!v } }
}

function textControl(d, id, key, commit) {
  const el = h('input', { class: 'ui-input insp-text', type: 'text', id, placeholder: d.placeholder, dataset: { key } })
  el.addEventListener('change', () => commit(el.value))
  return { el, set: (v, force) => { if (force || !isActive(el)) el.value = v ?? '' } }
}

// <input type="color"> for picking plus a hex text input for exact values; optional colours can be cleared.
function colorControl(d, id, key, commit, t) {
  const picker = h('input', { class: 'ui-input', type: 'color', 'aria-label': d.label, dataset: { key: `${key}:picker` } })
  const text = h('input', {
    class: 'ui-input insp-hex', type: 'text', id, spellcheck: false, maxLength: 9,
    placeholder: d.optional ? t('inspector.color.none') : '#000000', dataset: { key },
  })
  picker.addEventListener('input', () => commit(picker.value))
  text.addEventListener('change', () => {
    const raw = text.value.trim()
    const v = raw && !raw.startsWith('#') ? `#${raw}` : raw
    if (!v && d.optional) return commit(d.empty)
    commit(v, !HEX.test(v))
  })
  const clear = d.optional && h('button', {
    type: 'button', class: 'ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm', 'aria-label': t('inspector.color.clear', { label: d.label }),
    title: t('inspector.color.clear', { label: d.label }), dataset: { key: `${key}:clear` }, onClick: () => commit(d.empty),
  }, '×')
  return {
    el: h('span', { class: 'insp-color' }, picker, text, clear),
    set: (v, force) => {
      if (force || !isActive(picker)) picker.value = toPicker(v)
      if (force || !isActive(text)) text.value = v ?? ''
      picker.classList.toggle('is-empty', !v)
      if (clear) clear.disabled = !v
    },
  }
}

const CONTROLS = { number: numberControl, range: rangeControl, select: selectControl, toggle: toggleControl, text: textControl, color: colorControl }

export function mountInspector(root, store, ctx) {
  const { t } = ctx
  let syncs = [] // refreshers of the built tab
  let shape = null

  const tabs = makeTabs(TABS, id => t(`inspector.tab.${id}`), id => store.setUi({ inspectorTab: id }), t('inspector.title'))
  const body = h('div', { class: 'ui-scroll insp-body', role: 'tabpanel', tabIndex: -1 })
  root.replaceChildren(tabs.bar, body)

  const activeTab = s => TABS.includes(s.ui.inspectorTab) ? s.ui.inspectorTab : 'page'
  const toast = (key, vars) => ctx.toast?.(t(key, vars))

  // ---------- builders ----------

  const row = (label, id, control, unit) => h('div', { class: 'ui-field' },
    h('label', { htmlFor: id }, label),
    h('div', { class: 'ui-field__control' }, control, unit && h('span', { class: 'ui-unit' }, unit)))

  const group = (title, ...children) => h('section', { class: 'ui-group' }, h('h3', { class: 'ui-group__title' }, title), children)

  const button = (label, onClick, props = {}) => h('button', { type: 'button', class: 'ui-btn ui-btn--sm', onClick, ...props }, label)

  const opts = values => values.map(v => ({ value: v, label: t(`inspector.opt.${v || 'none'}`) }))

  /** d = { path, kind, label, min, max, step, options, unit, optional, empty, get(state), ops(value), key } */
  function field(d) {
    const id = uid('insp')
    const key = d.key ?? d.path.join('.')
    const get = () => d.get ? d.get(store.state) : getPath(store.state.layout, d.path)
    const c = CONTROLS[d.kind](d, id, key, (value, invalid) => {
      if (!invalid) store.setLayout(d.ops ? d.ops(value) : [{ path: d.path, value }], { coalesceKey: key })
      c.set(get(), true) // show the normalized value even while focused
    }, t)
    syncs.push(() => c.set(get(), false))
    c.set(get(), true)
    return row(d.label, id, c.el, d.unit)
  }

  const num = (path, label, min, max, step, unit, extra) => field({ path, kind: 'number', label, min, max, step, unit, ...extra })

  // ---------- Page ----------

  const colLabel = (l, id) => t('inspector.column', { n: l.grid.columns.findIndex(c => c.id === id) + 1, id })

  function langOptions(current) {
    let names = null
    try { names = new Intl.DisplayNames([navigator.language, 'en'], { type: 'language' }) } catch { /* labels fall back to codes */ }
    return [...new Set([...LANGS, current])].map(v => ({ value: v, label: names?.of(v) ?? v }))
  }

  async function uploadPhoto(input) {
    const [file] = input.files
    input.value = ''
    if (!file) return
    try {
      const src = await downscalePhoto(file)
      store.setLayout([{ path: ['header', 'photo'], value: { ...store.state.layout.header.photo, src } }])
    } catch (err) {
      toast(err?.message === 'photo-too-large' ? 'inspector.photo.tooLarge' : 'inspector.photo.failed')
    }
  }

  function moveColumn(i, delta) {
    const order = [...store.state.layout.grid.readingOrder]
    const j = i + delta
    if (j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j], order[i]]
    store.setLayout([{ path: ['grid', 'readingOrder'], value: order }], { coalesceKey: 'grid.readingOrder' })
  }

  function pageTab(s) {
    const l = s.layout
    const cols = l.grid.columns
    const setCustom = k => v => [{ path: ['page', 'size'], value: 'custom' }, { path: ['page', k], value: v }]
    const photo = l.header.photo
    const photoInput = h('input', { type: 'file', accept: 'image/*', hidden: true, class: 'insp-file-photo', onChange: e => uploadPhoto(e.target) })
    return [
      group(t('inspector.group.page'),
        field({ path: ['page', 'size'], kind: 'select', label: t('inspector.page.size'), options: ENUMS.pageSize.map(v => ({
          value: v, label: v === 'custom' ? t('inspector.opt.custom') : `${v} · ${PAGE_SIZES[v].join(' × ')} mm`,
        })) }),
        num(['page', 'width'], t('inspector.page.width'), 80, 600, 0.1, 'mm', { ops: setCustom('width') }),
        num(['page', 'height'], t('inspector.page.height'), 80, 600, 0.1, 'mm', { ops: setCustom('height') }),
        SIDES.map(k => num(['page', 'margins', k], t(`inspector.page.margin.${k}`), 0, 60, 0.5, 'mm')),
        num(['page', 'targetPages'], t('inspector.page.targetPages'), 1, 10, 1),
        field({ path: ['lang'], kind: 'select', label: t('inspector.page.lang'), options: langOptions(l.lang) })),
      group(t('inspector.group.columns'),
        cols.map((c, i) => {
          const p = k => ['grid', 'columns', i, k]
          return h('div', { class: 'insp-col' },
            h('div', { class: 'insp-col__head' }, h('strong', null, colLabel(l, c.id)),
              cols.length > 1 && button(t('inspector.column.remove'),
                () => store.setLayout([{ path: ['grid', 'columns', i], value: undefined }]),
                { class: 'ui-btn ui-btn--sm ui-btn--danger', dataset: { key: `col-remove-${c.id}` } })),
            num(p('width'), t('inspector.column.width'), 0.2, 5, 0.1, 'fr'),
            field({ path: p('bg'), kind: 'color', label: t('inspector.column.bg'), optional: true }),
            field({ path: p('bleed'), kind: 'toggle', label: t('inspector.column.bleed') }),
            h('details', { class: 'insp-more' }, h('summary', null, t('inspector.column.colors')),
              ['textColor', 'mutedColor', 'accentColor'].map(k =>
                field({ path: p(k), kind: 'color', label: t(`inspector.column.${k}`), optional: true }))))
        }),
        cols.length < 3 && button(t('inspector.column.add'),
          () => store.setLayout([{ path: ['grid', 'columns', cols.length], value: { width: 1 } }]), { dataset: { key: 'col-add' } }),
        num(['grid', 'gutter'], t('inspector.grid.gutter'), 0, 40, 0.5, 'mm')),
      group(t('inspector.group.header'),
        field({ path: ['grid', 'headerSpan'], kind: 'select', label: t('inspector.header.span'), options: [
          { value: 'full', label: t('inspector.header.full') }, ...cols.map(c => ({ value: c.id, label: colLabel(l, c.id) })),
        ] }),
        field({ path: ['header', 'align'], kind: 'select', label: t('inspector.header.align'), options: opts(ENUMS.align) }),
        h('div', { class: 'insp-actions' }, photoInput,
          button(t(photo ? 'inspector.photo.replace' : 'inspector.photo.upload'), () => photoInput.click(), { dataset: { key: 'photo-upload' } }),
          photo && button(t('inspector.photo.remove'), () => store.setLayout([{ path: ['header', 'photo'], value: null }]),
            { class: 'ui-btn ui-btn--sm ui-btn--danger' })),
        photo && [
          num(['header', 'photo', 'size'], t('inspector.photo.size'), 10, 80, 1, 'mm'),
          field({ path: ['header', 'photo', 'shape'], kind: 'select', label: t('inspector.photo.shape'), options: opts(ENUMS.photoShape) }),
          field({ path: ['header', 'photo', 'position'], kind: 'select', label: t('inspector.photo.position'), options: opts(ENUMS.photoPosition) }),
        ]),
      cols.length > 1 && group(t('inspector.group.order'),
        h('p', { class: 'insp-hint' }, t('inspector.order.hint')),
        h('ol', { class: 'insp-order' }, l.grid.readingOrder.map((id, i, all) => h('li', null,
          h('span', { class: 'insp-order__name' }, colLabel(l, id)),
          button('↑', () => moveColumn(i, -1), { disabled: i === 0, 'aria-label': t('inspector.order.up', { name: colLabel(l, id) }), dataset: { key: `ro-up-${id}` } }),
          button('↓', () => moveColumn(i, 1), { disabled: i === all.length - 1, 'aria-label': t('inspector.order.down', { name: colLabel(l, id) }), dataset: { key: `ro-down-${id}` } }))))),
    ]
  }

  // ---------- Theme ----------

  // Uploaded families: faces added to document.fonts plus any font:<family> the theme already uses.
  function customFamilies(theme) {
    const loaded = [...(document.fonts ?? [])].map(f => f.family.replace(/^(["'])(.*)\1$/, '$2'))
    const used = FONTS.map(k => theme[k]).filter(v => v.startsWith('font:')).map(v => v.slice(5))
    return [...new Set([...loaded, ...used])].sort()
  }

  function fontOptions(theme) {
    return [
      ...FONT_PRESETS.map(p => ({ value: p, label: t(`inspector.font.${p}`), style: { fontFamily: FONT_STACKS[p] } })),
      ...customFamilies(theme).map(f => ({ value: `font:${f}`, label: f })),
    ]
  }

  async function uploadFont(input) {
    const [file] = input.files
    input.value = ''
    if (!file) return
    const family = file.name.replace(/\.(woff2?|ttf|otf)$/i, '').replace(/[^\p{L}\p{N} _-]+/gu, ' ').trim().slice(0, 60) || 'Custom font'
    const loaded = await registerFonts([{ family, blob: file }])
    if (!loaded.includes(family)) return toast('inspector.font.failed')
    try { await saveFont(family, file) } catch { toast('inspector.font.notStored') }
    store.setLayout(['fontHeading', 'fontBody'].map(k => ({ path: ['theme', k], value: `font:${family}` })))
  }

  async function busy(btn, fn) {
    btn.disabled = true
    try { await fn() } finally { btn.disabled = false }
  }

  async function fit() {
    const pages = store.state.layout.page.targetPages
    const res = await ctx.canvas?.fit?.(pages)
    if (res?.reachedFloor) toast('inspector.fit.floor', { n: pages })
  }

  // Retry until a look renders with zero errors and no warning the current look doesn't already have.
  async function doRemix() {
    const evaluate = ctx.canvas?.evaluate
    if (!evaluate) return
    const base = store.state.layout
    const known = new Set(store.state.issues.filter(i => i.severity === 'warn').map(issueKey))
    for (let i = 0; i < REMIX_TRIES; i++) {
      const ops = remix(base)
      const issues = await evaluate(applyLayoutOps(base, ops))
      if (issues.some(x => x.severity === 'error' || (x.severity === 'warn' && !known.has(issueKey(x))))) continue
      store.setLayout(ops) // one history step
      return
    }
    toast('inspector.remix.none')
  }

  function themeTab(s) {
    const th = s.layout.theme
    const p = k => ['theme', k]
    const fontInput = h('input', { type: 'file', accept: '.woff2,.woff,.ttf,.otf', hidden: true, class: 'insp-file-font', onChange: e => uploadFont(e.target) })
    const fitBtn = button('', () => busy(fitBtn, fit), { class: 'ui-btn ui-btn--sm ui-btn--primary', dataset: { key: 'fit' } })
    const remixBtn = button(t('inspector.remix'), () => busy(remixBtn, doRemix), { dataset: { key: 'remix' } })
    syncs.push(() => { fitBtn.textContent = t('inspector.fit', { n: store.state.layout.page.targetPages }) })
    return [
      group(t('inspector.group.look'),
        h('div', { class: 'insp-actions' }, fitBtn, remixBtn),
        field({ path: p('density'), kind: 'range', label: t('inspector.theme.density'), min: RANGES.density[0], max: RANGES.density[1], step: 0.01 })),
      group(t('inspector.group.fonts'),
        FONTS.map(k => field({ path: p(k), kind: 'select', label: t(`inspector.theme.${k}`), options: fontOptions(th) })),
        h('div', { class: 'insp-actions' }, fontInput,
          button(t('inspector.font.upload'), () => fontInput.click(), { dataset: { key: 'font-upload' } }))),
      group(t('inspector.group.sizes'),
        SIZES.map(k => num(p(k), t(`inspector.theme.${k}`), ...RANGES[k], 0.25, 'pt'))),
      group(t('inspector.group.spacing'),
        num(p('lineHeight'), t('inspector.theme.lineHeight'), ...RANGES.lineHeight, 0.05),
        GAPS.map(k => num(p(k), t(`inspector.theme.${k}`), ...RANGES[k], 0.1, 'mm'))),
      group(t('inspector.group.colors'),
        COLORS.map(k => field({ path: p(k), kind: 'color', label: t(`inspector.theme.${k}`) })),
        field({ path: p('colorHeading'), key: 'theme.colorHeading.mode', kind: 'select', label: t('inspector.theme.colorHeading'),
          options: opts(['accent', 'text', 'custom']),
          get: st => HEX.test(st.layout.theme.colorHeading) ? 'custom' : st.layout.theme.colorHeading,
          ops: v => [{ path: p('colorHeading'), value: v === 'custom' ? store.state.layout.theme.colorAccent : v }] }),
        HEX.test(th.colorHeading) && field({ path: p('colorHeading'), kind: 'color', label: t('inspector.theme.colorHeadingCustom') })),
      group(t('inspector.group.headings'),
        field({ path: p('headingCase'), kind: 'select', label: t('inspector.theme.headingCase'), options: opts(ENUMS.headingCase) }),
        field({ path: p('headingRule'), kind: 'select', label: t('inspector.theme.headingRule'), options: opts(ENUMS.headingRule) }),
        num(p('headingLetterSpacing'), t('inspector.theme.headingLetterSpacing'), ...RANGES.headingLetterSpacing, 0.005, 'em'),
        num(p('headingWeight'), t('inspector.theme.headingWeight'), ...RANGES.headingWeight, 100),
        num(p('nameWeight'), t('inspector.theme.nameWeight'), ...RANGES.nameWeight, 100),
        field({ path: p('nameCase'), kind: 'select', label: t('inspector.theme.nameCase'), options: opts(ENUMS.nameCase) })),
      group(t('inspector.group.details'),
        field({ path: p('bulletChar'), kind: 'select', label: t('inspector.theme.bulletChar'),
          options: ENUMS.bulletChar.map(v => ({ value: v, label: v || t('inspector.opt.none') })) }),
        field({ path: p('dateStyle'), kind: 'select', label: t('inspector.theme.dateStyle'), options: opts(ENUMS.dateStyle) }),
        field({ path: p('linkStyle'), kind: 'select', label: t('inspector.theme.linkStyle'), options: opts(ENUMS.linkStyle) })),
    ]
  }

  // ---------- Section ----------

  const selected = (s, kind, list) => s.selection?.kind === kind ? list.find(x => x.id === s.selection.id) ?? null : null

  function picker(label, value, options, onPick, key) {
    const id = uid('insp')
    const el = h('select', { class: 'ui-select insp-picker', id, dataset: { key } }, options.map(o => h('option', { value: o.value }, o.label)))
    el.value = value
    el.addEventListener('change', () => onPick(el.value))
    return row(label, id, el)
  }

  function sectionTab(s) {
    const secs = s.doc.sections
    if (!secs.length) return group(t('inspector.tab.section'), h('p', { class: 'insp-hint' }, t('inspector.section.empty')))
    const sec = selected(s, 'section', secs)
    const pick = picker(t('inspector.section.pick'), sec?.id ?? '', [
      { value: '', label: t('inspector.section.choose') },
      ...secs.map(x => ({ value: x.id, label: x.title || t('inspector.section.untitled') })),
    ], id => {
      const x = secs.find(y => y.id === id)
      store.select(x ? { kind: 'section', id } : null)
      if (x) store.reveal(x.line)
    }, 'section-pick')
    if (!sec) return group(t('inspector.tab.section'), pick, h('p', { class: 'insp-hint' }, t('inspector.section.hint')))
    const cfg = k => st => {
      const x = st.doc.sections.find(y => y.id === sec.id)
      return x && sectionConfig(st.layout, x)[k]
    }
    const f = (k, kind, extra) => field({ path: ['sections', sec.id, k], kind, label: t(`inspector.section.${k}`), get: cfg(k), ...extra })
    const panel = sectionConfig(s.layout, sec).panel
    // panel is merged as a whole, so edits write the full resolved panel
    const pf = (k, kind, extra) => f(k, kind, {
      label: t(`inspector.panel.${k}`), key: `sections.${sec.id}.panel.${k}`,
      get: st => cfg('panel')(st)?.[k],
      ops: v => [{ path: ['sections', sec.id, 'panel'], value: { ...cfg('panel')(store.state), [k]: v } }],
      ...extra,
    })
    return [
      group(t('inspector.tab.section'), pick,
        f('column', 'select', { options: s.layout.grid.columns.map(c => ({ value: c.id, label: colLabel(s.layout, c.id) })) }),
        f('variant', 'select', { options: opts(VARIANTS) }),
        ['hidden', 'showTitle', 'ruleAbove', 'ruleBelow', 'breakBefore', 'keepTogether'].map(k => f(k, 'toggle'))),
      group(t('inspector.group.panel'),
        f('panel', 'toggle', { key: `sections.${sec.id}.panel`, get: st => !!cfg('panel')(st), ops: v => [{ path: ['sections', sec.id, 'panel'], value: v ? {} : null }] }),
        panel && [
          pf('bg', 'color'),
          pf('border', 'select', { options: opts(ENUMS.panelBorder) }),
          pf('borderColor', 'color'),
          pf('borderWidth', 'number', { min: 0, max: 5, step: 0.1, unit: 'mm' }),
          pf('radius', 'number', { min: 0, max: 20, step: 0.5, unit: 'mm' }),
          pf('padding', 'number', { min: 0, max: 20, step: 0.5, unit: 'mm' }),
        ]),
    ]
  }

  // ---------- Decor ----------

  function addDecor(kind) {
    const l = store.state.layout
    const m = l.page.margins
    const line = kind === 'line'
    store.setLayout([{ path: ['decor', l.decor.length], value: {
      kind, x: m.left, y: m.top, w: line ? l.page.width - m.left - m.right : 40, h: line ? 0 : 20,
      fill: line ? null : '#f3f4f6', stroke: line ? l.theme.colorAccent : null,
    } }])
    const d = store.state.layout.decor.at(-1)
    if (d) store.select({ kind: 'decor', id: d.id })
  }

  function parsePages(v) {
    const pages = String(v).split(/[\s,;]+/).map(Number).filter(n => Number.isInteger(n) && n >= 1)
    return pages.length ? pages : 'all'
  }

  function decorTab(s) {
    const l = s.layout
    const item = selected(s, 'decor', l.decor)
    const label = d => `${t(`inspector.opt.${d.kind}`)} · ${d.id}`
    const head = group(t('inspector.tab.decor'),
      l.decor.length
        ? picker(t('inspector.decor.pick'), item?.id ?? '', [{ value: '', label: t('inspector.decor.choose') }, ...l.decor.map(d => ({ value: d.id, label: label(d) }))],
          id => store.select(id ? { kind: 'decor', id } : null), 'decor-pick')
        : h('p', { class: 'insp-hint' }, t('inspector.decor.empty')),
      h('div', { class: 'insp-actions' }, ENUMS.decorKind.map(k =>
        button(t(`inspector.decor.add.${k}`), () => addDecor(k), { dataset: { key: `decor-add-${k}` } }))))
    if (!item) return head
    const i = l.decor.indexOf(item)
    const p = k => ['decor', i, k]
    const geo = (k, max) => num(p(k), t(`inspector.decor.${k}`), -50, max + 50, 0.5, 'mm')
    return [head, group(label(item),
      field({ path: p('kind'), kind: 'select', label: t('inspector.decor.kind'), options: opts(ENUMS.decorKind) }),
      field({ path: p('pages'), key: `decor.${i}.pages.mode`, kind: 'select', label: t('inspector.decor.pages'), options: opts([...ENUMS.decorPages, 'custom']),
        get: st => { const v = st.layout.decor[i]?.pages; return Array.isArray(v) ? 'custom' : v },
        ops: v => [{ path: p('pages'), value: v === 'custom' ? [1] : v }] }),
      Array.isArray(item.pages) && field({ path: p('pages'), kind: 'text', label: t('inspector.decor.pageList'), placeholder: '1, 3',
        get: st => [].concat(st.layout.decor[i]?.pages ?? []).join(', '), ops: v => [{ path: p('pages'), value: parsePages(v) }] }),
      geo('x', l.page.width), geo('y', l.page.height), geo('w', l.page.width), geo('h', l.page.height),
      field({ path: p('fill'), kind: 'color', label: t('inspector.decor.fill'), optional: true, empty: null }),
      field({ path: p('stroke'), kind: 'color', label: t('inspector.decor.stroke'), optional: true, empty: null }),
      num(p('strokeWidth'), t('inspector.decor.strokeWidth'), 0, 10, 0.1, 'mm'),
      item.kind === 'rect' && num(p('radius'), t('inspector.decor.radius'), 0, 100, 0.5, 'mm'),
      field({ path: p('opacity'), kind: 'range', label: t('inspector.decor.opacity'), min: 0, max: 1, step: 0.05 }),
      field({ path: p('z'), kind: 'select', label: t('inspector.decor.z'), options: opts(ENUMS.decorZ) }),
      h('div', { class: 'insp-actions' }, button(t('inspector.decor.delete'), () => {
        store.setLayout([{ path: ['decor', i], value: undefined }])
        store.select(null)
      }, { class: 'ui-btn ui-btn--sm ui-btn--danger' })))]
  }

  // ---------- CSS ----------

  function cssTab() {
    const id = uid('insp')
    const ta = h('textarea', { class: 'ui-textarea insp-css', id, spellcheck: false, rows: 18, placeholder: '.cv-section-title { letter-spacing: 0.04em; }', dataset: { key: 'customCss' } })
    ta.value = store.state.layout.customCss
    // every keystroke commits; the coalesce key keeps one history entry per editing run
    ta.addEventListener('input', () => store.setLayout([{ path: ['customCss'], value: ta.value }], { coalesceKey: 'customCss' }))
    syncs.push(() => { if (!isActive(ta)) ta.value = store.state.layout.customCss })
    return group(t('inspector.tab.css'), h('label', { class: 'insp-hint', htmlFor: id }, t('inspector.css.hint')), ta)
  }

  // ---------- update loop ----------

  const TAB = {
    page: { build: pageTab, shape: s => [s.layout.grid.columns.map(c => c.id), s.layout.grid.readingOrder, !!s.layout.header.photo, s.layout.lang] },
    theme: { build: themeTab, shape: s => [HEX.test(s.layout.theme.colorHeading), customFamilies(s.layout.theme)] },
    section: {
      build: sectionTab,
      shape: s => {
        const sec = selected(s, 'section', s.doc.sections)
        return [sec?.id, s.doc.sections.map(x => [x.id, x.title]), s.layout.grid.columns.map(c => c.id), sec && !!sectionConfig(s.layout, sec).panel]
      },
    },
    decor: {
      build: decorTab,
      shape: s => {
        const item = selected(s, 'decor', s.layout.decor)
        return [item?.id, s.layout.decor.map(d => [d.id, d.kind]), Array.isArray(item?.pages), s.layout.page.width, s.layout.page.height]
      },
    },
    css: { build: cssTab, shape: () => [] },
  }

  function rebuild(s, tab) {
    const focusKey = body.contains(document.activeElement) ? document.activeElement.dataset.key : null
    const top = body.scrollTop
    syncs = []
    body.replaceChildren(...[TAB[tab].build(s)].flat(Infinity).filter(Boolean))
    for (const f of syncs) f()
    body.setAttribute('aria-labelledby', tabs.select(tab).id)
    body.scrollTop = top
    if (focusKey == null) return
    const el = [...body.querySelectorAll('[data-key]')].find(e => e.dataset.key === focusKey)
    ;(el && !el.disabled ? el : body).focus({ preventScroll: true })
  }

  function update() {
    const s = store.state
    const tab = activeTab(s)
    const next = JSON.stringify([tab, TAB[tab].shape(s)])
    if (next !== shape) {
      shape = next
      rebuild(s, tab)
    } else for (const f of syncs) f()
  }

  store.subscribe((s, changed) => {
    // selecting on the canvas or in the Check panel brings its tab forward
    const want = s.selection?.kind
    if (changed.has('selection') && want && activeTab(s) !== want) return store.setUi({ inspectorTab: want })
    if (['layout', 'doc', 'selection', 'ui'].some(k => changed.has(k))) update()
  })
  document.fonts?.addEventListener?.('loadingdone', update) // uploaded or boot-registered faces join the font lists
  update()
}
