// Discover view (discover-apply spec §5): full-screen like the jobs board. Left: scan settings and the company list;
// right: Scan with progress, filter chips and the ranked feed with Save · Skip · Prepare application per card.
// Career-suite spec §2: country select, Jobicy feed, SmartRecruiters/Workable boards and "Find boards".
// Career-suite spec §7: card checkboxes, "Select ★≥ n" and "Apply to selected (n)" (apply queue); link to the Pipeline inbox.
import { hubNav } from './hub-nav.js'
import { h, uid, replaceChildren } from './dom.js'
import { loadProfile, REMOTE } from '../profile.js'
import { openFile, download } from '../io/files.js'
import { REGIONS, detectCountry, searchLinks, placeSuggestions } from '../jobs/region.js'

const DAY = 864e5
const GOOD_SCORE = 4 // the ★ chip: "apply"-level jobs only
const SOURCE_NAMES = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', smartrecruiters: 'SmartRecruiters', workable: 'Workable',
  remotive: 'Remotive', arbeitnow: 'Arbeitnow', jobicy: 'Jobicy' }
// Feeds whose terms ask for "via <name>" and a link back to the posting on their site
const VIA = ['remotive', 'jobicy']
const safeUrl = u => /^https?:\/\//i.test(u ?? '') ? u : null
const splitList = s => String(s ?? '').split(/[,\n]/).map(v => v.trim()).filter(Boolean)

// The browser's guess at the user's country (settings/profile country wins; see normalizeDiscoverSettings)
function browserCountry() {
  try {
    return detectCountry({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: globalThis.navigator?.language })
  } catch {
    return ''
  }
}

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

/** Ids of results whose ★ score is at least `min`. */
export const selectAbove = (results, min) => results.filter(r => r.evaluation?.score >= min).map(r => r.posting.id)

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
  const detected = browserCountry()
  let settings = engine.loadDiscoverSettings(undefined, loadProfile(), detected)
  let companies = sources.loadCompanies(undefined, starter)
  let results = []
  let errors = []
  let scanning = null // AbortController
  let progress = null // { done, total }
  const chips = { score: false, remote: false, hideSaved: false }
  const selected = new Set() // posting ids ticked for "Apply to selected"
  let companiesOpen = false
  const finder = { name: '', busy: null, found: null } // busy: AbortController; found: findBoards() result
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
  // Several values as removable chips; Enter, a comma or picking a suggestion adds one
  function chipInput(key, placeholder, suggestions = []) {
    const listId = uid('dl')
    const add = raw => {
      const more = splitList(raw).filter(v => !settings[key].some(x => x.toLowerCase() === v.toLowerCase()))
      if (!more.length) return
      setSettings({ [key]: [...settings[key], ...more] })
      renderSettings()
      settingsCol.querySelector(`[data-field="${key}"]`)?.focus()
    }
    const input = h('input', {
      class: 'ui-input dc-chips__input', type: 'text', placeholder, list: listId, dataset: { field: key }, autocomplete: 'off',
      onKeydown: e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(e.target.value) } },
      // picking a suggestion is an input without typing (Chrome: insertReplacementText; Safari/Firefox: no inputType)
      onInput: e => { if (!e.inputType || e.inputType === 'insertReplacementText') add(e.target.value) },
      onChange: e => add(e.target.value)
    })
    return h('div', { class: 'dc-chips' },
      settings[key].map((v, i) => h('span', { class: 'dc-chip' }, v, h('button', {
        class: 'dc-chip__x', type: 'button', 'aria-label': t('discover.chip.removeValue', { value: v }),
        onClick: () => { setSettings({ [key]: settings[key].filter((_, k) => k !== i) }); renderSettings() }
      }, '×'))),
      input, h('datalist', { id: listId }, suggestions.map(v => h('option', { value: v }))))
  }
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
    return [h('details', { class: 'dc-company-list', open: companiesOpen, onToggle: e => { companiesOpen = e.target.open } },
      h('summary', {}, t('discover.companies', { n: companies.length })),
      h('p', { class: 'ui-muted ai-hint' }, t('discover.companies.hintAll')),
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
        starter.length > 0 && h('button', { class: 'ui-btn ui-btn--sm', type: 'button', onClick: () => setCompanies(starter) }, t('discover.starter'))),
      ...boardFinder())]
  }

  // "Find boards": probe a company name's slugs on every ATS, then Add the boards that have jobs
  function boardFinder() {
    const input = h('input', {
      class: 'ui-input', type: 'text', value: finder.name, placeholder: t('discover.find.name'), 'aria-label': t('discover.find.name'),
      dataset: { field: 'find' }, onInput: e => { finder.name = e.target.value }
    })
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); findBoards() } })
    const has = b => companies.some(c => c.source === b.source && c.board.toLowerCase() === b.board.toLowerCase())
    const results = finder.busy ? h('p', { class: 'ui-muted', role: 'status' }, t('discover.find.searching', { name: finder.name.trim() }))
      : !finder.found ? null
      : !finder.found.length ? h('p', { class: 'ui-muted', role: 'status' }, t('discover.find.none', { name: finder.name.trim() }))
      : h('ul', { class: 'dc-companies dc-found' }, finder.found.map(b => h('li', {},
        h('span', { title: `${SOURCE_NAMES[b.source]} · ${b.board}` }, `${SOURCE_NAMES[b.source]} · ${b.board}`),
        h('span', { class: 'ui-muted' }, t('discover.find.jobs', { count: b.jobs })),
        has(b) ? h('span', { class: 'ui-badge is-ok' }, t('discover.find.added'))
          : h('button', {
            class: 'ui-btn ui-btn--sm', type: 'button', dataset: { action: 'discover-find-add' },
            'aria-label': t('discover.find.add', { name: b.name, source: SOURCE_NAMES[b.source] }),
            onClick: () => setCompanies([...companies, { source: b.source, board: b.board, name: b.name }])
          }, t('discover.company.add')))))
    return [
      h('div', { class: 'dc-row' }, input,
        h('button', { class: 'ui-btn ui-btn--sm', type: 'button', dataset: { action: 'discover-find' }, onClick: findBoards },
          finder.busy ? t('app.cancel') : t('discover.find'))),
      results
    ]
  }

  async function findBoards() {
    if (finder.busy) return finder.busy.abort()
    const name = finder.name.trim()
    if (!name) return settingsCol.querySelector('[data-field="find"]')?.focus()
    const ac = finder.busy = new AbortController()
    finder.found = null
    renderSettings()
    const found = await sources.findBoards(name, { fetch: (...a) => globalThis.fetch(...a), signal: ac.signal })
    if (finder.busy !== ac) return
    finder.busy = null
    finder.found = ac.signal.aborted ? null : found
    renderSettings()
    settingsCol.querySelector('[data-action="discover-find-add"]')?.focus()
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
    const country = h('select', { class: 'ui-select', dataset: { field: 'country' }, onChange: e => { setSettings({ country: e.target.value }); renderSettings() } },
      h('option', { value: '', selected: settings.country === '' }, t('discover.country.any')),
      Object.entries(REGIONS).sort(([, a], [, b]) => a.name.localeCompare(b.name))
        .map(([code, r]) => h('option', { value: code, selected: code === settings.country }, r.name)))
    const toggle = (name, label) => h('label', { class: 'ai-row' },
      h('input', { type: 'checkbox', checked: settings.feeds[name].enabled, dataset: { feed: name }, onChange: e => setFeed(name, { enabled: e.target.checked }) }), label)
    const perSource = src => companies.filter(c => c.source === src).length
    const boardToggle = src => h('label', { class: 'ai-row' },
      h('input', {
        type: 'checkbox', checked: settings.boards.includes(src), dataset: { board: src },
        onChange: e => setSettings({ boards: e.target.checked ? [...settings.boards, src] : settings.boards.filter(b => b !== src) })
      }), SOURCE_NAMES[src], h('span', { class: 'ui-muted' }, ` (${perSource(src)})`))
    const roleSuggestions = loadProfile().targetRoles
    replaceChildren(settingsCol,
      h('h2', {}, t('discover.filters')),
      field(t('discover.roles'), chipInput('roles', t('discover.roles.placeholder'), roleSuggestions), t('discover.roles.hint')),
      field(t('discover.country'), country, t('discover.country.hint')),
      field(t('discover.locations'), chipInput('locations', t('discover.locations.placeholder'), placeSuggestions(settings.country)), t('discover.locations.hint')),
      field(t('profile.remote'), remote),
      h('div', { class: 'dc-row' },
        field(t('discover.maxAge'), numInput('maxAgeDays', 1, 365, 1)),
        field(t('discover.minScore'), numInput('minScore', 0, 5, 0.5))),
      h('h2', {}, t('discover.sources')),
      h('p', { class: 'ui-muted ai-hint' }, t('discover.sources.hint')),
      h('div', { class: 'dc-sources' }, sources.ATS.map(boardToggle)),
      companyEditor(),
      h('h3', { class: 'dc-sub' }, t('discover.feeds')),
      toggle('remotive', t('discover.feed.remotive')),
      field(t('discover.feed.query'), h('input', {
        class: 'ui-input', type: 'text', value: remotive.query, placeholder: settings.roles[0] ?? '',
        onChange: e => setFeed('remotive', { query: e.target.value })
      })),
      toggle('arbeitnow', t('discover.feed.arbeitnow')),
      toggle('jobicy', t('discover.feed.jobicy')),
      h('h3', { class: 'dc-sub' }, t('discover.elsewhere')),
      h('p', { class: 'ui-muted ai-hint' }, t('discover.elsewhere.hint')),
      h('div', { class: 'dc-row dc-elsewhere' }, searchLinks(settings.country, { role: settings.roles[0] ?? '', location: settings.locations[0] ?? '' })
        .map(l => h('a', { class: 'ui-btn ui-btn--sm', href: l.url, target: '_blank', rel: 'noopener noreferrer', dataset: { site: l.name } }, l.name))))
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
      const ids = new Set(results.map(x => x.posting.id))
      for (const id of selected) if (!ids.has(id)) selected.delete(id)
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
    // the full local record (rows, role) also feeds Insights' skill gaps and calibration
    if (!cur && ev) tracker.addEvaluation(p.id, { kind: 'local', ...ev, source: 'local', match: match?.score })
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
    selected.delete(r.posting.id)
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

  // Saves the ticked postings (as Save does) and hands them to the apply queue, which takes Saved tracker jobs
  function applySelected() {
    const picked = results.filter(r => selected.has(r.posting.id))
    if (!picked.length || !ctx.openApplyQueue) return
    for (const r of picked) track(r, 'saved')
    selected.clear()
    render()
    ctx.openApplyQueue({ jobIds: picked.map(r => r.posting.id) })
  }

  const selectMin = () => Math.max(GOOD_SCORE, settings.minScore)
  function selectGood() {
    const ids = selectAbove(applyChips(results, chips, statusOf), selectMin())
    for (const id of ids) selected.add(id)
    live.textContent = t('discover.selectedCount', { n: selected.size })
    render()
  }


  // ---------- feed ----------
  function attribution(p) {
    const url = safeUrl(p.url)
    // Remotive's and Jobicy's terms: name the feed and link back to the posting on its site
    const name = SOURCE_NAMES[p.source]
    if (VIA.includes(p.source)) return h('p', { class: 'dc-attrib' }, t('discover.via'), ' ', url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, name) : name)
    return h('p', { class: 'dc-attrib' }, t('discover.from', { source: SOURCE_NAMES[p.source] ?? p.source }))
  }

  function card(r) {
    const { posting: p, evaluation: ev, match, legitimacy } = r
    const status = statusOf(p.id)
    const days = ageDays(p.postedAt)
    const url = safeUrl(p.url)
    const meta = [p.location, p.remote === true && !/remote/i.test(p.location) && t('discover.remote'), days != null && t(days ? 'discover.age' : 'discover.today', { days })].filter(Boolean).join(' · ')
    const act = (action, label, run, cls = '') => h('button', { class: `ui-btn ui-btn--sm ${cls}`.trim(), type: 'button', dataset: { action }, onClick: () => run(r) }, label)
    const tick = h('input', {
      class: 'dc-card__check', type: 'checkbox', checked: selected.has(p.id), dataset: { action: 'discover-select' },
      'aria-label': t('discover.select', { title: p.title }),
      onChange: e => { e.target.checked ? selected.add(p.id) : selected.delete(p.id); renderBar() }
    })
    return h('article', { class: `dc-card${status === 'saved' ? ' is-saved' : ''}`, dataset: { posting: p.id, source: p.source } },
      h('div', { class: 'dc-card__top' }, tick, h('p', { class: 'dc-card__company' }, p.company)),
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
      chip('hideSaved', t('discover.chip.hideSaved')),
      results.length > 0 && h('button', { class: 'ui-btn ui-btn--sm', type: 'button', dataset: { action: 'discover-select-good' }, onClick: selectGood },
        t('discover.selectGood', { minScore: selectMin() })),
      results.length > 0 && ctx.openApplyQueue && h('button', {
        class: 'ui-btn ui-btn--sm ui-btn--primary', type: 'button', disabled: !selected.size, dataset: { action: 'discover-apply-selected' }, onClick: applySelected
      }, t('discover.applySelected', { n: selected.size })))
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
      h('h1', { class: 'visually-hidden', id: titleId }, t('discover.title')),
      hubNav(ctx, 'discover'),
      h('span', { class: 'ui-muted board-head__intro' }, t('discover.intro')),
      h('span', { class: 'ui-spacer' }),
      h('button', { class: 'ui-btn ui-btn--sm', type: 'button', dataset: { action: 'discover-close' }, onClick: () => close() }, t('board.close'))),
    h('div', { class: 'discover-body' }, settingsCol, h('section', { class: 'dc-main', 'aria-label': t('discover.results') }, bar, errorBox, feed)),
    live)
  dialog.addEventListener('close', () => { scanning?.abort(); finder.busy?.abort() }, { once: true })
  renderSettings()
  render()
  const close = ctx.openDialog(dialog)
  bar.querySelector('[data-action="discover-scan"]')?.focus()
  return close
}
