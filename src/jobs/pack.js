// Application pack for one job (discover-apply spec §3, career-suite spec §3): standard fields and rule-based answers from
// the profile and CV, then the answer bank; AI drafts only for free-text questions (guarded against invented facts);
// everything else stays unanswered. Pure except
// the injected `assist` (createAssist() result).
import { parse } from '../model/markdown.js'
import { normalizeProfile, prefillProfile, hasWorkAuth, workCountries, REFEREES_DEFAULT } from '../profile.js'
import { authorizedFor as inCountries, countriesIn, countryOf, regionOf } from './region.js'
import { findAnswer } from './answers.js'

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
  ['Salary expectation', 'salaryExpectation'], ['Notice period', 'noticePeriod'], ['Preferred name', 'preferredName'], ['Portfolio', 'portfolio'],
  ['Street address', 'street'], ['State', 'state'], ['Postcode', 'postcode']]

const str = v => typeof v === 'string' ? v : ''
const optionLabel = o => typeof o === 'string' ? o : str(o?.label) || String(o?.value ?? '')
const lower = s => str(s).trim().toLowerCase()

/** Whether the profile may work in a country the text (question + job location) mentions: `authorizedIn` plus the
 * country its `workRights` cover (region.js presets: names, codes, aliases, major places). */
export const authorizedFor = (p, text) => inCountries(workCountries(p), text)

const yesNo = b => b == null ? null : { answer: b ? 'Yes' : 'No', source: 'profile' }
const profile = answer => answer ? { answer, source: 'profile' } : null
// A Yes/No question: Yes/No options, or (free text) phrased "Are you… / Do you…"
const isYesNo = (label, options) => options.length ? options.some(o => /^(?:yes|no)\b/i.test(o)) : /^(?:are|do|does|have|has|would|will|can|could|is|did)\b/.test(label)
const needsVisa = p => p.needsSponsorship || p.workRights === 'needs-visa'
// The question alone when it names a country; else question + job location ("…the country where this job is located")
const scope = ({ raw, where }) => countriesIn(raw).length ? raw : where

// `key` null: always decline (EEO-style questions the profile has no field for)
function eeo (key) {
  return ({ p, options }) => {
    const v = key ? p.eeo?.[key] ?? 'decline' : 'decline'
    if (v !== 'decline') return { answer: v, source: 'profile' }
    const opt = options.find(o => DECLINE_RE.test(o))
    return { answer: opt ?? (options.length ? '' : DECLINE), source: 'rule' }
  }
}

const STATUS = { citizen: 'Citizen', 'permanent-resident': 'Permanent resident', 'nz-citizen': 'New Zealand citizen', 'settled-status': 'Settled status',
  visa: 'Visa holder', 'needs-visa': 'I require a visa' }
const NZ = /new zealand|\bnz\b/
const STATUS_OPTION = { citizen: o => /citizen/.test(o) && !NZ.test(o), 'permanent-resident': o => /permanent/.test(o), 'nz-citizen': o => NZ.test(o),
  'settled-status': o => /settled/.test(o), visa: o => /visa|temporary/.test(o) && !/requir|need|sponsor/.test(o), 'needs-visa': o => /requir|need|sponsor/.test(o) }
const STATUS_ASKED = { citizen: l => /citizen/.test(l), 'permanent-resident': l => /permanent resid|\bpr\b/.test(l), 'nz-citizen': l => NZ.test(l), 'settled-status': l => /settled/.test(l) }

// Citizenship / residency: Yes/No ("Are you a citizen or PR?"), a status option, or the status in words
function citizenship ({ p, label, raw, options }) {
  const w = p.workRights
  if (!w) return null
  const named = countriesIn(raw)
  if (named.length && !named.includes(countryOf(p.country)) && !(w === 'nz-citizen' && named.includes('NZ'))) return null
  if (isYesNo(label, options)) return yesNo(STATUS_ASKED[w]?.(label) ?? false)
  if (options.length) return profile(options.find(o => STATUS_OPTION[w](lower(o))))
  return profile(STATUS[w])
}

const TRAVEL = { none: 'No', occasional: 'Yes, occasionally', frequent: 'Yes, frequently' }
const TRAVEL_OPTION = { none: /\bno\b|none|never|not willing/, occasional: /occasion|some|little|up to (?:10|25)/, frequent: /frequent|often|regular|extensive/ }
const TYPE_RE = { 'full-time': /full[- ]?time|permanent/, 'part-time': /part[- ]?time/, contract: /contract|fixed[- ]term|temp/, casual: /casual/, internship: /intern/ }
const TYPE_LABEL = { 'full-time': 'Full-time', 'part-time': 'Part-time', contract: 'Contract', casual: 'Casual', internship: 'Internship' }

function employmentType ({ p, label, options }) {
  const types = p.employmentTypes ?? []
  if (!types.length) return null
  if (isYesNo(label, options)) {
    const named = Object.keys(TYPE_RE).filter(k => TYPE_RE[k].test(label))
    return named.length ? yesNo(named.some(k => types.includes(k))) : null
  }
  if (options.length) return profile(types.map(k => options.find(o => TYPE_RE[k].test(lower(o)))).find(Boolean))
  return profile(types.map(k => TYPE_LABEL[k]).join(', '))
}

const CHECK_LABEL = { current: 'Yes, I hold a current check', willing: 'I am willing to obtain one', no: 'No' }
// "Do you have a current check?" → Yes only when current; "Are you willing to undergo one?" → Yes unless 'no'
function check (key) {
  return ({ p, label, options }) => {
    const v = p[key]
    if (!v) return null
    if (isYesNo(label, options)) return yesNo(/willing|consent|prepared|happy to|undergo|obtain|able to provide/.test(label) ? v !== 'no' : v === 'current')
    return profile(CHECK_LABEL[v])
  }
}

// The option covering `n` years: '3-5', '10+', '5 or more', 'less than 2', or an exact number
function yearsOption (options, n) {
  const nums = o => (o.match(/\d+/g) ?? []).map(Number)
  return options.find(o => {
    const l = lower(o)
    const [a, b] = nums(l)
    if (a == null) return false
    if (/less than|under|fewer than|</.test(l)) return n < a
    if (/\+|or more|and above|plus|more than|over/.test(l)) return /more than|over/.test(l) ? n > a : n >= a
    return b != null ? n >= a && n <= b : n === a
  })
}

const retirementOf = p => regionOf(p.country)?.retirement ?? 'retirement contributions'
const BASIS = { base: () => 'base', 'base-plus-retirement': p => `base + ${retirementOf(p)}`, 'total-package': () => 'total package' }

// First match wins; order matters (sponsorship before authorization, relocation and authorization before location/country).
const RULES = [
  [/pronoun/, ({ value }) => value('pronouns')],
  [/\bgender\b|\bsex\b/, eeo('gender')],
  [/aboriginal|torres strait|indigenous|first nations/, eeo('indigenous')],
  [/\brace\b|ethnic|hispanic|latin[oax]/, eeo('race')],
  [/veteran/, eeo('veteran')],
  [/disabilit/, eeo('disability')],
  [/sexual orientation|transgender|lgbt/, eeo('lgbtq')],
  // "authorized … without sponsorship" is an authorization question
  [/^(?!.*without[^?]{0,40}sponsor).*\bsponsor/, c => hasWorkAuth(c.p) ? yesNo(needsVisa(c.p) && !authorizedFor(c.p, scope(c))) : null],
  [/authori[sz]|eligib|right to work|legally|work(?:ing)? rights? (?:in|for)\b|entitled to work|permi(?:ssion|tted) to work/, c => !hasWorkAuth(c.p) ? null
    : authorizedFor(c.p, scope(c)) ? yesNo(true) : needsVisa(c.p) ? yesNo(false) : null],
  [/type of visa|visa (?:type|subclass|class|category)|subclass|visa (?:do )?you hold|visa expir|when does your visa|visa (?:end|valid)/, ({ label, value }) =>
    /expir|end|valid/.test(label) ? value('visaExpiry') : value('visaType')],
  [/citizen|permanent resid|residency|work(?:ing)? rights|visa status|immigration status/, citizenship],
  [/relocat/, ({ p }) => yesNo(p.willingToRelocate)],
  [/travel/, ({ p, label, options }) => {
    const v = p.willingToTravel
    if (!v) return null
    if (isYesNo(label, options)) return yesNo(v !== 'none')
    return profile(options.length ? options.find(o => TRAVEL_OPTION[v].test(lower(o))) : TRAVEL[v])
  }],
  [/day rate|daily rate/, ({ value }) => value('dayRate')],
  [/salary|compensation|pay expectation|desired pay/, ({ p, value, options }) => {
    const v = value('salaryExpectation')
    if (!v || options.length || !p.salaryBasis || /super|package|base|kiwisaver|pension|401/i.test(v.answer)) return v
    return { ...v, answer: `${v.answer} (${BASIS[p.salaryBasis](p)})` }
  }],
  [/notice period/, ({ value }) => value('noticePeriod')],
  [/start date|when can you start|earliest (?:possible )?start|available to start|commence/, ({ value }) => value('earliestStart') ?? value('noticePeriod')],
  [/employment type|type of (?:employment|work|role|contract)|work type|job type|(?:full|part)[- ]?time|\bcasual\b|contract or permanent|permanent or contract|internship/, employmentType],
  [/working with (?:children|vulnerable)|\bwwc\b|blue card/, check('workingWithChildren')],
  [/police (?:check|clearance|certificate)/, check('policeCheck')],
  [/background (?:check|screen)|pre-employment (?:check|screen)/, check('backgroundCheck')],
  [/clearance|\bnv ?[12]\b|agsva/, ({ p, label, options }) => {
    const v = str(p.clearance)
    if (!v) return null
    return isYesNo(label, options) ? yesNo(!/^(?:none|no|nil|n\/?a)$/i.test(v)) : profile(v)
  }],
  [/driv\w*['’]?s? licen[cs]e|licen[cs]e to drive|driving licen/, ({ p }) => yesNo(p.driversLicence)],
  [/own (?:car|vehicle|transport)|access to (?:a |your own )?(?:car|vehicle)|reliable transport/, ({ p }) => yesNo(p.ownVehicle)],
  [/highest (?:level of )?(?:education|qualification|degree)|education level|level of education/, ({ value }) => value('highestEducation')],
  // overall experience only: "years of experience with React" is a skill question
  [/^(?!.*\b(?:with|using|in(?! total))\b)(?=.*(?:years of (?:relevant |professional |work |industry |total )?experience|how many years))/, ({ p, options }) => {
    const n = p.yearsExperience
    if (typeof n !== 'number') return null
    return profile(options.length ? yearsOption(options, n) : String(n))
  }],
  [/^(?!.*(?:programming|coding|scripting|query))(?=.*(?:\blanguages?\b|\bfluen|\bspeak\b))/, ({ p, label, options }) => {
    const langs = p.languages ?? []
    if (!langs.length) return null
    const has = o => langs.some(l => lower(o).includes(lower(l)))
    if (isYesNo(label, options)) return has(label) ? yesNo(true) : null
    return profile(options.length ? options.find(has) : langs.join(', '))
  }],
  [/referee|\breferences\b|provide (?:a |two |three )?references?/, ({ p, label, options }) =>
    isYesNo(label, options) ? { answer: 'Yes', source: 'rule' } : profile(p.referees) ?? { answer: REFEREES_DEFAULT, source: 'rule' }],
  [/hear about|how did you (?:hear|find|learn)|referral source/, ({ options }) =>
    ({ answer: options.length ? options.find(o => /career|company (?:web)?site/i.test(o)) ?? '' : HEARD_ABOUT, source: 'rule' })],
  [/preferred (?:first )?name|known as|nickname/, ({ p, value }) => profile(p.preferredName) ?? value('firstName')],
  [/first name|given name/, ({ value }) => value('firstName')],
  [/last name|family name|surname/, ({ value }) => value('lastName')],
  [/full name|^name$|^your name$/, ({ value }) => {
    const [f, l] = [value('firstName'), value('lastName')]
    return f && l ? { answer: `${f.answer} ${l.answer}`, source: f.source === 'cv' || l.source === 'cv' ? 'cv' : 'profile' } : f
  }],
  [/e-?mail/, ({ value }) => value('email')],
  [/phone|mobile/, ({ value }) => value('phone')],
  [/linkedin/, ({ value }) => value('linkedin')],
  [/github/, ({ value }) => value('github')],
  [/portfolio/, ({ value }) => value('portfolio') ?? value('website')],
  [/website|personal (?:site|url)|blog/, ({ value }) => value('website')],
  [/street|address line|(?:home|postal|residential|mailing) address|^address$/, ({ value }) => value('street')],
  [/post ?code|postal code|\bzip\b/, ({ value }) => value('postcode')],
  [/^(?:state|province|region)\b|state\/(?:province|territory)|state or territory|(?:which|what) state|state of residence/, ({ value }) => value('state')],
  [/\bcity\b/, ({ value }) => value('city')],
  [/\bcountry\b/, ({ value }) => value('country')],
  [/^(?:current )?location|where are you (?:located|based)/, ({ p }) => profile([p.city, p.state, p.country].filter(Boolean).join(', '))]
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
  const r = rule?.[1]({ ...ctx, p, value, label, raw: str(q?.label), where: ctx?.where ?? str(q?.label), options })
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
  // then the answer bank (answers the candidate gave before to similar questions)
  questions.forEach((q, i) => {
    if (answers[i] || /file/.test(q.type)) return
    const hit = findAnswer(base.answers, q.label, { options: q.options })
    if (hit) answers[i] = { answer: hit.answer, source: 'bank' }
  })

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
