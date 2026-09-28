// Application pack for one job (discover-apply spec §3): standard fields and rule-based answers from the profile and CV;
// AI drafts only for free-text questions (guarded against invented facts); everything else stays unanswered. Pure except
// the injected `assist` (createAssist() result).
import { parse } from '../model/markdown.js'
import { normalizeProfile, prefillProfile, hasWorkAuth } from '../profile.js'

export const HEARD_ABOUT = 'Company careers page'
export const DECLINE = 'Decline to self-identify'
/** A decline / prefer-not-to-say option. */
export const DECLINE_RE = /decline|prefer not|rather not|(?:not|n['’]t) (?:wish|want)|not to (?:say|answer|disclose|self)/i

// Asked when the posting exposes no questions (Lever, Ashby, feeds)
export const COMMON_QUESTIONS = [
  'Are you legally authorized to work in the country where this job is located?',
  'Will you now or in the future require visa sponsorship?',
  'Are you willing to relocate?',
  'What are your salary expectations?',
  'What is your notice period?',
  'How did you hear about this job?',
  'LinkedIn profile',
  'GitHub profile',
  'Website',
  'Why do you want to work here?'
].map(label => ({ label, type: 'text', required: false }))

const FIELDS = [['First name', 'firstName'], ['Last name', 'lastName'], ['Email', 'email'], ['Phone', 'phone'], ['LinkedIn', 'linkedin'],
  ['GitHub', 'github'], ['Website', 'website'], ['City', 'city'], ['Country', 'country'], ['Pronouns', 'pronouns'],
  ['Salary expectation', 'salaryExpectation'], ['Notice period', 'noticePeriod']]

const str = v => typeof v === 'string' ? v : ''
const optionLabel = o => typeof o === 'string' ? o : str(o?.label) || String(o?.value ?? '')
const lower = s => str(s).trim().toLowerCase()

// ponytail: country match is a word check on the question + job location with a few alias groups (as evaluate.js);
// a geocoder would be exact. Two-letter codes match only in capitals ("US", not the word "us").
export const COUNTRY_ALIASES = [['us', 'usa', 'united states', 'united states of america', 'america'],
  ['uk', 'gb', 'united kingdom', 'great britain', 'britain', 'england'], ['de', 'germany', 'deutschland'], ['fr', 'france'], ['ca', 'canada']]
const words = s => ` ${str(s).replace(/[^\p{L}\p{N}]+/gu, ' ')} `

/** Whether the profile's authorizedIn names a country the text (question + job location) mentions, aliases included. */
export function authorizedFor (p, text) {
  const raw = words(text)
  const low = raw.toLowerCase()
  return (p?.authorizedIn ?? []).some(c => (COUNTRY_ALIASES.find(g => g.includes(lower(c))) ?? [lower(c)])
    .some(a => a.length === 2 ? raw.includes(` ${a.toUpperCase()} `) : low.includes(` ${a} `)))
}

const yesNo = b => b == null ? null : { answer: b ? 'Yes' : 'No', source: 'profile' }

// `key` null: always decline (EEO-style questions the profile has no field for)
function eeo (key) {
  return ({ p, options }) => {
    const v = key ? p.eeo[key] : 'decline'
    if (v !== 'decline') return { answer: v, source: 'profile' }
    const opt = options.find(o => DECLINE_RE.test(o))
    return { answer: opt ?? (options.length ? '' : DECLINE), source: 'rule' }
  }
}

// First match wins; order matters (sponsorship before authorization, relocation and authorization before location/country).
const RULES = [
  [/pronoun/, ({ value }) => value('pronouns')],
  [/\bgender\b|\bsex\b/, eeo('gender')],
  [/\brace\b|ethnic|hispanic|latin[oax]/, eeo('race')],
  [/veteran/, eeo('veteran')],
  [/disabilit/, eeo('disability')],
  [/sexual orientation|transgender|lgbt/, eeo(null)],
  // "authorized … without sponsorship" is an authorization question
  [/^(?!.*without[^?]{0,40}sponsor).*\bsponsor/, ({ p, where }) => hasWorkAuth(p) ? yesNo(p.needsSponsorship && !authorizedFor(p, where)) : null],
  [/authori[sz]|eligib|right to work|legally/, ({ p, where }) => !hasWorkAuth(p) ? null
    : authorizedFor(p, where) ? yesNo(true) : p.needsSponsorship ? yesNo(false) : null],
  [/relocat/, ({ p }) => yesNo(p.willingToRelocate)],
  [/salary|compensation|pay expectation|desired pay/, ({ value }) => value('salaryExpectation')],
  [/notice period|start date|when can you start|earliest start/, ({ value }) => value('noticePeriod')],
  [/hear about|how did you (?:hear|find|learn)|referral source/, ({ options }) =>
    ({ answer: options.length ? options.find(o => /career|company (?:web)?site/i.test(o)) ?? '' : HEARD_ABOUT, source: 'rule' })],
  [/first name|given name|preferred name/, ({ value }) => value('firstName')],
  [/last name|family name|surname/, ({ value }) => value('lastName')],
  [/full name|^name$|^your name$/, ({ value }) => {
    const [f, l] = [value('firstName'), value('lastName')]
    return f && l ? { answer: `${f.answer} ${l.answer}`, source: f.source === 'cv' || l.source === 'cv' ? 'cv' : 'profile' } : f
  }],
  [/e-?mail/, ({ value }) => value('email')],
  [/phone|mobile/, ({ value }) => value('phone')],
  [/linkedin/, ({ value }) => value('linkedin')],
  [/github/, ({ value }) => value('github')],
  [/website|portfolio|personal (?:site|url)|blog/, ({ value }) => value('website')],
  [/\bcity\b/, ({ value }) => value('city')],
  [/\bcountry\b/, ({ value }) => value('country')],
  [/^(?:current )?location|where are you (?:located|based)/, ({ p }) => {
    const answer = [p.city, p.country].filter(Boolean).join(', ')
    return answer ? { answer, source: 'profile' } : null
  }]
]

// An answer for a choice question must be one of its options (exact, or the option starts with it: "Yes, I am…")
function pick (options, answer) {
  if (!options.length || !answer) return answer
  const a = lower(answer)
  return options.find(o => lower(o) === a) ?? options.find(o => lower(o).startsWith(a) && !/\p{L}/u.test(lower(o)[a.length])) ?? ''
}

/** Index of the rule that answers `label` (-1 = none): two labels with the same index ask the same thing. */
export const ruleOf = label => RULES.findIndex(([re]) => re.test(lower(label)))

/**
 * Rule-based answer for `q` ({ label, type?, options? }) or null. `ctx`: { p } (normalized profile, CV-prefilled),
 * optional `where` (question + job location; default the label), `pdfName`, and `value(key)` → { answer, source }.
 * Choice answers are always one of `q.options`.
 */
export function ruleAnswer (q, ctx) {
  const label = lower(q?.label)
  const options = Array.isArray(q?.options) ? q.options : []
  const p = ctx?.p ?? {}
  if (/file/.test(str(q?.type))) return /resume|\bcv\b|curriculum/.test(label) && ctx?.pdfName ? { answer: ctx.pdfName, source: 'cv' } : null
  const value = ctx?.value ?? (k => str(p[k]) ? { answer: p[k], source: 'profile' } : null)
  const rule = RULES[ruleOf(label)]
  const r = rule?.[1]({ ...ctx, p, value, where: ctx?.where ?? label, options }, label)
  if (!r) return null
  const answer = pick(options, r.answer)
  return answer ? { answer, source: r.source } : null
}

const pdfNameOf = p => [p.firstName, p.lastName, 'CV'].map(s => s.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')).filter(Boolean).join('-') + '.pdf'

/**
 * `job`: a tracker job or Posting ({ id, title, company, location, text, questions? }); `cv`: { docId, content, doc? }.
 * The caller sets `coverLetterDocId` and stores the pack on the job. Never rejects on AI failure.
 */
export async function buildPack ({ job, cv, profile, assist, now = () => new Date() }) {
  const base = normalizeProfile(profile)
  const p = prefillProfile(base, cv?.doc ?? parse(str(cv?.content)))
  const value = k => p[k] ? { answer: p[k], source: base[k] ? 'profile' : 'cv' } : null
  const pdfName = pdfNameOf(p)
  const ctx = { p, value, pdfName, where: '' }

  const asked = Array.isArray(job?.questions) && job.questions.length ? job.questions : COMMON_QUESTIONS
  const questions = asked.filter(q => q && str(q.label).trim()).map(q => ({
    label: str(q.label).trim(), type: str(q.type) || 'text', required: q.required === true,
    options: Array.isArray(q.options) ? q.options.map(optionLabel).filter(Boolean) : []
  }))
  const answers = questions.map(q => ruleAnswer(q, { ...ctx, where: `${q.label} ${str(job?.location)}` }))

  // AI only for free text: no options, not a file upload
  const free = questions.map((q, i) => i).filter(i => !answers[i] && !questions[i].options.length && !/file/.test(questions[i].type))
  if (free.length && typeof assist?.answer === 'function') {
    try {
      const res = await assist.answer(job, free.map(i => ({ label: questions[i].label })), { profile: p })
      free.forEach((i, k) => {
        const a = res?.answers?.[k]
        if (a?.status === 'ok' && str(a.answer).trim()) answers[i] = { answer: a.answer.trim(), source: 'ai' }
      })
    } catch {} // AI down or unreadable: those questions stay unanswered
  }

  return {
    jobId: str(job?.id),
    cvDocId: str(cv?.docId),
    fields: FIELDS.filter(([, k]) => p[k]).map(([label, k]) => ({ label, value: p[k] })),
    answers: questions.map((q, i) => ({
      question: q.label, type: q.type, required: q.required,
      answer: answers[i]?.answer ?? '', source: answers[i]?.source ?? 'unanswered',
      ...(q.options.length ? { options: q.options } : {})
    })),
    pdfName,
    createdAt: now().toISOString()
  }
}
