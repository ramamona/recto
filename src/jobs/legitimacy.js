// Posting legitimacy heuristics (assist spec 5). Pure; severities: high → red-flag, medium → caution, low → info only.
import { parseJob } from './parse.js'

const STALE_DAYS = 45
const PAYMENT = /\b(?:pay|paid|payment|deposit|purchase|buy)\b[^.\n]{0,40}\b(?:fee|fees|training|equipment|kit|starter|registration|background check)\b|\b(?:registration|training|processing|application|onboarding) fee\b|\bwire transfer\b|\bgift cards?\b/i
const SENSITIVE = /\b(?:SSN|social security (?:number|no)|bank (?:account|details|information|statement)s?|routing number|credit card|(?:copy|photo|scan) of (?:your )?(?:passport|id|driver'?s licen[cs]e|national id)|passport (?:copy|number)|date of birth)\b/i
const MESSAGING = /\b(?:telegram|whatsapp|wechat|signal app|google hangouts|kik)\b/i
const PRESSURE = /\burgent(?:ly)?\b|\bimmediate(?:ly)? (?:start|hire|hiring)\b|\bno experience (?:needed|necessary|required)\b|\b(?:easy|quick|fast) (?:money|cash)\b|\bearn (?:up to )?[$€£]?\s?\d[\d,]*\+? (?:per|a|\/) ?(?:day|week)\b|\bunlimited earnings?\b/i
const EXEC = /\b(?:chief|c[etfo]o|vp|vice president|director|head|principal|partner|founder)\b/i
const FREE_MAIL = /^(?:gmail|googlemail|yahoo|hotmail|outlook|live|aol|icloud|proton|protonmail|gmx|mail|yandex|zoho)\.[a-z.]+$/
const MAX_ANNUAL = 400000
const PER_YEAR = { year: 1, month: 12, hour: 2080 }

const norm = s => String(s ?? '').trim().toLowerCase()
const slug = s => norm(s).replace(/\b(?:inc|llc|ltd|gmbh|corp|co|plc|ag|sa|bv)\b\.?/g, '').replace(/[^a-z0-9]/g, '')

function lineWith(text, re) {
  const m = text.match(re)
  if (!m) return null
  const start = text.lastIndexOf('\n', m.index) + 1
  const end = text.indexOf('\n', m.index)
  return text.slice(start, end < 0 ? undefined : end).trim().slice(0, 160)
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' }
}

function emailMismatch(email, company, url) {
  const domain = email.split('@')[1].toLowerCase()
  if (FREE_MAIL.test(domain)) return true
  const host = hostOf(url)
  if (host && (host === domain || host.endsWith('.' + domain) || domain.endsWith('.' + host))) return false
  const s = slug(company), first = slug(company.split(/\s+/)[0])
  if (!s) return false
  const d = domain.replace(/[^a-z0-9]/g, '')
  return !(d.includes(s) || (first.length >= 3 && d.includes(first)))
}

/** `job`: a Job (title, company, text, postedAt, url, id). `saved`: tracker jobs, for repost detection. */
export function checkLegitimacy(job, { saved = [], now = new Date(), parsed } = {}) {
  const j = job ?? {}
  const text = String(j.text ?? '')
  const p = parsed ?? parseJob(text, { now })
  const title = j.title || p.title || ''
  const company = j.company || p.company || ''
  const postedAt = j.postedAt || p.postedAt
  const signals = []
  const add = (code, severity, evidence = '') => signals.push({ code, severity, evidence })

  if (!postedAt) add('no-date', 'low')
  else if ((now - Date.parse(postedAt)) / 864e5 > STALE_DAYS) add('stale', 'medium', postedAt)
  if (title && company && saved.some(s => s?.id !== j.id && norm(s?.title) === norm(title) && norm(s?.company) === norm(company))) {
    add('reposted', 'medium', `${title} · ${company}`)
  }
  if (!company) add('no-company', 'medium')
  for (const [code, re] of [['payment', PAYMENT], ['sensitive-data', SENSITIVE], ['messaging-app', MESSAGING]]) {
    const line = lineWith(text, re)
    if (line) add(code, 'high', line)
  }
  const pay = p.salary
  if (pay) {
    if (pay.max * PER_YEAR[pay.period] > MAX_ANNUAL && !EXEC.test(title)) add('salary-high', 'medium', pay.text)
    if (pay.min > 0 && pay.max / pay.min > 3) add('salary-range', 'medium', pay.text)
  }
  if (p.keywords.length < 3 && p.requirements.length < 3) add('generic', 'medium')
  const odd = (p.signals.emails ?? []).find(e => emailMismatch(e, company, j.url))
  if (odd) add('email-domain', 'medium', odd)
  const rush = lineWith(text, PRESSURE)
  if (rush) add('pressure', 'medium', rush)

  const level = signals.some(s => s.severity === 'high') ? 'red-flag' : signals.some(s => s.severity === 'medium') ? 'caution' : 'ok'
  return { level, signals }
}
