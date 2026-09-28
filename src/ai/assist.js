// High-level AI features (assist spec §6): prompt → client → tolerant parse (one retry) → validate/normalize.
import * as P from './prompts.js'
import { loadPlaybook as defaultLoadPlaybook } from './playbook.js'
import { parseJsonLoose, validateSuggestions } from './guard.js'
import { categorize } from '../model/categories.js'
import { escLine } from '../io/jsonresume.js'
import { evaluateJob, capScore, recommendationFor, ARCHETYPES, SENIORITY, REMOTE_KINDS, MATCHES } from '../jobs/evaluate.js'

const CATEGORIES = ['impact', 'clarity', 'keyword', 'concision', 'grammar', 'structure']
const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v)
const str = v => typeof v === 'string' ? v : ''
const strings = v => Array.isArray(v) ? v.filter(s => typeof s === 'string' && s.trim()) : []
const oneOf = (v, list, dflt) => list.includes(v) ? v : dflt
const fail = (code, message) => Object.assign(new Error(message), { code })

const hasSuggestions = j => isObj(j) && Array.isArray(j.suggestions)

/**
 * `client` is a createClient() result (or null when no provider is connected);
 * `getState()` returns `{ content, doc }` for the active CV. The playbook loads once, on first use;
 * if it fails, prompts use their built-in FALLBACK text.
 */
export function createAssist ({ client, getState, loadPlaybook = defaultLoadPlaybook }) {
  let playbook
  const pb = () => (playbook ??= Promise.resolve().then(() => loadPlaybook()).catch(() => null))

  async function ask (makePrompt, valid) {
    if (!client) throw fail('no-client', 'Connect an AI provider first.')
    const prompt = makePrompt(await pb())
    let messages = prompt.messages
    let error
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await client.complete({ ...prompt, messages })
      const text = str(reply?.text)
      try {
        const json = reply?.json !== undefined ? reply.json : parseJsonLoose(text)
        if (valid(json)) return json
        error = 'the JSON does not match the schema'
      } catch (e) {
        error = e.message
      }
      messages = [...prompt.messages,
        { role: 'assistant', content: text || JSON.stringify(reply?.json ?? null) },
        { role: 'user', content: `Your reply was not valid JSON for the schema (${error}). Reply again with JSON only.` }]
    }
    throw fail('bad-response', `The AI reply couldn't be read (${error}). Try again or pick another model.`)
  }

  const validate = (list, extraFactsFor = () => []) => {
    const { content, doc } = getState()
    const items = list.filter(isObj).map(s => ({ ...s, reason: str(s.reason), category: oneOf(s.category, CATEGORIES, 'clarity') }))
    return items.map(s => validateSuggestions(content, doc, [s], { extraFacts: extraFactsFor(s.line) })[0])
  }

  return {
    async suggest () {
      const j = await ask(b => P.suggestPrompt({ source: getState().content }, b), hasSuggestions)
      return { suggestions: validate(j.suggestions) }
    },
    async rewrite (lines, instruction) {
      const j = await ask(b => P.rewritePrompt({ source: getState().content, lines, instruction }, b), hasSuggestions)
      return { suggestions: validate(j.suggestions) }
    },
    async tailor (job) {
      const j = await ask(b => P.tailorPrompt({ source: getState().content, job }, b), hasSuggestions)
      // Job keywords count as known facts on skills lines only (spec §6).
      const skills = skillsLines(getState().doc)
      const keywords = strings(job?.keywords)
      return {
        suggestions: validate(j.suggestions, line => skills(line) ? keywords : []),
        keywordsAdded: strings(j.keywordsAdded),
        summary: str(j.summary),
      }
    },
    /** Refines a local evaluateJob() result (computed here when not given) with the AI's; see mergeEvaluation. */
    async evaluate (job, { local } = {}) {
      const st = getState()
      const base = local ?? evaluateJob({ source: st.content, doc: st.doc, layout: st.layout }, job)
      const j = await ask(b => P.evaluatePrompt({ source: st.content, job, rows: base.rows }, b), j => isObj(j) && Number.isFinite(Number(j.score)))
      return mergeEvaluation(base, j, st)
    },
    async coverLetter (job) {
      const j = await ask(b => P.coverLetterPrompt({ source: getState().content, job }, b), j => isObj(j) && Array.isArray(j.paragraphs))
      const subject = str(j.subject).trim()
      return { ...(subject ? { subject } : {}), paragraphs: strings(j.paragraphs) }
    },
    /**
     * Drafts free-text answers, aligned to `questions` ({ label }[]). An answer naming a fact (name, number, URL) that is not
     * in the CV, profile, job or question is `new-facts`; the caller must not use it.
     */
    async answer (job, questions = [], { profile } = {}) {
      const { content } = getState()
      const j = await ask(b => P.answerPrompt({ source: content, job, profile, questions }, b), j => isObj(j) && Array.isArray(j.answers))
      const byN = new Map(j.answers.filter(isObj).map(a => [Number(a.n), a]))
      const known = [content, job?.title, job?.company, job?.location, job?.text, JSON.stringify(profile ?? {}), ...questions.map(q => q?.label), 'I']
        .map(v => str(v))
      return {
        answers: questions.map((q, i) => {
          const a = byN.get(i + 1) ?? {}
          const answer = str(a.answer).trim()
          const needsInput = str(a.needsInput).trim()
          const newFacts = answer ? newFactsIn(answer, known) : []
          const status = !answer ? 'empty' : newFacts.length ? 'new-facts' : 'ok'
          return { answer, status, newFacts, ...(needsInput ? { needsInput } : {}) }
        }),
      }
    },
    async extractJob (text) {
      return normalizeJob(await ask(b => P.extractJobPrompt({ text }, b), isObj))
    },
    /** A career-ops brief (career-suite spec §6) for mode ∈ P.BRIEF_MODES. `extra`: profile, offer, jobs (compare, 2–5), other data. */
    async brief (mode, { job, notes, extra = {} } = {}) {
      if (!P.BRIEF_MODES.includes(mode)) throw fail('bad-mode', `Unknown brief mode: ${mode}`)
      const jobs = extra?.jobs
      if (mode === 'compare' && !(Array.isArray(jobs) && jobs.length >= 2 && jobs.length <= 5)) throw fail('bad-input', 'Pick 2 to 5 jobs to compare.')
      const source = getState().content
      const j = await ask(b => P.briefPrompt({ mode, source, job, notes, extra }, b), j => isObj(j) && Array.isArray(j.sections))
      const known = [source, JSON.stringify(job ?? {}), notes, JSON.stringify(extra ?? {})].map(str).join('\n')
      return normalizeBrief(j, mode, known)
    },
    async practice ({ job, question, answer } = {}) {
      const j = await ask(b => P.practicePrompt({ source: getState().content, job, question, answer }, b),
        j => isObj(j) && typeof j.feedback === 'string' && Number.isFinite(Number(j.score)))
      return { feedback: cap(j.feedback, 2000), score: Math.min(5, Math.max(1, Math.round(Number(j.score)))), next: cap(j.next, 500) }
    },
    /** Story bank drafted from the CV; a story survives only if it cites at least one existing, non-blank CV line. */
    async stories () {
      const { content } = getState()
      const lines = String(content ?? '').split('\n')
      const j = await ask(b => P.storiesPrompt({ source: content }, b), j => isObj(j) && Array.isArray(j.stories))
      return j.stories.filter(isObj).map(s => {
        const sourceLines = [...new Set(Array.isArray(s.sourceLines) ? s.sourceLines : [])].filter(n => Number.isInteger(n) && lines[n - 1]?.trim())
        const story = { title: cap(s.title, 120), ...Object.fromEntries(STAR.map(k => [k, cap(s[k], 1000)])), tags: capList(s.tags, 10, 60), sourceLines }
        return { ...story, newFacts: newFactsIn(STAR.map(k => story[k]).filter(Boolean).join(' '), [content]) }
      }).filter(s => s.sourceLines.length && s.title)
    },
    /** Pasted new facts → line suggestions; the pasted text counts as known facts (it is the user's own statement). */
    async addToCv (text) {
      const j = await ask(b => P.addPrompt({ source: getState().content, text }, b), hasSuggestions)
      return { suggestions: validate(j.suggestions, () => [str(text)]) }
    },
    /** AI fallback for insights.classifyReply: same shape; status follows from kind, quote must be in the text. */
    async classifyReply (text) {
      const j = await ask(b => P.replyPrompt({ text }, b), j => isObj(j) && typeof j.kind === 'string')
      const kind = oneOf(j.kind, P.REPLY_KINDS, 'other')
      const c = Number(j.confidence)
      const quote = str(j.quote).trim()
      return { kind, status: REPLY_STATUS[kind] ?? '', confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0, quote: quote && str(text).includes(quote) ? quote : '' }
    },
  }
}

const STAR = ['situation', 'task', 'action', 'result']
const REPLY_STATUS = { rejection: 'rejected', interview: 'interview', offer: 'offer' }
const NOTE_MAX = 300

const cap = (v, n) => {
  const s = str(v).trim()
  return s.length > n ? s.slice(0, n).trimEnd() : s
}
const capList = (v, count, n) => strings(v).map(s => cap(s, n)).filter(Boolean).slice(0, count)
// Cut at the last space that fits (a LinkedIn connection note has a hard 300-char limit)
const toWord = (s, n) => s.length <= n ? s : (s.slice(0, n + 1).match(/^[\s\S]*\S(?=\s)/)?.[0] ?? s.slice(0, n))
// URLs the model wrote that are not in the input are dropped: never invent links
const dropUnknownUrls = (s, known) => s.replace(/https?:\/\/[^\s)\]>"']*[^\s)\]>"'.,;:!?]/g, u => known.includes(u) ? u : '').replace(/[ \t]{2,}/g, ' ').trim()

function normalizeBrief (j, mode, known) {
  const clean = (v, n) => cap(dropUnknownUrls(str(v), known), n)
  const sections = j.sections.filter(isObj).map(s => {
    const body = clean(s.body, 2000)
    return {
      heading: clean(s.heading, 120),
      body: mode === 'outreach' ? toWord(body, NOTE_MAX) : body,
      items: strings(s.items).map(i => clean(i, 500)).filter(Boolean).slice(0, 20),
    }
  }).filter(s => s.heading || s.body || s.items.length).slice(0, 12)
  return { title: clean(j.title, 120) || mode, sections, needsInput: capList(j.needsInput, 10, 300) }
}

// The suggestion guard on a one-line stand-in source: "x. " keeps the text a paragraph and its first word sentence-initial.
function newFactsIn (text, known) {
  const [r] = validateSuggestions('x. y', null, [{ line: 1, expect: 'x. y', replacement: 'x. ' + text.replace(/\s+/g, ' ') }], { extraFacts: known })
  return r.newFacts
}

const skillsLines = doc => line => (doc?.sections ?? []).some(s => categorize(s.title) === 'skills' && line >= s.line && line <= s.endLine)

const key = s => str(s).trim().toLowerCase()

// AI evidence counts only when it quotes a real CV line: find the line (the cited one first), then let the guard confirm it.
function quotedLine (ev, content, doc) {
  const text = str(ev?.text).trim()
  if (text.length < 3) return null
  const lines = String(content ?? '').split('\n')
  const at = [Number(ev.line) - 1, ...lines.keys()].find(i => lines[i]?.includes(text))
  if (at === undefined) return null
  const [check] = validateSuggestions(content, doc, [{ line: at + 1, expect: lines[at], replacement: lines[at] }])
  return check.status === 'ok' ? { line: at + 1, text: lines[at] } : null
}

/**
 * AI over local: role fields and row match/evidence where valid; importance, gates, caps and legitimacy stay local;
 * AI rows the local pass 1 did not find are ignored. A match better than missing needs quotable evidence.
 */
function mergeEvaluation (local, j, { content, doc }) {
  const role = isObj(j.role) ? j.role : {}
  const ai = new Map((Array.isArray(j.rows) ? j.rows : []).filter(isObj).map(r => [key(r.jdSignal), r]))
  const rows = local.rows.map(row => {
    const r = ai.get(key(row.jdSignal))
    if (!r || !MATCHES.includes(r.match)) return row
    const evidence = quotedLine(r.evidence, content, doc)
    if (!evidence && (r.match === 'strong' || r.match === 'partial')) return row
    return { ...row, match: r.match, evidence, requirement: str(r.requirement).trim() || row.requirement }
  })
  const { score, caps } = capScore(Math.min(5, Math.max(1, Number(j.score))), local.gates)
  return {
    ...local,
    source: 'ai',
    role: {
      archetype: oneOf(role.archetype, ARCHETYPES, local.role.archetype),
      seniority: oneOf(role.seniority, SENIORITY, local.role.seniority),
      remote: local.gates.geo?.mismatch ? local.role.remote : oneOf(role.remote, REMOTE_KINDS, local.role.remote),
      tldr: str(role.tldr).trim() || local.role.tldr,
    },
    rows,
    score,
    recommendation: recommendationFor(score),
    caps,
    gaps: strings(j.gaps),
    pitch: str(j.pitch),
  }
}

function normalizeJob (j) {
  const out = {
    title: str(j.title).trim(),
    company: str(j.company).trim(),
    location: str(j.location).trim(),
    requirements: (Array.isArray(j.requirements) ? j.requirements : []).filter(isObj).map(r => ({
      text: str(r.text), kind: oneOf(r.kind, ['must', 'nice'], 'must'), keywords: strings(r.keywords),
    })),
    keywords: strings(j.keywords),
  }
  if (str(j.salary).trim()) out.salary = j.salary.trim()
  if (str(j.postedAt).trim()) out.postedAt = j.postedAt.trim()
  return out
}

/** A cover-letter document: the CV's header lines, then an untitled section of escaped paragraphs. */
export function coverLetterDoc (cvSource, doc, letter) {
  const lines = String(cvSource ?? '').split('\n')
  const end = doc?.sections?.[0] ? doc.sections[0].line - 1 : lines.length
  const header = lines.slice(0, end)
  while (header.length && !header.at(-1).trim()) header.pop()
  const paras = [str(letter?.subject), ...strings(letter?.paragraphs)].map(escLine).filter(Boolean)
  return [...(header.length ? [header.join('\n'), ''] : []), '##', '', paras.join('\n\n'), ''].join('\n')
}
