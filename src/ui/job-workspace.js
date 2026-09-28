// Job workspace (career-suite spec §6, §7): the board drawer's tabs. Overview (board content + outcome + apply log), Pack,
// Research (+ red flags), Outreach (contacts + notes + application email), Interview (interviews, prep, plan, practice,
// debrief), Offer (fields, salary gap, negotiation, contract walk) and Follow-ups (cadence, draft, paste a reply).
// Deterministic parts always work; AI briefs need a connected provider and pass the consent check first. AI output is a
// draft: rendered with textContent only, stored as job.artifacts[mode], never sent anywhere.
import { h, uid } from './dom.js'
import { withSignal } from './job-panel.js'
import { createAssist } from '../ai/assist.js'
import { getConnection } from '../ai/connections.js'
import { loadProfile } from '../profile.js'
import { cadence, followUpsDue, classifyReply, salaryGap, compare } from '../jobs/insights.js'
import { CONTACT_KINDS, OUTCOME_STAGES } from '../jobs/tracker.js'

export const TABS = ['overview', 'pack', 'research', 'outreach', 'interview', 'offer', 'followups']
const STAR = [['situation', 'Situation'], ['task', 'Task'], ['action', 'Action'], ['result', 'Result'], ['reflection', 'Reflection']]
const OFFER_FIELDS = [['base', 'number'], ['currency', 'text'], ['super', 'text'], ['bonus', 'text'], ['equity', 'text'], ['deadline', 'date']]
const GAPS = ['offeredVsDesired', 'offeredVsAdvertised', 'advertisedVsDesired']
const str = v => typeof v === 'string' ? v : ''
const filled = v => str(v).trim() !== ''

/** A brief as plain text for the clipboard: title, then each section (heading, body, "- item"), then needs-input items. */
export function briefText(brief) {
  if (!brief) return ''
  const blocks = [
    [brief.title].filter(Boolean),
    ...(brief.sections ?? []).map(s => [s.heading, s.body, ...(s.items ?? []).map(i => `- ${i}`)].filter(Boolean)),
    (brief.needsInput ?? []).map(i => `- ${i}`)
  ]
  return blocks.filter(b => b.length).map(b => b.join('\n')).join('\n\n')
}

/** The job with `brief` stored as the latest artifact of `mode`. */
export const withArtifact = (job, mode, brief) => ({ ...job, artifacts: { ...job.artifacts, [mode]: brief } })

/** followUps with the cadence item's done flag set (a plan item not stored yet is added). */
export function toggleFollowUp(job, { due, kind }, done) {
  const list = job.followUps ?? []
  const i = list.findIndex(f => f.due === due && f.kind === kind)
  return i < 0 ? [...list, { due, kind, done }] : list.map((f, k) => k === i ? { ...f, done } : f)
}

/** Desired pay for the salary gap: the profile's minimum salary, else its expectation text. */
export const desiredPay = p => p?.salaryMin ?? (str(p?.salaryExpectation) || null)

/** Likely interview questions from a prep brief (items ending in "?"), leaving out the questions to ask them. */
export const prepQuestions = brief => [...new Set((brief?.sections ?? []).filter(s => !/\bask\b/i.test(str(s.heading)))
  .flatMap(s => s.items ?? []).filter(i => /\?\s*$/.test(str(i))))]

/** Regex classification first; below 0.5 confidence the AI (when given) decides. An AI failure keeps the rule result. */
export async function classifyReplyWith(text, ai) {
  const rules = { ...classifyReply(text), source: 'rules' }
  if (rules.confidence >= 0.5 || !ai) return rules
  try {
    const out = await ai(text)
    return out ? { ...out, source: 'ai' } : rules
  } catch {
    return rules
  }
}

/** A story-bank entry as STAR+R lines, for the practice answer. */
export const storyText = s => [s.title, ...STAR.filter(([k]) => filled(s[k])).map(([k, label]) => `${label}: ${s[k]}`)].filter(Boolean).join('\n')

/** `{ total, answered, missing }` of a stored application pack (missing = required and unanswered), or null. */
export function packSummary(pack) {
  if (!pack) return null
  const a = pack.answers ?? []
  return { total: a.length, answered: a.filter(x => filled(x.answer)).length, missing: a.filter(x => x.required && !filled(x.answer)).length }
}

/** Brief → headings, paragraphs and lists (textContent only). */
export function renderBrief(brief, t) {
  return h('div', { class: 'ws-brief' },
    brief.title && h('h4', {}, brief.title),
    (brief.sections ?? []).map(s => h('section', {},
      s.heading && h('h5', {}, s.heading),
      str(s.body).split(/\n{2,}/).filter(Boolean).map(p => h('p', {}, p)),
      s.items?.length > 0 && h('ul', {}, s.items.map(i => h('li', {}, i))))),
    brief.needsInput?.length > 0 && [h('h5', {}, t('ws.needsInput')), h('ul', {}, brief.needsInput.map(i => h('li', {}, i)))])
}

/** Error text for an AI failure, as the Job tab words it. */
export function aiErrorText(t, e) {
  const key = `ai.error.${e?.code}`
  const s = e?.code ? t(key) : key
  return s === key ? e?.message || t('job.error.generic') : s
}

/** Assist for the connected provider after the consent check; null (and the connect dialog) when there is none. */
export async function assistFor(store, ctx, signal) {
  const client = ctx.ai?.getClient?.()
  if (!client) { ctx.openAiDialog?.(); return null }
  if (ctx.ai.ensureConsent && !(await ctx.ai.ensureConsent(getConnection()?.provider))) return null
  return createAssist({ client: withSignal(client, signal), getState: () => ({ content: store.state.content, doc: store.state.doc }) })
}

/** Copy plain text, with a toast either way. */
export const copyText = (ctx, text) => navigator.clipboard?.writeText(text)
  .then(() => ctx.toast?.(ctx.t('pack.copied')), () => ctx.toast?.(ctx.t('pack.copyFailed')))

/** Per-job workspace state and tab rendering for the board drawer. `onChange` re-renders the board (and so the drawer). */
export function createWorkspace(store, ctx, { tracker, jobId, onChange, move, now = () => new Date() }) {
  const { t } = ctx
  const base = uid('ws')
  const state = { tab: 'overview', busy: new Map(), drafts: {}, practice: null, reply: null, dead: false }
  const cur = () => tracker.get(jobId)
  const refresh = () => { if (!state.dead) onChange() }
  const patch = change => { const j = cur(); if (j) tracker.save({ ...j, ...change(j) }) }
  const connected = () => !!ctx.ai?.getClient?.()
  const btn = (label, onClick, action, extra = {}) => h('button', { class: 'ui-btn ui-btn--sm', type: 'button', dataset: { action }, onClick, ...extra }, label)
  const connectBtn = () => btn(t('ws.connect'), () => ctx.openAiDialog?.(), 'ws-connect')
  const date = s => { const d = new Date(s); return Number.isFinite(+d) ? d.toLocaleDateString() : s }
  const profile = () => loadProfile()

  // Plain inputs: `field(label, input)` pairs a visible label with its control
  function field(label, control) {
    control.id ||= uid('wsf')
    return h('div', { class: 'ws-field' }, h('label', { htmlFor: control.id }, label), control)
  }
  const draft = key => state.drafts[key] ?? ''
  const draftArea = (key, rows = 4, placeholder = '') => h('textarea', {
    class: 'ui-input ws-area', rows, value: draft(key), placeholder, dataset: { draft: key },
    onInput: e => { state.drafts[key] = e.target.value }
  })

  // ---------- AI ----------
  async function runAi(key, fn) {
    if (state.busy.has(key)) return
    const ac = new AbortController()
    state.busy.set(key, ac)
    refresh()
    try {
      const assist = await assistFor(store, ctx, ac.signal)
      if (assist && !ac.signal.aborted) await fn(assist, ac.signal)
    } catch (e) {
      if (!(ac.signal.aborted || e?.code === 'aborted' || e?.name === 'AbortError')) {
        console.warn('recto: workspace', e)
        ctx.toast?.(aiErrorText(t, e), { action: { label: t('job.retry'), run: () => runAi(key, fn) } })
      }
    } finally {
      state.busy.delete(key)
      refresh()
    }
  }

  function generate(mode, input) {
    return runAi(mode, async (assist, signal) => {
      const j = cur()
      if (!j) return
      const { notes, extra } = input(j)
      const brief = await assist.brief(mode, { job: j, notes, extra: { profile: profile(), ...extra } })
      const latest = cur()
      if (!signal.aborted && latest) tracker.save(withArtifact(latest, mode, brief))
    })
  }

  function briefView(job, mode) {
    const brief = job.artifacts?.[mode]
    return brief ? renderBrief(brief, t) : h('p', { class: 'ui-muted' }, t('ws.noBrief'))
  }

  // Heading + Generate/Regenerate (or Connect) + Copy + the stored brief
  function briefBlock(job, mode, input = () => ({})) {
    const brief = job.artifacts?.[mode]
    const busy = state.busy.has(mode)
    return h('section', { class: 'ws-block', dataset: { mode } },
      h('div', { class: 'ws-block__head' },
        h('h3', {}, t(`ws.mode.${mode}`)),
        connected()
          ? btn(t(busy ? 'ws.generating' : brief ? 'ws.regenerate' : 'ws.generate'), () => generate(mode, input), 'ws-generate', { disabled: busy })
          : connectBtn(),
        brief && btn(t('ws.copy'), () => copyText(ctx, briefText(brief)), 'ws-copy')),
      briefView(job, mode))
  }

  // ---------- Overview extras ----------
  function outcome(job) {
    if (job.status !== 'rejected') return null
    const o = job.outcome ?? {}
    const save = change => patch(j => ({ outcome: { stage: '', reason: '', at: now().toISOString(), ...j.outcome, ...change } }))
    return h('section', { class: 'ws-outcome' }, h('h3', {}, t('ws.outcome')),
      field(t('ws.outcome.stage'), h('select', { class: 'ui-select', dataset: { field: 'outcome-stage' }, onChange: e => save({ stage: e.target.value }) },
        OUTCOME_STAGES.map(s => h('option', { value: s, selected: s === (o.stage ?? '') }, s ? t(`ws.outcome.stage.${s}`) : t('ws.outcome.stage.none'))))),
      field(t('ws.outcome.reason'), h('input', { class: 'ui-input', value: o.reason ?? '', dataset: { field: 'outcome-reason' }, onChange: e => save({ reason: e.target.value }) })))
  }

  const applyLog = job => job.applyLog?.length > 0 && h('section', {}, h('h3', {}, t('ws.applyLog')),
    h('ol', { class: 'board-timeline' }, job.applyLog.map(e => h('li', {},
      h('time', { class: 'ui-muted', datetime: e.at }, date(e.at)), ' ', e.result, e.reason && ` — ${e.reason}`))))

  // ---------- tabs ----------
  const PANELS = {
    overview: (job, overview) => [overview, outcome(job), applyLog(job)],

    pack(job) {
      const s = packSummary(job.pack)
      return [
        h('p', {}, s ? t('ws.pack.summary', s) : t('ws.pack.none')),
        s && job.pack.createdAt && h('p', { class: 'ui-muted' }, t('ws.pack.built', { date: date(job.pack.createdAt) })),
        h('div', { class: 'board-drawer__row' },
          ctx.openPack && btn(t(job.pack ? 'pack.open' : 'pack.prepare'), () => ctx.openPack(job.id, { onChange: refresh }), 'ws-pack'),
          ctx.openApplyQueue && job.status === 'saved' && btn(t('ws.pack.apply'), () => ctx.openApplyQueue({ jobIds: [job.id] }), 'ws-apply'))
      ]
    },

    research(job) {
      const legit = (job.evaluations ?? []).findLast(e => e?.legitimacy)?.legitimacy
      const input = () => ({ notes: draft('research') })
      return [
        field(t('ws.research.notes'), draftArea('research', 4, t('ws.research.notesHint'))),
        briefBlock(job, 'research', input),
        h('section', { class: 'ws-block' }, h('h3', {}, t('ws.signals')),
          legit?.signals?.length
            ? h('ul', {}, legit.signals.map(s => h('li', { class: `ws-signal is-${s.severity ?? 'low'}` }, s.evidence ? `${s.code}: ${s.evidence}` : s.code)))
            : h('p', { class: 'ui-muted' }, t('ws.signals.none'))),
        briefBlock(job, 'redflags', () => ({ ...input(), extra: { legitimacy: legit ?? null } }))
      ]
    },

    outreach(job) {
      const contacts = job.contacts ?? []
      const setContact = (i, change) => patch(j => ({ contacts: (j.contacts ?? []).map((c, k) => k === i ? { ...c, ...change } : c) }))
      const note = job.artifacts?.outreach
      const busy = state.busy.has('outreach')
      const draftNote = c => runAi('outreach', async (assist, signal) => {
        const brief = await assist.brief('outreach', { job: cur(), notes: c.note, extra: { profile: profile(), contact: { name: c.name, role: c.role, kind: c.kind } } })
        const latest = cur()
        if (!signal.aborted && latest) tracker.save(withArtifact(latest, 'outreach', { ...brief, contact: c.name }))
      })
      return [
        h('section', { class: 'ws-block' }, h('div', { class: 'ws-block__head' }, h('h3', {}, t('ws.contacts')),
          btn(t('ws.contact.add'), () => { patch(j => ({ contacts: [...(j.contacts ?? []), { name: t('ws.contact.new'), kind: 'recruiter' }] })); refresh() }, 'ws-contact-add')),
          contacts.length ? contacts.map((c, i) => h('fieldset', { class: 'ws-item' },
            h('legend', {}, c.name),
            field(t('ws.contact.name'), h('input', { class: 'ui-input', value: c.name, required: true, onChange: e => { if (filled(e.target.value)) { setContact(i, { name: e.target.value.trim() }); refresh() } } })),
            field(t('ws.contact.role'), h('input', { class: 'ui-input', value: c.role ?? '', onChange: e => setContact(i, { role: e.target.value }) })),
            field(t('ws.contact.kind'), h('select', { class: 'ui-select', onChange: e => setContact(i, { kind: e.target.value }) },
              CONTACT_KINDS.map(k => h('option', { value: k, selected: k === c.kind }, t(`ws.contact.kind.${k}`))))),
            field(t('ws.contact.url'), h('input', { class: 'ui-input', type: 'url', value: c.url ?? '', placeholder: 'https://', onChange: e => setContact(i, { url: e.target.value.trim() }) })),
            field(t('ws.contact.note'), h('textarea', { class: 'ui-input ws-area', rows: 2, value: c.note ?? '', onChange: e => setContact(i, { note: e.target.value }) })),
            h('div', { class: 'board-drawer__row' },
              connected() ? btn(t(busy ? 'ws.generating' : 'ws.contact.draft'), () => draftNote(c), 'ws-outreach', { disabled: busy }) : connectBtn(),
              btn(t('ws.remove'), () => { patch(j => ({ contacts: (j.contacts ?? []).filter((_, k) => k !== i) })); refresh() }, 'ws-contact-remove'))))
            : h('p', { class: 'ui-muted' }, t('ws.contacts.none'))),
        note && h('section', { class: 'ws-block', dataset: { mode: 'outreach' } },
          h('div', { class: 'ws-block__head' }, h('h3', {}, note.contact ? t('ws.outreach.for', { name: note.contact }) : t('ws.mode.outreach')),
            btn(t('ws.copy'), () => copyText(ctx, briefText(note)), 'ws-copy')),
          renderBrief(note, t)),
        briefBlock(job, 'email')
      ]
    },

    interview(job) {
      const list = job.interviews ?? []
      const setIv = (i, change) => patch(j => ({ interviews: (j.interviews ?? []).map((v, k) => k === i ? { ...v, ...change } : v) }))
      const stories = profile().stories ?? []
      const questions = prepQuestions(job.artifacts?.['interview-prep'])
      const p = state.practice
      const busy = state.busy.has('practice')
      const practise = () => {
        const question = draft('question').trim(), answer = draft('answer').trim()
        if (!question || !answer) return ctx.toast?.(t('ws.practice.needBoth'))
        runAi('practice', async (assist, signal) => {
          const out = await assist.practice({ job: cur(), question, answer })
          if (!signal.aborted) state.practice = out
        })
      }
      const lastDebrief = j => (j.interviews ?? []).findLast(v => filled(v.debrief) || filled(v.notes))
      return [
        h('section', { class: 'ws-block' }, h('div', { class: 'ws-block__head' }, h('h3', {}, t('ws.interviews')),
          btn(t('ws.interview.add'), () => { patch(j => ({ interviews: [...(j.interviews ?? []), { at: '', round: String((j.interviews ?? []).length + 1) }] })); refresh() }, 'ws-interview-add')),
          list.length ? list.map((v, i) => h('fieldset', { class: 'ws-item' },
            h('legend', {}, t('ws.interview.round', { round: v.round || i + 1 })),
            field(t('ws.interview.at'), h('input', { class: 'ui-input', type: 'datetime-local', value: str(v.at).slice(0, 16), onChange: e => { setIv(i, { at: e.target.value }); refresh() } })),
            field(t('ws.interview.roundLabel'), h('input', { class: 'ui-input', value: v.round ?? '', onChange: e => setIv(i, { round: e.target.value }) })),
            field(t('ws.interview.notes'), h('textarea', { class: 'ui-input ws-area', rows: 2, value: v.notes ?? '', onChange: e => setIv(i, { notes: e.target.value }) })),
            field(t('ws.interview.debrief'), h('textarea', { class: 'ui-input ws-area', rows: 3, value: v.debrief ?? '', onChange: e => setIv(i, { debrief: e.target.value }) })),
            btn(t('ws.remove'), () => { patch(j => ({ interviews: (j.interviews ?? []).filter((_, k) => k !== i) })); refresh() }, 'ws-interview-remove')))
            : h('p', { class: 'ui-muted' }, t('ws.interviews.none'))),
        briefBlock(job, 'interview-prep', () => ({ extra: { stories: stories.map(s => ({ title: s.title, tags: s.tags, result: s.result })) } })),
        briefBlock(job, 'interview-plan', j => ({ extra: { interviews: j.interviews ?? [] } })),
        h('section', { class: 'ws-block ws-practice' }, h('h3', {}, t('ws.practice')),
          questions.length > 0 && field(t('ws.practice.fromPrep'), h('select', {
            class: 'ui-select', onChange: e => { state.drafts.question = e.target.value; refresh() }
          }, h('option', { value: '' }, t('ws.practice.pick')), questions.map(q => h('option', { value: q, selected: q === draft('question') }, q)))),
          field(t('ws.practice.question'), h('input', { class: 'ui-input', value: draft('question'), dataset: { draft: 'question' }, onInput: e => { state.drafts.question = e.target.value } })),
          stories.length > 0 && field(t('ws.practice.story'), h('select', {
            class: 'ui-select', onChange: e => {
              const s = stories[Number(e.target.value)]
              if (s) { state.drafts.answer = [draft('answer'), storyText(s)].filter(filled).join('\n\n'); refresh() }
            }
          }, h('option', { value: '' }, t('ws.practice.pickStory')), stories.map((s, i) => h('option', { value: String(i) }, s.title || t('ws.practice.untitledStory'))))),
          field(t('ws.practice.answer'), draftArea('answer', 6)),
          connected() ? btn(t(busy ? 'ws.generating' : 'ws.practice.feedback'), practise, 'ws-practice', { disabled: busy }) : connectBtn(),
          p && h('div', { class: 'ws-brief', role: 'status' },
            h('p', {}, h('strong', {}, t('ws.practice.score', { score: p.score }))),
            str(p.feedback).split(/\n{2,}/).filter(Boolean).map(x => h('p', {}, x)),
            filled(p.next) && h('p', {}, t('ws.practice.next'), ' ', h('button', {
              class: 'board-doc', type: 'button', onClick: () => { state.drafts.question = p.next; state.drafts.answer = ''; state.practice = null; refresh() }
            }, p.next)))),
        briefBlock(job, 'debrief', j => { const v = lastDebrief(j); return { notes: v ? [v.notes, v.debrief].filter(filled).join('\n\n') : '', extra: { interview: v ?? null } } })
      ]
    },

    offer(job) {
      const o = job.offer ?? {}
      const gap = salaryGap({ desired: desiredPay(profile()), advertised: compare([job])[0]?.salary, offered: o.base })
      const money = n => n == null ? '—' : n.toLocaleString()
      const gapText = g => g ? `${g.diff > 0 ? '+' : ''}${g.diff.toLocaleString()}${g.pct == null ? '' : ` (${g.pct > 0 ? '+' : ''}${g.pct}%)`}` : '—'
      const save = (k, v) => patch(j => ({ offer: { ...j.offer, [k]: v } }))
      return [
        h('section', { class: 'ws-block ws-offer' }, h('h3', {}, t('ws.offer')),
          OFFER_FIELDS.map(([k, type]) => field(t(`ws.offer.${k}`), h('input', {
            class: 'ui-input', type, value: o[k] ?? '', dataset: { field: `offer-${k}` },
            onChange: e => { save(k, e.target.value); if (k === 'base') refresh() }
          }))),
          field(t('ws.offer.notes'), h('textarea', { class: 'ui-input ws-area', rows: 3, value: o.notes ?? '', onChange: e => save('notes', e.target.value) }))),
        h('section', { class: 'ws-block' }, h('h3', {}, t('ws.gap')),
          h('table', { class: 'ws-gap' }, h('tbody', {},
            [['ws.gap.desired', gap.desired], ['ws.gap.advertised', gap.advertised], ['ws.gap.offered', gap.offered]]
              .map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, t(k)), h('td', {}, money(v)))),
            GAPS.map(k => h('tr', {}, h('th', { scope: 'row' }, t(`ws.gap.${k}`)), h('td', {}, gapText(gap[k])))))),
          gap.desired == null && h('p', { class: 'ui-muted' }, t('ws.gap.noDesired'))),
        briefBlock(job, 'negotiate', j => ({ extra: { offer: j.offer ?? {}, salaryGap: gap } })),
        field(t('ws.offer.contract'), draftArea('contract', 6, t('ws.offer.contractHint'))),
        h('p', { class: 'ws-note' }, t('ws.offer.notLegal')),
        briefBlock(job, 'offer-review', j => ({ notes: draft('contract'), extra: { offer: j.offer ?? {} } }))
      ]
    },

    followups(job) {
      const items = cadence(job)
      const due = followUpsDue(job, now())
      const isDue = f => due.some(d => d.due === f.due && d.kind === f.kind)
      const r = state.reply
      const busy = state.busy.has('reply')
      const classify = async () => {
        const text = draft('reply')
        if (!filled(text)) return ctx.toast?.(t('ws.reply.empty'))
        const ac = new AbortController()
        state.busy.set('reply', ac)
        refresh()
        const ai = connected() ? async x => (await assistFor(store, ctx, ac.signal))?.classifyReply(x) : null
        try { state.reply = await classifyReplyWith(text, ai) } finally { state.busy.delete('reply'); refresh() }
      }
      const suggest = r?.status && r.status !== job.status
      return [
        h('section', { class: 'ws-block' }, h('h3', {}, t('ws.follow')),
          items.length ? h('ul', { class: 'ws-follow' }, items.map(f => h('li', { class: isDue(f) ? 'is-overdue' : '' },
            h('label', {}, h('input', {
              type: 'checkbox', checked: f.done, dataset: { action: 'ws-follow-done' },
              onChange: e => { patch(j => ({ followUps: toggleFollowUp(j, f, e.target.checked) })); refresh() }
            }), ' ', t(`ws.follow.kind.${f.kind}`), ' ', h('time', { datetime: f.due }, date(f.due))),
            isDue(f) && h('span', { class: 'board-chip board-chip--due' }, t('ws.follow.overdue')))))
            : h('p', { class: 'ui-muted' }, t('ws.follow.none'))),
        briefBlock(job, 'followup', j => ({ extra: { followUps: followUpsDue(j, now()), status: j.status } })),
        h('section', { class: 'ws-block' }, h('h3', {}, t('ws.reply')),
          field(t('ws.reply.paste'), draftArea('reply', 5)),
          btn(t(busy ? 'ws.reply.classifying' : 'ws.reply.classify'), classify, 'ws-reply', { disabled: busy }),
          r && h('div', { class: 'ws-brief', role: 'status' },
            h('p', {}, h('strong', {}, t(`ws.reply.kind.${r.kind}`)), ' ',
              h('span', { class: 'ui-muted' }, t(r.source === 'ai' ? 'ws.reply.byAi' : 'ws.reply.byRules', { pct: Math.round((r.confidence ?? 0) * 100) }))),
            filled(r.quote) && h('blockquote', {}, r.quote),
            suggest && btn(t('ws.reply.move', { status: t(`jobs.status.${r.status}`) }), () => {
              if (r.status === 'rejected') state.tab = 'overview'
              state.reply = null
              move(job.id, r.status)
            }, 'ws-reply-move')))
      ]
    }
  }

  const tabId = k => `${base}-${k}`
  function select(k) {
    state.tab = k
    refresh()
    document.getElementById(tabId(k))?.focus()
  }

  return {
    get tab() { return state.tab },
    /** [tablist, panel] for `job`; `overview` is the board's own drawer content. */
    render(job, overview) {
      const tabs = h('div', { class: 'ws-tabs', role: 'tablist', 'aria-label': t('ws.tabs') }, TABS.map((k, i) => h('button', {
        class: 'ws-tab', type: 'button', role: 'tab', id: tabId(k), 'aria-selected': String(k === state.tab),
        'aria-controls': `${base}-panel`, tabIndex: k === state.tab ? 0 : -1, dataset: { tab: k },
        onClick: () => select(k),
        onKeydown: e => {
          const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key]
          if (step) { e.preventDefault(); select(TABS[(i + step + TABS.length) % TABS.length]) }
        }
      }, t(`ws.tab.${k}`))))
      const panel = h('div', { class: 'ws-panel', role: 'tabpanel', id: `${base}-panel`, 'aria-labelledby': tabId(state.tab) },
        PANELS[state.tab](job, overview))
      return [tabs, panel]
    },
    /** Stop AI work and further re-renders (the drawer closed or shows another job). */
    abort() {
      state.dead = true
      for (const ac of state.busy.values()) ac.abort()
    }
  }
}
