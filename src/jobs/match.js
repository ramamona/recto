// Recto match estimate (assist spec 4): CV vs parsed job, pure, no AI.
import { normalizeLayout } from '../model/layout.js'
import { extractText, extractFields } from '../preflight/ats.js'
import { runPreflight } from '../preflight/rules.js'
import { parseJob, canonicalTokens, SOFT_SKILLS } from './parse.js'

export const WEIGHTS = { keywords: 55, requirements: 20, parseability: 15, essentials: 10 }
const TITLE_STOP = new Set(['and', 'of', 'the', 'for', 'in', 'to', 'a', 'an', 'with'])

const phrase = text => canonicalTokens(text).join(' ')
const containsIn = hay => kw => { const p = phrase(kw); return p !== '' && hay.includes(` ${p} `) }
const pct = (num, den) => den ? Math.round(100 * num / den) : 0

function parseability(issues) {
  let score = 100
  for (const i of issues) {
    score -= i.rule === 'multi-column' ? 15 : i.rule === 'nonstandard-heading' ? 5 : i.severity === 'error' ? 15 : i.severity === 'warn' ? 5 : 0
  }
  return Math.max(0, score)
}

function essentials(fields, title) {
  const experience = fields.sections.filter(s => s.category === 'experience')
  const recent = [fields.label, ...experience.flatMap(s => s.entries).slice(0, 3).map(e => e.title)].join(' ')
  const has = containsIn(` ${phrase(recent)} `)
  const words = canonicalTokens(title).filter(w => !TITLE_STOP.has(w))
  const aligned = !words.length || words.filter(has).length * 2 >= words.length
  const checks = [!!fields.name.trim(), fields.emails.length > 0, fields.phones.length > 0,
    experience.some(s => s.entries.some(e => e.start)), aligned]
  return pct(checks.filter(Boolean).length, checks.length)
}

/**
 * `{ score, bands: { keywords, requirements, parseability, essentials: { score, weight } }, missing, present }`.
 * `job` is a parseJob result or a Job (its text is parsed). `issues` defaults to a fresh preflight run.
 */
export function matchCv({ doc, source = '', layout, report = null, issues } = {}, job) {
  const l = normalizeLayout(layout)
  const p = job?.requirements ? job : parseJob(job?.text ?? '')
  const cvText = doc ? extractText(doc, l) : ''
  const has = containsIn(` ${phrase(cvText)} `)

  const kinds = new Map()
  for (const r of p.requirements) for (const k of r.keywords) if (kinds.get(k) !== 'must') kinds.set(k, r.kind)
  for (const k of p.keywords ?? []) if (!kinds.has(k)) kinds.set(k, 'nice')
  const all = [...kinds].map(([keyword, kind]) => ({ keyword, kind, weight: kind === 'must' ? 2 : 1, found: has(keyword) }))
  const weight = list => list.reduce((s, k) => s + k.weight, 0)

  const withKeywords = p.requirements.filter(r => r.keywords.length)
  const musts = withKeywords.filter(r => r.kind === 'must')
  const reqs = musts.length ? musts : withKeywords

  const fields = doc ? extractFields(doc, l) : { name: '', label: '', emails: [], phones: [], sections: [] }
  const found = issues ?? (doc ? runPreflight({ source, doc, layout: l, report }) : [])
  const scores = {
    keywords: pct(weight(all.filter(k => k.found)), weight(all)),
    requirements: pct(reqs.filter(r => r.keywords.some(has)).length, reqs.length),
    parseability: parseability(found),
    essentials: essentials(fields, p.title || job?.title || '')
  }
  const bands = Object.fromEntries(Object.entries(WEIGHTS).map(([k, w]) => [k, { score: scores[k], weight: w }]))
  const score = Math.round(Object.entries(WEIGHTS).reduce((s, [k, w]) => s + scores[k] * w, 0) / 100)

  const sectionOf = category => fields.sections.find(s => s.category === category)?.id ?? null
  const skills = sectionOf('skills'), experience = sectionOf('experience')
  const missing = all.filter(k => !k.found).map(({ keyword, kind }) => ({
    keyword, kind, where: SOFT_SKILLS.has(keyword) ? experience ?? skills : skills ?? experience
  }))
  const lines = String(source).split('\n').map(line => ` ${phrase(line)} `)
  const present = all.filter(k => k.found).map(({ keyword }) => ({
    keyword, lines: lines.flatMap((hay, i) => containsIn(hay)(keyword) ? [i + 1] : [])
  }))
  return { score, bands, missing, present }
}
