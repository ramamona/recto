// Discover view (discover-apply spec §5): full-screen like the jobs board. Left: scan settings and the company list;
// right: Scan with progress, filter chips and the ranked feed with Save · Skip · Prepare application per card.
import { h, uid, replaceChildren } from './dom.js'
import { loadProfile, REMOTE } from '../profile.js'
import { openFile, download } from '../io/files.js'

const DAY = 864e5
const GOOD_SCORE = 4 // the ★ chip: "apply"-level jobs only
const SOURCE_NAMES = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', remotive: 'Remotive', arbeitnow: 'Arbeitnow' }
const safeUrl = u => /^https?:\/\//i.test(u ?? '') ? u : null
const splitList = s => String(s ?? '').split(/[,\n]/).map(v => v.trim()).filter(Boolean)

async function loadStarter() {
  try {
    const res = await fetch('data/companies.json')
    return res.ok ? await res.json() : []
  } catch {
    return []
  }
}

/** Whole days since `postedAt`, or null when unknown. */
export function ageDays(postedAt, now = new Date()) {
  const at = Date.parse(postedAt)
  return Number.isFinite(at) ? Math.max(0, Math.floor((+now - at) / DAY)) : null
}

/** Results left after the filter chips: `score` (★ ≥ 4), `remote` (remote only), `hideSaved` (with `statusOf(id)`). */
export function applyChips(results, chips, statusOf = () => null) {
  return results.filter(r => (!chips.score || r.evaluation?.score >= GOOD_SCORE) &&
    (!chips.remote || r.posting.remote === true) &&
    (!chips.hideSaved || statusOf(r.posting.id) !== 'saved'))
}

export async function openDiscover(store, ctx) {
  const { t, tracker } = ctx
  let engine, sources
  try {
    [engine, sources] = await Promise.all([import('../jobs/discover.js'), import('../jobs/sources.js')])
  } catch (err) {
    console.warn('recto: discover unavailable', err)
    return ctx.toast?.(t('discover.unavailable'))
  }
  const starter = await loadStarter()
  // undefined storage = the modules' own guarded localStorage
  let settings = engine.loadDiscoverSettings(undefined, loadProfile())
  let companies = sources.loadCompanies(undefined, starter)
  let results = []
  let errors = []
  let scanning = null // AbortController
  let progress = null // { done, total }
  const chips = { score: false, remote: false, hideSaved: false }
  const titleId = uid('discover')

  const live = h('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' })
  const settingsCol = h('aside', { class: 'dc-settings', 'aria-label': t('discover.settings') })
  const bar = h('div', { class: 'dc-bar' })
  const errorBox = h('div', { class: 'dc-errors' })
  const feed = h('div', { class: 'dc-feed' })

  const setSettings = patch => { settings = engine.saveDiscoverSettings({ ...settings, ...patch }, undefined, loadProfile()) }
  const setCompanies = list => {
    companies = sources.normalizeCompanies(list)
    sources.saveCompanies(companies)
    renderSettings()
  }
  const statusOf = id => tracker.get(id)?.status ?? null

  // ---------- settings column ----------
  function field(label, control, hint) {
    control.id ||= uid('dc')
    return h('div', { class: 'ai-field' }, h('label', { class: 'ui-label', htmlFor: control.id }, label), control,
      hint && h('p', { class: 'ui-muted ai-hint' }, hint))
  }
  const listInput = (key, placeholder) => h('input', {
    class: 'ui-input', type: 'text', value: settings[key].join(', '), placeholder, dataset: { field: key },
    onChange: e => setSettings({ [key]: splitList(e.target.value) })
  })
  const numInput = (key, min, max, step) => h('input', {
    class: 'ui-input dc-num', type: 'number', min, max, step, value: settings[key], dataset: { field: key },
    onChange: e => { setSettings({ [key]: e.target.value }); e.target.value = settings[key] }
  })
  const setFeed = (name, patch) => setSettings({ feeds: { ...settings.feeds, [name]: { ...settings.feeds[name], ...patch } } })

  function companyEditor() {
    const source = h('select', { class: 'ui-select', 'aria-label': t('discover.company.source') },
      sources.ATS.map(s => h('option', { value: s }, SOURCE_NAMES[s])))
    const board = h('input', { class: 'ui-input', type: 'text', placeholder: t('discover.company.board'), 'aria-label': t('discover.company.board') })
    const name = h('input', { class: 'ui-input', type: 'text', placeholder: t('discover.company.name'), 'aria-label': t('discover.company.name') })
    const add = () => {
      const b = board.value.trim()
      if (!b) return board.focus()
      const before = companies.length
      setCompanies([...companies, { source: source.value, board: b, name: name.value.trim() || b }])
      if (companies.length === before) ctx.toast?.(t('discover.company.invalid'))
      settingsCol.querySelector('[data-field="board"]')?.focus()
    }
    board.dataset.field = 'board'
    board.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add() } })
    return [
      h('h2', {}, t('discover.companies', { n: companies.length })),
      h('p', { class: 'ui-muted ai-hint' }, t('discover.companies.hint')),
      companies.length ? h('ul', { class: 'dc-companies' }, companies.map((c, i) => h('li', {},
        h('span', { title: `${SOURCE_NAMES[c.source]} · ${c.board}` }, c.name || c.board),
        h('span', { class: 'ui-muted' }, SOURCE_NAMES[c.source]),
        h('button', {
          class: 'ui-btn ui-btn--sm ui-btn--ghost', type: 'button', 'aria-label': t('discover.company.remove', { name: c.name || c.board }),
          onClick: () => setCompanies(companies.filter((_, k) => k !== i))
        }, '×'))))
        : h('p', { class: 'ui-muted' }, t('discover.companies.empty')),
      h('div', { class: 'dc-add' }, source, board, h('span'), name),
      h('div', { class: 'dc-row' },
        h('button', { class: 'ui-btn ui-btn--sm', type: 'button', dataset: { action: 'discover-add' }, onClick: add }, t('discover.company.add')),
        h('button', { class: 'ui-btn ui-btn--sm', type: 'button', onClick: importCompanies }, t('jobs.import')),
        h('button', { class: 'ui-btn ui-btn--sm', type: 'button', onClick: () => download('recto-companies.json', sources.exportCompanies(companies), 'application/json') }, t('jobs.export')),
        starter.length > 0 && h('button', { class: 'ui-btn ui-btn--sm', type: 'button', onClick: () => setCompanies(starter) }, t('discover.starter')))
    ]
  }

  async function importCompanies() {
    try {
      const f = await openFile({ accept: '.json' })
      if (!f) return
      const { companies: got, warnings } = sources.importCompanies(f.text)
      const before = companies.length
      setCompanies([...companies, ...got])
      ctx.toast?.(t('discover.company.imported', { count: companies.length - before, skipped: warnings.length }))
    } catch (err) {
      console.error(err)
      ctx.toast?.(t('app.file.failed'))
    }
  }

  function renderSettings() {
    const remotive = settings.feeds.remotive
    const remote = h('select', { class: 'ui-select', dataset: { field: 'remote' }, onChange: e => setSettings({ remote: e.target.value }) },
      REMOTE.map(r => h('option', { value: r, selected: r === settings.remote }, t(`profile.remote.${r}`))))
    const toggle = (name, label) => h('label', { class: 'ai-row' },
      h('input', { type: 'checkbox', checked: settings.feeds[name].enabled, dataset: { feed: name }, onChange: e => setFeed(name, { enabled: e.target.checked }) }), label)
    replaceChildren(settingsCol,
      h('h2', {}, t('discover.filters')),
      field(t('discover.roles'), listInput('roles', t('discover.roles.placeholder')), t('discover.roles.hint')),
      field(t('discover.locations'), listInput('locations', t('discover.locations.placeholder'))),
      field(t('profile.remote'), remote),
      h('div', { class: 'dc-row' },
        field(t('discover.maxAge'), numInput('maxAgeDays', 1, 365, 1)),
        field(t('discover.minScore'), numInput('minScore', 0, 5, 0.5))),
      companyEditor(),
      h('h2', {}, t('discover.feeds')),
      toggle('remotive', t('discover.feed.remotive')),
      field(t('discover.feed.query'), h('input', {
        class: 'ui-input', type: 'text', value: remotive.query, placeholder: settings.roles[0] ?? '',
        onChange: e => setFeed('remotive', { query: e.target.value })
      })),
      toggle('arbeitnow', t('discover.feed.arbeitnow')))
  }

  // ---------- scan ----------
  async function scan() {
    if (scanning) return scanning.abort()
    const ac = scanning = new AbortController()
    progress = { done: 0, total: 0 }
    errors = []
    render()
    try {
      const s = store.state
      const r = await engine.discover({
        companies, feeds: settings.feeds, settings, profile: loadProfile(), tracker, now: new Date(), signal: ac.signal,
        cv: { source: s.content, doc: s.doc, layout: s.layout, issues: s.issues, report: s.report },
        fetch: (...a) => globalThis.fetch(...a), // read at call time: stubs and polyfills apply
        onProgress: p => { progress = p; renderBar() }
      })
      results = r.results
      errors = r.errors
      live.textContent = t('discover.found', { count: results.length })
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.error('recto: discover failed', err)
        ctx.toast?.(t('discover.failed'))
      }
    } finally {
      scanning = null
      render()
    }
  }

  // ---------- per-card actions ----------
  // New jobs keep the local evaluation so the board shows their ★ and match; an existing job keeps its status unless skipped.
  function track({ posting: p, evaluation: ev, match }, status) {
    const cur = tracker.get(p.id)
    tracker.save({
      ...cur, id: p.id, url: p.url, applyUrl: p.applyUrl, source: p.source, board: p.board, title: p.title, company: p.company,
      location: p.location, text: p.text, postedAt: p.postedAt, questions: p.questions ?? cur?.questions, status: cur && status !== 'skipped' ? cur.status : status
    })
    if (!cur && ev) tracker.addEvaluation(p.id, { source: 'local', score: ev.score, recommendation: ev.recommendation, match: match?.score })
    return cur
  }

  function save(r) {
    track(r, 'saved')
    live.textContent = t('discover.saved', { title: r.posting.title })
    render()
  }

  function skip(r) {
    const prev = track(r, 'skipped')
    results = results.filter(x => x !== r)
    render()
    ctx.toast?.(t('discover.skipped', { title: r.posting.title }), {
      action: {
        label: t('app.undo'),
        run() {
          if (prev) tracker.save(prev)
          else tracker.remove(r.posting.id)
          results = [...results, r].sort((a, b) => b.evaluation.score - a.evaluation.score || b.match.score - a.match.score)
          render()
        }
      }
    })
  }

  function prepare(r) {
    track(r, 'saved')
    render()
    ctx.openPack?.(r.posting.id, { onChange: render })
  }

  // ---------- feed ----------
  function attribution(p) {
    const url = safeUrl(p.url)
    // Remotive's terms: name Remotive and link back to the posting on remotive.com
    if (p.source === 'remotive') return h('p', { class: 'dc-attrib' }, t('discover.via'), ' ', url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Remotive') : 'Remotive')
    return h('p', { class: 'dc-attrib' }, t('discover.from', { source: SOURCE_NAMES[p.source] ?? p.source }))
  }

  function card(r) {
    const { posting: p, evaluation: ev, match, legitimacy } = r
    const status = statusOf(p.id)
    const days = ageDays(p.postedAt)
    const url = safeUrl(p.url)
    const meta = [p.location, p.remote === true && !/remote/i.test(p.location) && t('discover.remote'), days != null && t(days ? 'discover.age' : 'discover.today', { days })].filter(Boolean).join(' · ')
    const act = (action, label, run, cls = '') => h('button', { class: `ui-btn ui-btn--sm ${cls}`.trim(), type: 'button', dataset: { action }, onClick: () => run(r) }, label)
    return h('article', { class: `dc-card${status === 'saved' ? ' is-saved' : ''}`, dataset: { posting: p.id, source: p.source } },
      h('p', { class: 'dc-card__company' }, p.company),
      h('h3', { class: 'dc-card__title' }, url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, p.title) : p.title),
      meta && h('p', { class: 'dc-card__meta ui-muted' }, meta),
      h('p', { class: 'dc-card__scores' },
        ev && h('span', { class: 'board-chip board-chip--stars' }, t('discover.stars', { score: ev.score.toFixed(1) })),
        match && h('span', { class: 'board-chip' }, t('board.match', { score: Math.round(match.score) })),
        legitimacy?.level && h('span', { class: `dc-legit is-${legitimacy.level}` }, t(`job.legit.${legitimacy.level}`)),
        p.salary && h('span', { class: 'ui-muted' }, p.salary)),
      attribution(p),
      h('div', { class: 'dc-card__actions' },
        status === 'saved' ? h('span', { class: 'ui-badge is-ok' }, t('discover.isSaved')) : act('discover-save', t('discover.save'), save),
        act('discover-skip', t('discover.skip'), skip, 'ui-btn--ghost'),
        act('discover-prepare', t('pack.prepare'), prepare, 'ui-btn--primary')))
  }

  function chip(key, label) {
    return h('button', {
      class: 'dc-chip', type: 'button', 'aria-pressed': String(chips[key]), dataset: { chip: key },
      onClick: () => { chips[key] = !chips[key]; render() }
    }, label)
  }

  function renderBar() {
    const scanBtn = h('button', {
      class: `ui-btn ${scanning ? '' : 'ui-btn--primary'}`.trim(), type: 'button', dataset: { action: 'discover-scan' }, onClick: scan
    }, scanning ? t('app.cancel') : t('discover.scan'))
    replaceChildren(bar, scanBtn,
      scanning && h('span', { class: 'dc-progress', role: 'status' }, t('discover.progress', { done: progress?.done ?? 0, total: progress?.total ?? 0 })),
      !scanning && results.length > 0 && h('span', { class: 'ui-muted' }, t('discover.found', { count: results.length })),
      h('span', { class: 'ui-spacer' }),
      chip('score', t('discover.chip.score', { score: GOOD_SCORE })),
      chip('remote', t('discover.chip.remote')),
      chip('hideSaved', t('discover.chip.hideSaved')))
  }

  function render() {
    renderBar()
    replaceChildren(errorBox, ...(errors.length ? [h('details', {},
      h('summary', {}, t('discover.errors', { count: errors.length })),
      h('ul', {}, errors.map(e => h('li', {}, `${SOURCE_NAMES[e.source] ?? e.source}${e.board && e.board !== e.source ? ` · ${e.board}` : ''}: ${e.message}`))))] : []))
    const shown = applyChips(results, chips, statusOf)
    replaceChildren(feed, ...(shown.length ? shown.map(card)
      : [h('p', { class: 'dc-empty ui-muted' }, t(scanning ? 'discover.scanning' : results.length ? 'discover.noneShown' : 'discover.empty'))]))
  }

  const dialog = h('dialog', { class: 'board discover', 'aria-labelledby': titleId },
    h('header', { class: 'board-head' },
      h('h1', { class: 'board-head__title', id: titleId }, t('discover.title')),
      h('span', { class: 'ui-muted' }, t('discover.intro')),
      h('span', { class: 'ui-spacer' }),
      h('button', { class: 'ui-btn ui-btn--sm', type: 'button', onClick: () => ctx.openProfileDialog?.() }, t('cmd.app.profile')),
      h('button', { class: 'ui-btn ui-btn--sm ui-btn--primary', type: 'button', dataset: { action: 'discover-close' }, onClick: () => close() }, t('board.close'))),
    h('div', { class: 'discover-body' }, settingsCol, h('section', { class: 'dc-main', 'aria-label': t('discover.results') }, bar, errorBox, feed)),
    live)
  dialog.addEventListener('close', () => scanning?.abort(), { once: true })
  renderSettings()
  render()
  const close = ctx.openDialog(dialog)
  bar.querySelector('[data-action="discover-scan"]')?.focus()
  return close
}
