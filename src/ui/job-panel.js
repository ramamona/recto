// Job tab (assist spec §7, review-jobs spec 3): paste a job link or description → job card, Recto match estimate,
// the local career-ops evaluation report (gates, requirement table, ★ score, legitimacy) and the AI actions
// Refine evaluation / Tailor CV / Draft cover letter / Save to tracker.
import { h, svg, debounce } from './dom.js'
import { fetchJob } from '../jobs/fetch.js'
import { parseJob } from '../jobs/parse.js'
import { matchCv } from '../jobs/match.js'
import { evaluateJob } from '../jobs/evaluate.js'
import { loadProfile } from '../profile.js'
import { openProfileDialog } from './profile-dialog.js'
import { createAssist, coverLetterDoc } from '../ai/assist.js'
import { getConnection } from '../ai/connections.js'

const ATS = ['greenhouse', 'lever', 'ashby']
const BANDS = ['keywords', 'requirements', 'parseability', 'essentials']
const RING = 2 * Math.PI * 52

export const isJobUrl = input => /^https?:\/\/\S+$/i.test(String(input ?? '').trim())

/** serve.js answers `HEAD /api/fetch` without a url with 400; static hosts 404. Returns the proxy origin or null. */
export async function probeProxy(fetch, origin) {
  try {
    const res = await fetch(`${origin}/api/fetch`, { method: 'HEAD' })
    return res.status === 400 ? origin : null
  } catch {
    return null
  }
}

/** Fill a job's card fields from parsed ones; `prefer` (AI refinement) lets parsed fields win unless the source is an ATS API. */
export function mergeJob(job, parsed, { prefer = false } = {}) {
  const parsedWins = prefer && !ATS.includes(job.source)
  const out = { ...job }
  for (const k of ['title', 'company', 'location', 'postedAt']) {
    const [a, b] = parsedWins ? [parsed?.[k], job[k]] : [job[k], parsed?.[k]]
    const v = a || b
    if (v) out[k] = v
  }
  return out
}

/** The client with `signal` added to every call, so Cancel aborts AI requests made through createAssist. */
export const withSignal = (client, signal) => ({ ...client, complete: args => client.complete({ ...args, signal }) })

/** Newest stored AI evaluation in the Evaluation shape (older entries without rows predate it). */
export const latestEvaluation = job => (job?.evaluations ?? []).filter(e => e?.source === 'ai' && Array.isArray(e.rows)).at(-1) ?? null

/** What the tracker keeps of an evaluation: all of it but the match estimate (`kind` for the jobs dialog). */
export const evaluationRecord = ({ match, ...ev }) => ({ kind: ev.source, ...ev })

const AUTH_LEVEL = { sponsors: 'ok', 'not-needed': 'ok', unstated: 'warn', 'no-sponsorship': 'error' }
const LIVE_LEVEL = { open: 'ok', closed: 'error', unknown: 'info' }

/** Gate banners shown above the requirement table: `{ id, level: ok|info|warn|error, key, vars?, quote }`; null gates were not computed. */
export function gateBanners(gates) {
  if (!gates) return []
  const { liveness, geo, workAuth, dealBreakers } = gates
  const out = []
  if (liveness) out.push({ id: 'liveness', level: LIVE_LEVEL[liveness.status] ?? 'info', key: `eval.gate.liveness.${liveness.status}`, quote: liveness.quote })
  if (geo) out.push({ id: 'geo', level: geo.mismatch ? 'warn' : 'ok', key: `eval.gate.geo.${geo.mismatch ? 'mismatch' : 'ok'}`, quote: geo.quote })
  out.push(workAuth
    ? { id: 'workAuth', level: AUTH_LEVEL[workAuth.tier] ?? 'info', key: `eval.gate.workAuth.${workAuth.tier}`, quote: workAuth.quote }
    : { id: 'workAuth', level: 'info', key: 'eval.gate.workAuth.none', quote: '' })
  for (const d of dealBreakers ?? []) out.push({ id: 'dealBreaker', level: 'error', key: 'eval.gate.dealBreaker', vars: { term: d.term }, quote: d.quote })
  return out
}

const bandClass = score => score >= 75 ? 'is-good' : score >= 50 ? 'is-fair' : 'is-poor'

export function mountJobPanel(root, store, ctx) {
  const { t } = ctx
  let job = null // Job-like: { id?, url, source, title, company, location, text, postedAt?, evaluations? }
  let parsed = null
  let liveness // HTTP status of the posting fetch (URL jobs); undefined for pasted text → 'unknown'
  let refined = null // AI evaluation for the shown job; otherwise the local one is recomputed on every render
  let active = ''
  let busy = null // { label, ac }
  let proxy = null

  const button = (label, onClick, cls = '') => h('button', { type: 'button', class: `ui-btn ui-btn--sm ${cls}`.trim(), onClick }, label)
  const input = h('textarea', {
    class: 'ui-textarea job-input', rows: 4, id: 'job-input', placeholder: t('job.input.placeholder'), 'aria-label': t('job.input.label'),
  })
  const analyzeBtn = button(t('job.analyze'), () => analyze(), 'ui-btn--primary')
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); analyze() }
  })
  const out = h('div', { class: 'job-out', 'aria-live': 'polite' })
  root.replaceChildren(h('div', { class: 'job-panel' },
    h('div', { class: 'job-form' }, input, h('div', { class: 'job-form__bar' }, analyzeBtn,
      h('button', { type: 'button', class: 'job-profile-link', onClick: () => ctx.openProfileDialog() }, t('eval.profile')))), out))
  ctx.openProfileDialog = () => openProfileDialog(ctx, { onSave: () => job && render() })

  // ---------- helpers ----------

  const client = () => ctx.ai?.getClient?.() ?? null
  const state = () => ({ content: store.state.content, doc: store.state.doc })
  const cvName = () => store.state.name || store.state.doc.header?.name || t('app.untitled')
  const companyOf = () => job.company || job.title || t('job.untitled')
  const promptJob = () => ({ ...job, keywords: parsed?.keywords ?? [] })

  function errorText(e) {
    if (e?.code === 'needs-paste') return t('job.error.needs-paste')
    const key = `ai.error.${e?.code}`
    const s = e?.code ? t(key) : key
    return s === key ? e?.message || t('job.error.generic') : s
  }

  async function run(label, fn) {
    if (busy) return
    busy = { label, ac: new AbortController() }
    render()
    try {
      await fn(busy.ac.signal)
    } catch (e) {
      if (!(busy?.ac.signal.aborted || e?.code === 'aborted' || e?.name === 'AbortError')) {
        console.warn('recto: job panel', e)
        ctx.toast?.(errorText(e), e?.code === 'needs-paste' ? {} : { action: { label: t('job.retry'), run: () => run(label, fn) } })
      }
    } finally {
      busy = null
      render()
    }
  }

  async function aiReady() {
    if (!client()) {
      ctx.toast?.(t('job.ai.connect'))
      ctx.openAiDialog?.()
      return false
    }
    const provider = getConnection()?.provider
    return ctx.ai.ensureConsent ? !!(await ctx.ai.ensureConsent(provider)) : true
  }

  const assist = signal => createAssist({ client: withSignal(client(), signal), getState: state })

  // Anthropic's server-side web_fetch, only when that provider is connected and the user consents.
  function webFetchFor(signal) {
    if (!client() || getConnection()?.provider !== 'anthropic') return undefined
    return async url => {
      if (!(await ctx.ai.ensureConsent?.('anthropic'))) return null
      const r = await withSignal(client(), signal).complete({
        tools: ['web_fetch'], maxTokens: 8000,
        messages: [{ role: 'user', content: `Fetch ${url} and reply with the full text of the job posting only, as plain text.` }],
      })
      return r.text
    }
  }

  function show(next, p = parseJob(next.text)) {
    parsed = p
    job = mergeJob(next, p)
    refined = latestEvaluation(job)
    render()
  }

  // ---------- actions ----------

  function analyze() {
    const value = input.value.trim()
    if (!value) return input.focus()
    liveness = undefined
    if (!isJobUrl(value)) return show({ url: '', source: 'paste', title: '', company: '', location: '', text: value })
    run('job.busy.fetch', async signal => {
      proxy ??= probeProxy(globalThis.fetch, location.origin)
      const got = await fetchJob(value, { proxyBase: (await proxy) ?? undefined, webFetch: webFetchFor(signal), signal })
      liveness = 200 // fetchJob only resolves for a readable posting
      show(got)
    })
  }

  const refine = () => run('job.busy.refine', async signal => {
    if (!(await aiReady())) return
    const p = await assist(signal).extractJob(job.text)
    show(mergeJob(job, p, { prefer: true }), p)
  })

  // Save or update without dropping status, docIds or evaluations kept by the tracker.
  function ensureSaved() {
    const tracker = ctx.tracker
    const cur = job.id ? tracker.get(job.id) : null
    const fields = { url: job.url, source: job.source, title: job.title, company: job.company, location: job.location, text: job.text }
    if (job.postedAt) fields.postedAt = job.postedAt
    job = { ...job, ...tracker.save({ ...cur, ...fields, id: job.id }) }
    return job.id
  }

  function saveToTracker() {
    const id = ensureSaved()
    const score = currentMatch()?.score
    const ev = localEvaluation()
    if (Number.isFinite(score)) job = { ...job, ...ctx.tracker.addEvaluation(id, { source: 'local', score: ev.score, recommendation: ev.recommendation, match: score }) }
    ctx.toast?.(t('job.saved'))
    render()
  }

  const evaluate = () => run('job.busy.evaluate', async signal => {
    if (!(await aiReady())) return
    const ev = await assist(signal).evaluate(promptJob(), { local: localEvaluation() })
    const id = ensureSaved()
    job = { ...job, ...ctx.tracker.addEvaluation(id, evaluationRecord(ev)) }
    refined = ev
  })

  const tailor = () => run('job.busy.tailor', async signal => {
    if (!(await aiReady())) return
    // Ask first (on the original, same text as the copy) so a failure leaves no orphan copy.
    const result = await assist(signal).tailor(promptJob())
    const name = cvName()
    const id = ensureSaved()
    store.duplicateDoc()
    store.renameDoc(`${name} — ${companyOf()}`)
    const docId = store.state.docId
    ctx.tracker.link(id, docId)
    ctx.assistQueue ??= new Map()
    ctx.assistQueue.set(docId, result.suggestions)
    ctx.toast?.(t('job.tailored', { n: result.suggestions.length }))
    store.setUi({ panel: 'suggest' })
  })

  const coverLetter = () => run('job.busy.letter', async signal => {
    if (!(await aiReady())) return
    const letter = await assist(signal).coverLetter(promptJob())
    const { content, doc, layout } = store.state
    const name = cvName()
    const id = ensureSaved()
    store.newDoc()
    store.setContent(coverLetterDoc(content, doc, letter))
    // same look as the CV; its per-section config belongs to the CV's sections
    store.setLayout(Object.entries(layout).filter(([k]) => k !== 'sections').map(([k, value]) => ({ path: [k], value })))
    store.renameDoc(`${name} — ${t('job.letter.name')} — ${companyOf()}`)
    ctx.tracker.link(id, store.state.docId)
    ctx.toast?.(t('job.letter.done'))
  })

  function openSaved(id) {
    const saved = ctx.tracker?.get?.(id)
    if (!saved) return ctx.toast?.(t('job.notFound'))
    input.value = saved.url || ''
    liveness = undefined
    show(saved)
  }

  // ---------- view ----------

  function localEvaluation() {
    const s = store.state
    return evaluateJob({ source: s.content, doc: s.doc, layout: s.layout, issues: s.issues }, job,
      { profile: loadProfile(), now: new Date(), liveness, saved: (ctx.tracker?.list?.() ?? []).filter(j => j.id !== job.id) })
  }

  function currentMatch() {
    if (!parsed) return null
    const s = store.state
    return matchCv({ doc: s.doc, source: s.content, layout: s.layout, report: s.report, issues: s.issues }, parsed)
  }

  function jobCard() {
    const meta = [job.company, job.location].filter(Boolean).join(' · ')
    return h('article', { class: 'job-card' },
      h('h3', { class: 'job-card__title' }, job.title || t('job.untitled')),
      meta && h('p', { class: 'job-card__meta' }, meta),
      isJobUrl(job.url) && h('a', { class: 'job-card__link', href: job.url, target: '_blank', rel: 'noopener noreferrer' }, t('job.source')),
      h('div', { class: 'job-card__bar' },
        client() && button(t('job.refine'), refine),
        button(t('job.clear'), () => { job = parsed = refined = null; input.value = ''; render(); input.focus() })))
  }

  function gauge(score) {
    const arc = RING * score / 100
    return svg('svg', { class: `job-gauge ${bandClass(score)}`, viewBox: '0 0 120 120', role: 'img', 'aria-label': t('job.match.aria', { score }) },
      svg('circle', { class: 'job-gauge__track', cx: 60, cy: 60, r: 52 }),
      svg('circle', { class: 'job-gauge__arc', cx: 60, cy: 60, r: 52, 'stroke-dasharray': `${arc} ${RING}`, transform: 'rotate(-90 60 60)' }),
      svg('text', { class: 'job-gauge__num', x: 60, y: 60, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, String(score)))
  }

  function chip(label, onClick, cls) {
    return h('button', { type: 'button', class: `job-chip ${cls}`, onClick }, label)
  }

  function addKeyword(m) {
    const section = store.state.doc.sections.find(s => s.id === m.where)
    if (section) {
      store.select({ kind: 'section', id: section.id })
      store.reveal(section.line)
    }
    ctx.toast?.(section ? t('job.missing.add', { keyword: m.keyword, section: section.title || t('job.missing.cv') })
      : t('job.missing.addCv', { keyword: m.keyword }))
  }

  function matchView(m) {
    return h('section', { class: 'job-match' },
      h('h3', { class: 'ui-group__title' }, t('job.match.title')),
      h('div', { class: 'job-match__top' }, gauge(m.score),
        h('ul', { class: 'job-bands' }, BANDS.map(b => {
          const { score, weight } = m.bands[b]
          return h('li', { class: `job-band ${bandClass(score)}` },
            h('span', { class: 'job-band__label' }, t(`job.band.${b}`, { weight })),
            h('span', { class: 'job-band__bar' }, h('span', { style: { width: `${score}%` } })),
            h('span', { class: 'job-band__num' }, String(score)))
        }))),
      h('p', { class: 'job-note' }, t('job.match.note')),
      m.missing.length > 0 && [
        h('h4', { class: 'job-sub' }, t('job.missing', { n: m.missing.length })),
        h('div', { class: 'job-chips' }, m.missing.map(k => chip(k.keyword, () => addKeyword(k), `is-missing is-${k.kind}`)))],
      m.present.length > 0 && [
        h('h4', { class: 'job-sub' }, t('job.present', { n: m.present.length })),
        h('div', { class: 'job-chips' }, m.present.map(k => chip(k.keyword, () => k.lines[0] && store.reveal(k.lines[0]), 'is-present')))])
  }

  // G · legitimacy, including the prompt-injection anomaly quoted from the JD
  function legitView(legit) {
    return h('section', { class: 'job-legit' },
      h('h3', { class: 'ui-group__title' }, t('job.legit.title'), ' ',
        h('span', { class: `ui-badge job-level is-${legit.level}` }, t(`job.legit.${legit.level}`))),
      legit.signals.length > 0 && h('ul', { class: 'job-signals' }, legit.signals.map(s => h('li', { class: `job-signal is-${s.severity}` },
        h('span', null, t(`legit.${s.code}`)),
        s.evidence && h('q', { class: 'job-signal__evidence' }, s.evidence)))))
  }

  const quote = text => text && h('q', { class: 'job-quote' }, text)

  function gatesView(gates) {
    return h('ul', { class: 'job-gates' }, gateBanners(gates).map(g => h('li', { class: `job-gate is-${g.level}`, dataset: { gate: g.id } },
      h('span', null, t(g.key, g.vars)), quote(g.quote),
      g.key === 'eval.gate.workAuth.none' && h('button', { type: 'button', class: 'job-profile-link', onClick: () => ctx.openProfileDialog() }, t('eval.profile.edit')))))
  }

  function evidenceCell(r) {
    const e = r.evidence
    if (!e) return h('td', { class: 'ui-muted' }, '—')
    return h('td', null, h('button', { type: 'button', class: 'job-locate', title: t('eval.locate'), onClick: () => store.reveal(e.line) },
      t('eval.line', { line: e.line })), ' ', e.text)
  }

  function rowsView(ev) {
    return [h('table', { class: 'job-reqs' },
      h('thead', null, h('tr', null, ['req', 'importance', 'match', 'evidence'].map(c => h('th', { scope: 'col' }, t(`eval.col.${c}`))))),
      h('tbody', null, ev.rows.map(r => h('tr', { class: `is-${r.match}` },
        h('td', null, h('strong', null, r.requirement), r.jdSignal !== r.requirement && h('q', { class: 'job-quote' }, r.jdSignal)),
        h('td', { class: `job-imp is-${r.importance}` }, t(`eval.importance.${r.importance}`)),
        h('td', { class: 'job-fit' }, t(`eval.match.${r.match}`)),
        evidenceCell(r))))),
    ev.dropped > 0 && h('p', { class: 'job-note' }, t('eval.dropped', { n: ev.dropped }))]
  }

  // A · role summary, gates, ★ score with recommendation, B · requirement table
  function evaluationView(ev) {
    const { role } = ev
    const ai = ev.source === 'ai'
    return h('section', { class: `job-report${ai ? ' job-eval' : ''}`, dataset: { source: ev.source } },
      h('h3', { class: 'ui-group__title' }, t(ai ? 'eval.title.ai' : 'eval.title'), ' ',
        h('span', { class: 'job-eval__score', 'aria-label': t('eval.score.aria', { score: ev.score }) }, '★ ', t('job.eval.score', { score: ev.score })), ' ',
        h('span', { class: `ui-badge job-rec is-${ev.recommendation}` }, t(`job.eval.${ev.recommendation}`))),
      ev.caps.length > 0 && h('p', { class: 'job-note' }, t('eval.capped', { caps: ev.caps.map(c => t(`eval.cap.${c}`)).join(', ') })),
      h('p', { class: 'job-role' }, ['archetype', 'seniority', 'remote'].map(k => h('span', { class: 'ui-badge' }, t(`eval.${k}.${role[k]}`)))),
      role.tldr && h('p', { class: 'job-tldr' }, role.tldr),
      gatesView(ev.gates),
      ev.rows.length > 0 ? rowsView(ev) : h('p', { class: 'job-note' }, t('eval.noRows')),
      ev.gaps?.length > 0 && [h('h4', { class: 'job-sub' }, t('job.eval.gaps')), h('ul', { class: 'job-gaps' }, ev.gaps.map(g => h('li', null, g)))],
      ev.pitch && h('p', { class: 'job-eval__pitch' }, h('strong', null, t('job.eval.pitch')), ' ', ev.pitch))
  }

  // Top-bar chips follow the shown job (Task 32's store.setActiveJob; absent before it lands).
  function publish(v) {
    const key = JSON.stringify(v)
    if (key === active) return
    active = key
    store.setActiveJob?.(v)
  }

  function render() {
    analyzeBtn.disabled = !!busy
    const status = busy && h('div', { class: 'job-busy', role: 'status' },
      h('span', { class: 'job-spinner', 'aria-hidden': 'true' }), h('span', null, t(busy.label)),
      button(t('app.cancel'), () => busy?.ac.abort()))
    if (!job) {
      publish(null)
      return out.replaceChildren(...[status || h('p', { class: 'job-empty ui-muted' }, t('job.empty'))])
    }
    const m = currentMatch()
    const ev = refined ?? localEvaluation()
    publish({ id: job.id ?? null, match: m.score, score: ev.score })
    out.replaceChildren(...[status, jobCard(),
      h('div', { class: 'job-actions' },
        button(t('eval.refine'), evaluate), button(t('job.tailor'), tailor),
        button(t('job.letter'), coverLetter), button(t('job.save'), saveToTracker, 'ui-btn--primary')),
      evaluationView(ev), matchView(m), legitView(ev.legitimacy)].flat(Infinity).filter(Boolean))
    for (const b of out.querySelectorAll('.job-actions button, .job-card__bar button')) b.disabled = !!busy
  }

  // Live match: the CV changed (issues arrive after each render, so they cover content and layout edits).
  const refresh = debounce(() => job && render(), 150)
  const openFromUi = s => {
    const id = s.ui.jobId
    if (!id) return
    queueMicrotask(() => store.setUi({ jobId: null })) // consumed, so opening the same job again works
    openSaved(id)
  }
  const unsubscribe = store.subscribe((s, changed) => {
    if (changed.has('ui')) openFromUi(s)
    if (['doc', 'layout', 'issues'].some(k => changed.has(k))) refresh()
  })
  openFromUi(store.state)
  render()
  return { destroy () { unsubscribe(); refresh.cancel(); busy?.ac.abort() } }
}
