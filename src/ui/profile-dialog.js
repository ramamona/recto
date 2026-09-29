// Candidate profile view (review-jobs spec 3, discover-apply spec 3/5, career-suite spec §3): a full-screen form with a
// section nav, country-driven preset fields, a completeness meter, saved answers and a STAR+R story bank. Feeds the Job
// tab's gates, application packs, the apply queue and `recto autoapply`.
import { hubNav } from './hub-nav.js'
import { h, uid, debounce } from './dom.js'
import {
  loadProfile, saveProfile, normalizeProfile, prefillProfile, activeCountry, REMOTE, EEO_FIELDS, EEO_EXTRA,
  WORK_RIGHTS, EMPLOYMENT_TYPES, TRAVEL, SALARY_BASIS, CHECK_STATES, REFEREES_DEFAULT, MAX_STORIES
} from '../profile.js'
import { REGIONS, countryOf } from '../jobs/region.js'
import { completeness, exportAnswers, importAnswers, findAnswer, remember, normalizeQuestion } from '../jobs/answers.js'
import { download, openFile } from '../io/files.js'

const LISTS = ['authorizedIn', 'locations', 'targetRoles', 'dealBreakers', 'languages']
const TRI = { '': null, yes: true, no: false }
const TRI_FIELDS = ['willingToRelocate', 'driversLicence', 'ownVehicle']
const INPUT_TYPE = { email: 'email', phone: 'tel', linkedin: 'url', github: 'url', website: 'url', portfolio: 'url' }
const SECTIONS = ['identity', 'rights', 'pay', 'checks', 'background', 'preferences', 'diversity', 'answers', 'stories']
const STORY_FIELDS = ['situation', 'task', 'action', 'result', 'reflection']

export const splitList = s => Array.isArray(s) ? s : String(s ?? '').split(/[,\n]/).map(v => v.trim()).filter(Boolean)

/** Raw form values (strings, checkbox booleans, checkbox-group arrays) → normalized profile. Keys missing from `values`
 * keep `base`'s value (fields a preset hides, saved answers, stories); blanks become unset. */
export function toProfile(values, base = {}) {
  const out = { ...base, ...values }
  for (const k of LISTS) if (k in values) out[k] = splitList(values[k])
  for (const k of TRI_FIELDS) if (k in values) out[k] = typeof values[k] === 'boolean' ? values[k] : TRI[values[k]] ?? null
  if (typeof values.employmentTypes === 'string') out.employmentTypes = splitList(values.employmentTypes)
  out.eeo = { ...base.eeo }
  for (const k of [...EEO_FIELDS, ...EEO_EXTRA]) if (`eeo.${k}` in values) out.eeo[k] = values[`eeo.${k}`]
  return normalizeProfile(out)
}

/** Named form controls → raw values; checkboxes with `data-group` collect their checked values into an array. */
export function formValues(elements) {
  const out = {}
  for (const el of elements) {
    if (!el.name) continue
    if (el.type === 'checkbox' && el.dataset?.group) {
      out[el.name] ??= []
      if (el.checked) out[el.name].push(el.value)
    } else out[el.name] = el.type === 'checkbox' ? el.checked : el.value
  }
  return out
}

const browserEnv = () => {
  try { return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: globalThis.navigator?.language ?? '' } } catch { return {} }
}

/** Opens the Candidate profile view; `doc` (the open CV) prefills empty name, email, phone and links; `onSave(profile)`
 * runs after it is stored. */
export function openProfileDialog(ctx, { onSave, doc } = {}) {
  const { t } = ctx
  let draft = prefillProfile(loadProfile(), doc)
  if (!draft.country) draft = { ...draft, country: REGIONS[activeCountry(draft, browserEnv())].name }
  let bank = draft.answers ?? []
  let stories = draft.stories ?? []
  let query = ''
  const code = () => countryOf(draft.country)
  const region = () => REGIONS[code()] ?? null

  const formId = uid('cp-form')
  const titleId = uid('cp-title')
  const form = h('form', { class: 'cp-form', id: formId, novalidate: true, onSubmit: e => { e.preventDefault(); save() } })
  const sectionId = Object.fromEntries(SECTIONS.map(s => [s, uid(`cp-${s}`)]))

  // ---------- header: country, completeness ----------
  const countrySelect = h('select', { class: 'ui-select', name: 'country', form: formId, id: uid('cp-country'), onChange: countryChanged },
    h('option', { value: '' }, t('profile.country.other')),
    Object.values(REGIONS).map(r => h('option', { value: r.name, selected: r.name === draft.country }, r.name)),
    draft.country && !code() && h('option', { value: draft.country, selected: true }, draft.country))
  const meterText = h('span', { class: 'cp-meter__text', id: uid('cp-meter') })
  const meterBar = h('progress', { class: 'cp-meter__bar', 'aria-labelledby': meterText.id })
  const missingList = h('ul', { class: 'cp-missing__list' })
  const missing = h('details', { class: 'cp-missing' }, h('summary', {}, t('profile.meter.show')), missingList)

  const btn = (label, onClick, action, cls = '') => h('button', { class: `ui-btn ui-btn--sm ${cls}`.trim(), type: 'button', dataset: action ? { action } : undefined, onClick }, label)
  const nav = h('nav', { class: 'cp-nav', 'aria-label': t('profile.sections') },
    h('ul', { onKeydown: navKeys }, SECTIONS.map(s => h('li', {},
      h('button', { class: 'cp-nav__item', type: 'button', 'aria-controls': sectionId[s], dataset: { section: s }, onClick: () => go(s) }, t(`profile.section.${s}`))))))

  const dialog = h('dialog', { class: 'cp', 'aria-labelledby': titleId },
    h('header', { class: 'cp-head' },
      h('h1', { class: 'visually-hidden', id: titleId }, t('profile.title')),
      hubNav(ctx, 'profile', { beforeLeave: () => save() }),
      h('label', { class: 'cp-country', htmlFor: countrySelect.id }, t('profile.country'), countrySelect),
      h('div', { class: 'cp-meter' }, meterBar, meterText, missing),
      h('span', { class: 'ui-spacer' }),
      btn(t('app.cancel'), () => close()),
      btn(t('profile.save'), save, 'profile-save', 'ui-btn--primary')),
    h('div', { class: 'cp-body' }, nav, h('div', { class: 'cp-main' }, h('p', { class: 'ui-muted cp-intro' }, t('profile.view.intro')), form)))

  // ---------- form building blocks ----------
  const field = (label, control, hint) => {
    control.id ||= uid('pf')
    const hintEl = hint && h('p', { class: 'ui-muted ai-hint', id: uid('pf-hint') }, hint)
    if (hintEl) control.setAttribute('aria-describedby', hintEl.id)
    return h('div', { class: 'ai-field' }, h('label', { class: 'ui-label', htmlFor: control.id }, label), control, hintEl)
  }
  const input = (name, value, type = 'text', extra = {}) =>
    h('input', { class: 'ui-input', type, name, value: value ?? '', autocomplete: 'off', ...extra })
  const text = (key, label = t(`profile.f.${key}`), extra = {}, hint) => field(label, input(key, draft[key], INPUT_TYPE[key] ?? 'text', extra), hint)
  const listInput = (key, label, hint) => field(label, input(key, (draft[key] ?? []).join(', ')), hint)
  const select = (name, value, options) => h('select', { class: 'ui-select', name },
    options.map(([v, label]) => h('option', { value: v, selected: v === (value ?? '') }, label)))
  const tri = (key, label) => field(label, select(key, draft[key] === true ? 'yes' : draft[key] === false ? 'no' : '',
    Object.keys(TRI).map(v => [v, t(`profile.applicant.relocate.${v || 'unset'}`)])))
  const choice = (key, label, values, labelOf) => field(label, select(key, draft[key], [['', t('profile.unset')], ...values.map(v => [v, labelOf(v)])]))
  const datalist = values => h('datalist', { id: uid('cp-list') }, values.map(v => h('option', { value: v })))
  const grid = (...children) => h('div', { class: 'pf-grid' }, children)
  const section = (id, ...children) => h('fieldset', { class: 'cp-section', id: sectionId[id], dataset: { section: id } },
    h('legend', { class: 'cp-section__title' }, t(`profile.section.${id}`)), children)

  function identity() {
    const states = datalist(region()?.states ?? [])
    return section('identity',
      h('p', { class: 'ui-muted ai-hint' }, t('profile.applicant.intro')),
      grid(text('firstName', t('profile.applicant.firstName')), text('lastName', t('profile.applicant.lastName')), text('preferredName'),
        field(t('profile.applicant.pronouns'), input('pronouns', draft.pronouns))),
      grid(...['email', 'phone', 'linkedin', 'github', 'website'].map(k => text(k, t(`profile.applicant.${k}`))), text('portfolio')),
      grid(text('street'), text('city', t('profile.applicant.city')), text('state', undefined, { list: states.id }), text('postcode')),
      states)
  }

  function rights() {
    const allowed = region()?.workRights ?? WORK_RIGHTS
    const values = draft.workRights && !allowed.includes(draft.workRights) ? [...allowed, draft.workRights] : allowed
    const sponsor = h('input', { type: 'checkbox', checked: draft.needsSponsorship, id: uid('pf'), name: 'needsSponsorship' })
    return section('rights',
      listInput('authorizedIn', t('profile.authorizedIn'), t('profile.authorizedIn.hint')),
      grid(choice('workRights', t('profile.f.workRights'), values, v => t(`profile.f.workRights.${v}`)),
        text('visaType', undefined, { placeholder: t('profile.f.visaType.placeholder') }),
        field(t('profile.f.visaExpiry'), input('visaExpiry', draft.visaExpiry, 'date'))),
      h('label', { class: 'ai-row', htmlFor: sponsor.id }, sponsor, t('profile.needsSponsorship')))
  }

  function pay() {
    const r = region()
    const retirement = r?.retirement ?? t('profile.f.retirement')
    const types = h('fieldset', { class: 'cp-group' }, h('legend', { class: 'ui-label' }, t('profile.f.employmentTypes')),
      EMPLOYMENT_TYPES.map(v => {
        const box = h('input', { type: 'checkbox', name: 'employmentTypes', value: v, checked: (draft.employmentTypes ?? []).includes(v), id: uid('pf'), dataset: { group: '1' } })
        return h('label', { class: 'ai-row', htmlFor: box.id }, box, t(`profile.f.employment.${v}`))
      }))
    return section('pay',
      grid(text('noticePeriod', t('profile.applicant.noticePeriod')), field(t('profile.f.earliestStart'), input('earliestStart', draft.earliestStart, 'date')),
        field(t('profile.remote'), select('remote', draft.remote, REMOTE.map(v => [v, t(`profile.remote.${v}`)]))),
        tri('willingToRelocate', t('profile.applicant.willingToRelocate')),
        choice('willingToTravel', t('profile.f.willingToTravel'), TRAVEL, v => t(`profile.f.travel.${v}`))),
      types,
      listInput('locations', t('profile.locations')),
      grid(text('salaryExpectation', t('profile.applicant.salaryExpectation'), {}, t('profile.f.salaryExpectation.hint', { retirement })),
        choice('salaryBasis', t('profile.f.salaryBasis'), SALARY_BASIS, v => t(`profile.f.salaryBasis.${v}`, { retirement })),
        field(t('profile.salaryMin'), input('salaryMin', draft.salaryMin, 'number', { min: 0, step: 1000 })),
        field(t('profile.currency'), input('currency', draft.currency, 'text', { maxLength: 3, placeholder: r?.currency ?? '' })),
        text('dayRate')))
  }

  function checks() {
    const r = region()
    const clearances = datalist(r?.clearances ?? [])
    return section('checks',
      grid(text('clearance', undefined, { list: clearances.id }),
        ...(r?.checks ?? ['backgroundCheck']).map(k => choice(k, t(`profile.f.${k}`), CHECK_STATES, v => t(`profile.f.check.${v}`))),
        tri('driversLicence', t('profile.f.driversLicence')), tri('ownVehicle', t('profile.f.ownVehicle'))),
      clearances)
  }

  function background() {
    const referees = h('textarea', { class: 'ui-input cp-textarea', name: 'referees', rows: 2, value: draft.referees ?? '', placeholder: REFEREES_DEFAULT })
    return section('background',
      grid(text('highestEducation'), field(t('profile.f.yearsExperience'), input('yearsExperience', draft.yearsExperience, 'number', { min: 0, max: 80, step: 1 }))),
      listInput('languages', t('profile.f.languages'), t('profile.f.languages.hint')),
      field(t('profile.f.referees'), referees))
  }

  const preferences = () => section('preferences',
    listInput('targetRoles', t('profile.targetRoles')),
    listInput('dealBreakers', t('profile.dealBreakers'), t('profile.dealBreakers.hint')))

  function diversity() {
    const decline = datalist(['decline'])
    const extras = EEO_EXTRA.filter(k => k === 'lgbtq' || (region()?.diversity ?? []).includes(k))
    const eeo = (k, label) => field(label, input(`eeo.${k}`, draft.eeo?.[k] ?? 'decline', 'text', { list: decline.id }))
    return section('diversity',
      h('p', { class: 'ui-muted ai-hint' }, t('profile.applicant.eeo.intro')),
      grid(...EEO_FIELDS.map(k => eeo(k, t(`profile.applicant.eeo.${k}`))), ...extras.map(k => eeo(k, t(`profile.f.eeo.${k}`)))),
      decline)
  }

  // ---------- saved answers ----------
  const answerList = h('div', { class: 'cp-cards' })
  const search = h('input', { class: 'ui-input', type: 'search', 'aria-label': t('profile.answers.search'), placeholder: t('profile.answers.search'),
    onInput: e => { query = e.target.value; renderAnswers() } })
  function renderAnswers() {
    const q = query.trim().toLowerCase()
    const shown = bank.filter(e => !q || `${e.question}\n${e.answer}`.toLowerCase().includes(q))
    answerList.replaceChildren(
      h('p', { class: 'ui-muted', role: 'status' }, t('profile.answers.count', { n: shown.length, total: bank.length })),
      ...shown.map(e => {
        const set = patch => { bank = bank.map(x => x.id === e.id ? { ...x, ...patch, updatedAt: new Date().toISOString() } : x); refreshMeter() }
        const question = h('input', { class: 'ui-input', type: 'text', value: e.question, maxLength: 500, id: uid('cp-q'), onChange: ev => set({ question: ev.target.value.trim() }) })
        const answer = h('textarea', { class: 'ui-input cp-textarea', rows: 2, value: e.answer, maxLength: 5000, id: uid('cp-a'), onChange: ev => set({ answer: ev.target.value.trim() }) })
        return h('div', { class: 'cp-card' },
          h('label', { class: 'ui-label', htmlFor: question.id }, t('profile.answers.question')), question,
          h('label', { class: 'ui-label', htmlFor: answer.id }, t('profile.answers.answer')), answer,
          h('div', { class: 'cp-card__foot' }, h('span', { class: 'ui-muted' }, t('profile.answers.uses', { n: e.uses ?? 0 })),
            h('button', { class: 'ui-btn ui-btn--sm ui-btn--ghost', type: 'button', dataset: { action: 'profile-answer-delete' },
              'aria-label': t('profile.answers.deleteOne', { question: e.question }), onClick: () => {
                bank = bank.filter(x => x.id !== e.id)
                renderAnswers()
                refreshMeter()
                search.focus()
              } }, t('profile.delete'))))
      }))
  }
  async function importBank() {
    try {
      const f = await openFile({ accept: '.json' })
      if (!f) return
      const before = bank.length
      bank = importAnswers(bank, JSON.parse(f.text))
      renderAnswers()
      refreshMeter()
      ctx.toast?.(t('profile.answers.imported', { n: bank.length - before }))
    } catch (err) {
      console.warn('recto: answers import', err)
      ctx.toast?.(t('profile.answers.importFailed'))
    }
  }
  // Questions from application packs that nothing answers yet: answer each once here and every pack reuses it
  const todoList = h('div', { class: 'cp-cards' })
  function openQuestions() {
    const seen = new Set()
    return (ctx.tracker?.list() ?? []).flatMap(j => j.pack?.answers ?? [])
      .filter(x => !String(x.answer ?? '').trim() && !/file/.test(x.type ?? '') && x.question)
      .filter(x => {
        const key = normalizeQuestion(x.question)
        if (!key || seen.has(key) || findAnswer(bank, x.question, { options: x.options ?? [] })) return false
        seen.add(key)
        return true
      })
  }
  function renderTodo() {
    const open = openQuestions()
    todoList.replaceChildren(open.length ? h('p', { class: 'ui-muted', role: 'status' }, t('profile.todo.count', { n: open.length }))
      : h('p', { class: 'ui-muted' }, t('profile.todo.none')),
    ...open.slice(0, 50).map(x => {
      const id = uid('cp-todo')
      const control = x.options?.length
        ? h('select', { class: 'ui-select', id }, h('option', { value: '' }, '—'), x.options.map(o => h('option', { value: o }, o)))
        : h('input', { class: 'ui-input', type: 'text', id, maxLength: 5000 })
      const keep = () => {
        if (!control.value.trim()) return control.focus()
        bank = remember(bank, { question: x.question, answer: control.value, options: x.options }, new Date())
        renderTodo()
        renderAnswers()
        refreshMeter()
      }
      control.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); keep() } })
      return h('div', { class: 'cp-card' }, h('label', { class: 'ui-label', htmlFor: id }, x.question, x.required ? ' *' : ''), control,
        h('div', { class: 'cp-card__foot' }, btn(t('profile.todo.save'), keep, 'profile-todo-save')))
    }))
  }
  const answers = () => section('answers',
    h('p', { class: 'ui-muted ai-hint' }, t('profile.answers.intro')),
    h('h3', { class: 'cp-sub' }, t('profile.todo.title')),
    h('p', { class: 'ui-muted ai-hint' }, t('profile.todo.hint')),
    todoList,
    h('h3', { class: 'cp-sub' }, t('profile.answers.saved')),
    h('div', { class: 'cp-toolbar' }, search,
      btn(t('profile.answers.import'), importBank, 'profile-answers-import'),
      btn(t('profile.answers.export'), () => download('recto-answers.json', exportAnswers(bank), 'application/json'), 'profile-answers-export')),
    answerList)

  // ---------- story bank ----------
  const storyList = h('div', { class: 'cp-cards' })
  const addStory = btn(t('profile.stories.add'), () => {
    stories = [{ id: `story-${Date.now().toString(36)}`, title: '', ...Object.fromEntries(STORY_FIELDS.map(k => [k, ''])), tags: [], sourceLines: [] }, ...stories]
    renderStories()
    storyList.querySelector('input')?.focus()
  }, 'profile-story-add')
  function renderStories() {
    addStory.disabled = stories.length >= MAX_STORIES
    storyList.replaceChildren(...(stories.length ? [] : [h('p', { class: 'ui-muted' }, t('profile.stories.empty'))]), ...stories.map(s => {
      const set = patch => { stories = stories.map(x => x.id === s.id ? { ...x, ...patch } : x) }
      const part = (k, control) => { control.id = uid('cp-s'); return [h('label', { class: 'ui-label', htmlFor: control.id }, t(`profile.stories.${k}`)), control] }
      return h('div', { class: 'cp-card' },
        part('title', h('input', { class: 'ui-input', type: 'text', value: s.title, maxLength: 200, onChange: e => set({ title: e.target.value.trim() }) })),
        STORY_FIELDS.map(k => part(k, h('textarea', { class: 'ui-input cp-textarea', rows: 2, value: s[k], onChange: e => set({ [k]: e.target.value.trim() }) }))),
        part('tags', h('input', { class: 'ui-input', type: 'text', value: s.tags.join(', '), onChange: e => set({ tags: splitList(e.target.value) }) })),
        s.sourceLines?.length > 0 && h('p', { class: 'ui-muted' }, t('profile.stories.sources', { n: s.sourceLines.length })),
        h('div', { class: 'cp-card__foot' }, h('button', { class: 'ui-btn ui-btn--sm ui-btn--ghost', type: 'button', dataset: { action: 'profile-story-delete' },
          'aria-label': t('profile.stories.deleteOne', { title: s.title || t('profile.stories.untitled') }), onClick: () => {
            stories = stories.filter(x => x.id !== s.id)
            renderStories()
            addStory.focus()
          } }, t('profile.delete'))))
    }))
  }
  // AI drafts (spec §6 stories()): only from CV lines; the assist guard already dropped stories citing none
  async function draftStories(button) {
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    try {
      const drafted = await ctx.assist.stories()
      const stamp = Date.now().toString(36)
      const added = (normalizeProfile({ stories: Array.isArray(drafted) ? drafted : [] }).stories ?? [])
        .slice(0, MAX_STORIES - stories.length).map((x, i) => ({ ...x, id: `story-${stamp}-${i}` }))
      stories = [...stories, ...added]
      renderStories()
      ctx.toast?.(t('profile.stories.drafted', { n: added.length }))
    } catch (err) {
      console.warn('recto: story drafts', err)
      ctx.toast?.(t('profile.stories.aiFailed'))
    } finally {
      button.disabled = false
      button.removeAttribute('aria-busy')
    }
  }
  const storiesSection = () => section('stories',
    h('p', { class: 'ui-muted ai-hint' }, t('profile.stories.intro')),
    h('div', { class: 'cp-toolbar' }, addStory,
      typeof ctx.assist?.stories === 'function' && h('button', { class: 'ui-btn ui-btn--sm', type: 'button', dataset: { action: 'profile-story-ai' },
        onClick: e => draftStories(e.currentTarget) }, t('profile.stories.ai'))),
    storyList)

  // ---------- behaviour ----------
  const harvest = () => { draft = toProfile(formValues(form.elements), draft) }
  function renderForm() {
    form.replaceChildren(identity(), rights(), pay(), checks(), background(), preferences(), diversity(), answers(), storiesSection())
    renderAnswers()
    renderTodo()
    renderStories()
    refreshMeter()
  }
  // Presets drive states, currency, clearances, checks, retirement wording and the diversity extras
  function countryChanged() {
    harvest()
    renderForm()
  }
  function refreshMeter() {
    const { answered, total, missing: open } = completeness({ ...draft, answers: bank }, code() || draft.country)
    meterBar.max = total
    meterBar.value = answered
    meterText.textContent = t('profile.meter', { n: answered, total })
    missing.hidden = !open.length
    missingList.replaceChildren(...open.map(q => h('li', {},
      h('button', { class: 'job-profile-link', type: 'button', onClick: () => { missing.open = false; go(q.section) } }, q.question))))
  }
  const liveMeter = debounce(() => { harvest(); refreshMeter() }, 250)
  form.addEventListener('input', liveMeter)
  form.addEventListener('change', liveMeter)
  form.addEventListener('focusin', e => setCurrent(e.target.closest('.cp-section')?.dataset.section))

  function setCurrent(s) {
    if (!s) return
    for (const b of nav.querySelectorAll('.cp-nav__item')) {
      if (b.dataset.section === s) b.setAttribute('aria-current', 'true')
      else b.removeAttribute('aria-current')
    }
  }
  function go(s) {
    const sec = form.querySelector(`#${sectionId[s]}`)
    if (!sec) return
    sec.scrollIntoView?.({ block: 'start' })
    sec.querySelector('input, select, textarea, button')?.focus({ preventScroll: true })
    setCurrent(s)
  }
  // Arrow keys, Home and End move between the section links
  function navKeys(e) {
    const items = [...nav.querySelectorAll('.cp-nav__item')]
    const i = items.indexOf(document.activeElement)
    const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key]
    if (next == null || i < 0) return
    e.preventDefault()
    items[(next + items.length) % items.length].focus()
  }

  function save() {
    liveMeter.cancel()
    harvest()
    const saved = saveProfile({ ...draft, answers: bank.filter(e => e.question && e.answer), stories })
    close()
    ctx.toast?.(t('profile.saved'))
    onSave?.(saved)
  }

  renderForm()
  dialog.addEventListener('close', () => liveMeter.cancel(), { once: true })
  const close = ctx.openDialog(dialog)
  setCurrent('identity')
  form.querySelector('input')?.focus()
  return close
}
