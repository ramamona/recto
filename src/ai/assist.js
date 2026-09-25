// High-level AI features (assist spec §6): prompt → client → tolerant parse (one retry) → validate/normalize.
import * as P from './prompts.js'
import { parseJsonLoose, validateSuggestions } from './guard.js'
import { categorize } from '../model/categories.js'
import { escLine } from '../io/jsonresume.js'

const CATEGORIES = ['impact', 'clarity', 'keyword', 'concision', 'grammar', 'structure']
const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v)
const str = v => typeof v === 'string' ? v : ''
const strings = v => Array.isArray(v) ? v.filter(s => typeof s === 'string' && s.trim()) : []
const oneOf = (v, list, dflt) => list.includes(v) ? v : dflt
const fail = (code, message) => Object.assign(new Error(message), { code })

const hasSuggestions = j => isObj(j) && Array.isArray(j.suggestions)

/**
 * `client` is a createClient() result (or null when no provider is connected);
 * `getState()` returns `{ content, doc }` for the active CV.
 */
export function createAssist ({ client, getState }) {
  async function ask (prompt, valid) {
    if (!client) throw fail('no-client', 'Connect an AI provider first.')
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
      const j = await ask(P.suggestPrompt({ source: getState().content }), hasSuggestions)
      return { suggestions: validate(j.suggestions) }
    },
    async rewrite (lines, instruction) {
      const j = await ask(P.rewritePrompt({ source: getState().content, lines, instruction }), hasSuggestions)
      return { suggestions: validate(j.suggestions) }
    },
    async tailor (job) {
      const j = await ask(P.tailorPrompt({ source: getState().content, job }), hasSuggestions)
      // Job keywords count as known facts on skills lines only (spec §6).
      const skills = skillsLines(getState().doc)
      const keywords = strings(job?.keywords)
      return {
        suggestions: validate(j.suggestions, line => skills(line) ? keywords : []),
        keywordsAdded: strings(j.keywordsAdded),
        summary: str(j.summary),
      }
    },
    async evaluate (job) {
      const j = await ask(P.evaluatePrompt({ source: getState().content, job }), j => isObj(j) && Number.isFinite(Number(j.score)))
      return normalizeEvaluation(j)
    },
    async coverLetter (job) {
      const j = await ask(P.coverLetterPrompt({ source: getState().content, job }), j => isObj(j) && Array.isArray(j.paragraphs))
      const subject = str(j.subject).trim()
      return { ...(subject ? { subject } : {}), paragraphs: strings(j.paragraphs) }
    },
    async extractJob (text) {
      return normalizeJob(await ask(P.extractJobPrompt({ text }), isObj))
    },
  }
}

const skillsLines = doc => line => (doc?.sections ?? []).some(s => categorize(s.title) === 'skills' && line >= s.line && line <= s.endLine)

function normalizeEvaluation (j) {
  const leg = isObj(j.legitimacy) ? j.legitimacy : {}
  return {
    score: Math.min(5, Math.max(1, Math.round(Number(j.score)))),
    recommendation: oneOf(j.recommendation, ['apply', 'consider', 'skip'], 'consider'),
    summary: str(j.summary),
    requirements: (Array.isArray(j.requirements) ? j.requirements : []).filter(isObj).map(r => ({
      text: str(r.text),
      weight: Number.isFinite(Number(r.weight)) ? Number(r.weight) : 1,
      evidence: str(r.evidence),
      verdict: oneOf(r.verdict, ['met', 'partial', 'missing'], 'missing'),
    })),
    gaps: strings(j.gaps),
    levelFit: str(j.levelFit),
    legitimacy: { level: oneOf(leg.level, ['ok', 'caution', 'red-flag'], 'caution'), notes: str(leg.notes) },
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
