// Job description → structured posting (assist spec 3). Pure heuristics, never throws.

// Canonical name first, then aliases. Matching is case-insensitive except CASE_SENSITIVE.
const TECH = [
  ['JavaScript', 'js', 'ecmascript', 'es6'], ['TypeScript', 'ts'], ['Python'], ['Java'], ['Go', 'golang'], ['Rust'], ['Ruby'],
  ['PHP'], ['Kotlin'], ['Swift'], ['Scala'], ['C++', 'cpp'], ['C#', 'csharp'], ['.NET', 'dotnet'], ['Elixir'], ['Haskell'],
  ['SQL'], ['NoSQL'], ['Bash'], ['Node.js', 'nodejs'], ['React', 'react.js', 'reactjs'], ['React Native'], ['Vue', 'vue.js', 'vuejs'],
  ['Angular', 'angularjs'], ['Svelte'], ['Next.js', 'nextjs'], ['Django'], ['Flask'], ['FastAPI'], ['Spring Boot'], ['Ruby on Rails', 'rails'],
  ['GraphQL'], ['REST', 'restful', 'rest api', 'rest apis'], ['gRPC'], ['HTML', 'html5'], ['CSS', 'css3'], ['Sass'], ['Tailwind', 'tailwind css'],
  ['Redux'], ['Storybook'], ['Webpack'], ['Vite'], ['Jest'], ['Cypress'], ['Playwright'], ['Selenium'],
  ['PostgreSQL', 'postgres', 'psql'], ['MySQL'], ['SQLite'], ['MongoDB', 'mongo'], ['Redis'], ['Elasticsearch', 'elastic search'],
  ['Cassandra'], ['DynamoDB'], ['Snowflake'], ['BigQuery'], ['Kafka', 'apache kafka'], ['RabbitMQ'], ['Spark', 'apache spark'],
  ['Hadoop'], ['Airflow', 'apache airflow'], ['dbt'], ['AWS', 'amazon web services'], ['GCP', 'google cloud', 'google cloud platform'],
  ['Azure', 'microsoft azure'], ['Docker'], ['Kubernetes', 'k8s'], ['Terraform'], ['Ansible'], ['Helm'], ['Jenkins'], ['GitHub Actions'],
  ['CI/CD', 'ci cd', 'cicd', 'continuous integration', 'continuous delivery', 'continuous deployment'], ['Linux'], ['Git'],
  ['Prometheus'], ['Grafana'], ['Datadog'], ['Serverless'], ['AWS Lambda'], ['Microservices', 'microservice', 'micro-services'],
  ['Machine learning', 'ml'], ['Deep learning'], ['NLP', 'natural language processing'], ['LLM', 'llms', 'large language models'],
  ['AI', 'artificial intelligence'], ['PyTorch'], ['TensorFlow'], ['pandas'], ['NumPy'], ['scikit-learn', 'sklearn'], ['Tableau'],
  ['Power BI', 'powerbi'], ['Excel', 'microsoft excel'], ['Looker'], ['Statistics'], ['A/B testing', 'ab testing', 'a/b tests'],
  ['Figma'], ['UX', 'user experience'], ['UI', 'user interface'], ['Accessibility', 'a11y'], ['WCAG'], ['iOS'], ['Android'],
  ['Agile'], ['Scrum'], ['Kanban'], ['Jira'], ['TDD', 'test-driven development'], ['OAuth'], ['SAML']
]
const SOFT = [
  ['Mentoring', 'mentorship'], ['Leadership'], ['Communication', 'communication skills'], ['Stakeholder management'],
  ['Project management'], ['Product management'], ['Cross-functional'], ['Problem solving', 'problem-solving'], ['Collaboration']
]
const CASE_SENSITIVE = new Set(['Go'])
export const SOFT_SKILLS = new Set(SOFT.map(g => g[0]))

const escape = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const bounded = v => `(?<![A-Za-z0-9])${escape(v)}(?![A-Za-z0-9+#])`
const VOCAB = [...TECH, ...SOFT].map(([name, ...aliases]) => ({
  name,
  re: new RegExp([name, ...aliases].sort((a, b) => b.length - a.length).map(bounded).join('|'), CASE_SENSITIVE.has(name) ? 'g' : 'gi')
}))

// Capitalised words that are not skills when they appear mid-sentence
const STOP = new Set(('I A An The We You Our Your Us US USA UK EU OR AND TBD FAQ HR CEO CTO EOE NYC PTO FTE OTE ' +
  'English German French Spanish Bachelor Bachelors Master Masters Degree BS BA MS MA PhD MBA ' +
  'January February March April May June July August September October November December ' +
  'Monday Tuesday Wednesday Thursday Friday Saturday Sunday Remote Hybrid Senior Junior Lead Staff Principal').split(' '))

/** Skills/tools named in `text`, canonical names, in order of first appearance. `vocabOnly` skips the loose heuristics. */
export function keywordsIn(text, { vocabOnly = false } = {}) {
  const s = String(text ?? '')
  const hits = []
  const covered = []
  const inVocab = (a, b) => covered.some(([x, y]) => a < y && b > x)
  const found = VOCAB.flatMap(({ name, re }) => [...s.matchAll(re)].map(m => ({ at: m.index, end: m.index + m[0].length, name })))
  for (const h of found.sort((a, b) => a.at - b.at || b.end - a.end)) {
    if (inVocab(h.at, h.end)) continue // 'js' inside 'Node.js'
    hits.push(h)
    covered.push([h.at, h.end])
  }
  if (!vocabOnly) {
    // acronyms (SQL-like), internal capitals (GraphQL-like), and Capitalised words not starting a sentence
    for (const m of s.matchAll(/(?<![\w.#+])(?:[A-Z]{2,6}s?|[A-Za-z]+[a-z0-9][A-Z][A-Za-z0-9]*|[A-Z][a-z][a-z0-9]+)(?![\w+#])/g)) {
      const w = m[0].replace(/^([A-Z]{2,6})s$/, '$1'), before = s.slice(0, m.index) // APIs → API
      if (STOP.has(w) || inVocab(m.index, m.index + w.length)) continue
      if (/^[A-Z][a-z]/.test(w) && !/[A-Z]/.test(w.slice(1)) && /(^|[.!?]\s*|\n\s*[-*•·▪◦●]?\s*|\n\s*\d+[.)]\s*)$/.test(before)) continue
      hits.push({ at: m.index, name: w })
    }
  }
  const seen = new Set()
  return hits.sort((a, b) => a.at - b.at).map(h => h.name).filter(n => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()))
}

// ---- normalized tokens for matching (used by match.js)

const tokenId = name => name.toLowerCase().replace(/\+/g, 'plus').replace(/#/g, 'sharp').replace(/\./g, 'dot').replace(/[^a-z0-9]/g, '')
const ALIAS_RE = new RegExp(VOCAB.map(v => v.re.source).join('|'), 'gi')
const ALIAS_OF = new Map()
for (const [name, ...aliases] of [...TECH, ...SOFT]) for (const a of [name, ...aliases]) ALIAS_OF.set(a.toLowerCase(), tokenId(name))

function stem(t) {
  if (t.length <= 4 || /\d/.test(t)) return t
  if (t.endsWith('ies')) return t.slice(0, -3) + 'y'
  if (t.endsWith('ing') && t.length > 5) return t.slice(0, -3)
  if (t.endsWith('ed')) return t.slice(0, -2)
  if (t.endsWith('s') && !/(ss|us|is)$/.test(t)) return t.slice(0, -1)
  return t
}

/** Lower-cased, alias-folded, lightly stemmed tokens: 'Used k8s daily' → ['us', 'kubernete', 'daily']. */
export function canonicalTokens(text) {
  const folded = String(text ?? '').replace(ALIAS_RE, m => ` ${ALIAS_OF.get(m.toLowerCase()) ?? m} `)
  return (folded.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem)
}

// ---- posting structure

const MUST_HEAD = /^(?:(?:minimum|basic|required|key)\s+)?(?:requirements?|qualifications|skills|skills and experience)(?: and qualifications)?$|^what you(?:'|’)?ll need$|^what you need$|^what we(?:'|’)?re looking for$|^who you are$|^you have$|^about you$|^your profile$|^must[- ]haves?$/
const NICE_HEAD = /^(?:nice[- ]to[- ]haves?|preferred(?: qualifications| skills| experience)?|bonus(?: points)?|pluses|good to have|desirable(?: skills)?|extra credit)$/
const OTHER_HEAD = /^(?:about\b.*|(?:key )?responsibilities|what you(?:'|’)?ll do|the role|your role|duties|benefits|perks|compensation|salary|pay|how to apply|why join us|who we are|our stack|location)$/
const NICE_WORDS = /\b(?:preferred|bonus|nice[- ]to[- ]have|a plus|plus|ideally|desirable|good to have|advantageous|optional)\b/i
const MUST_WORDS = /\b(?:must|required|requirement|mandatory|essential)\b/i
const BULLET = /^(?:[-*•·▪◦●]|\d+[.)])\s+(.+)$/
const LABEL = /^(job title|title|position|role|company|employer|organi[sz]ation|location|based in)\s*:\s*(.+)$/i
const SALARY_LINE = /\b(?:salary|compensation|pay|wage|base|ote)\b|\bper (?:year|hour|annum|month)\b|\b(?:a|an) (?:year|hour)\b|\/\s?(?:yr|hr|hour|year)\b|\bp\.a\./i
const CUR = { $: 'USD', '€': 'EUR', '£': 'GBP' }
const MONEY = /(?:([$€£])|\b(USD|EUR|GBP|AUD|CAD|NZD|CHF)\s?)(\d[\d,.]*)\s?([kK])?(?:\s*(?:-|–|—|to)\s*(?:[$€£]|(?:USD|EUR|GBP|AUD|CAD|NZD|CHF)\s?)?(\d[\d,.]*)\s?([kK])?)?/
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const headKey = line => line.replace(/^#+\s*/, '').replace(/^\*\*(.*)\*\*$/, '$1').replace(/[:：]\s*$/, '').trim().toLowerCase()
const headingOf = line => {
  const h = headKey(line)
  if (!h || h.length > 60) return null
  return MUST_HEAD.test(h) ? 'must' : NICE_HEAD.test(h) ? 'nice' : OTHER_HEAD.test(h) ? 'other' : null
}

function amount(digits, k) {
  let d = digits.replace(/[.,]$/, '')
  d = /[.,]\d{3}(?!\d)/.test(d) ? d.replace(/[.,]/g, '') : d.replace(/,/g, '')
  const n = parseFloat(d)
  return Number.isFinite(n) ? n * (k ? 1000 : 1) : null
}

function salaryOf(line) {
  const m = line.match(MONEY)
  if (!m) return undefined
  const min = amount(m[3], m[4] || m[6])
  const max = m[5] ? amount(m[5], m[6]) : min
  if (min == null || max == null) return undefined
  const rest = line.slice(m.index)
  const period = /\b(?:hour|hr|hourly)\b|\/\s?h\b/i.test(rest) ? 'hour' : /\bmonth/i.test(rest) ? 'month'
    : /\b(?:year|yr|annum|annual|annually)\b|p\.a\./i.test(rest) ? 'year' : max < 1000 ? 'hour' : 'year'
  return { text: m[0].trim(), min, max, currency: m[2] ?? CUR[m[1]], period }
}

const iso = d => d.toISOString().slice(0, 10)

function dateOf(line, now) {
  let m = line.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const utc = (y, mo, d) => iso(new Date(Date.UTC(y, mo, d)))
  m = line.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/)
  if (m && MONTHS.includes(m[1].slice(0, 3).toLowerCase())) return utc(+m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()), +m[2])
  m = line.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/)
  if (m && MONTHS.includes(m[2].slice(0, 3).toLowerCase())) return utc(+m[3], MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()), +m[1])
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  if (/\btoday\b|\bjust now\b|\bhours? ago\b/i.test(line)) return iso(new Date(today))
  if (/\byesterday\b/i.test(line)) return iso(new Date(today - 864e5))
  m = line.match(/\b(\d+|an?|one)\+?\s+(day|week|month)s?\s+ago\b/i)
  if (!m) return undefined
  const n = /^\d/.test(m[1]) ? +m[1] : 1
  return iso(new Date(today - n * { day: 1, week: 7, month: 30 }[m[2].toLowerCase()] * 864e5))
}

const isTitleLike = l => /[A-Za-z]/.test(l) && l.length <= 80 && l.split(/\s+/).length <= 12 && !/[.!?]$/.test(l)
const isLocationLike = l => l.length <= 60 && (/\b(?:remote|hybrid|on[- ]?site)\b/i.test(l) || /^[A-Z][A-Za-z.' -]+,\s*[A-Z][A-Za-z]+/.test(l))

/**
 * `{ title, company, location, requirements: [{ text, kind, keywords }], keywords, salary?, postedAt?, signals }`.
 * `now` resolves relative dates ("3 days ago").
 */
export function parseJob(text, { now = new Date() } = {}) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n')
  const lines = src.split('\n').map(l => l.trim())
  const out = { title: '', company: '', location: '', requirements: [], keywords: [], salary: undefined, postedAt: undefined, signals: {} }
  const loose = [] // bullets outside any heading, used when there is no Requirements section
  const rest = []
  let mode = null, underPay = false
  for (const line of lines) {
    if (!line) continue
    const head = headingOf(line)
    if (head) { mode = head; underPay = /^(?:compensation|salary|pay)$/.test(headKey(line)); continue }
    const label = line.match(LABEL)
    if (label) {
      const key = label[1].toLowerCase()
      const field = /title|position|role/.test(key) ? 'title' : /location|based/.test(key) ? 'location' : 'company'
      out[field] ||= label[2].trim()
      continue
    }
    if (!out.salary && (underPay || SALARY_LINE.test(line))) out.salary = salaryOf(line)
    if (!out.postedAt && /\b(?:posted|published|posting date|listed)\b/i.test(line)) out.postedAt = dateOf(line, now)
    const bullet = line.match(BULLET)
    if (!bullet && /^[\w ]{2,30}:\s+\S/.test(line)) mode = 'other' // "Salary: …" ends a requirements list
    const item = (bullet ? bullet[1] : line).trim()
    if (mode === 'must' || mode === 'nice') {
      out.requirements.push({ text: item, kind: NICE_WORDS.test(item) ? 'nice' : MUST_WORDS.test(item) ? 'must' : mode })
    } else {
      rest.push(line)
      if (mode === null && bullet) loose.push(item)
    }
  }
  if (!out.requirements.length) {
    const worded = loose.filter(t => NICE_WORDS.test(t) || MUST_WORDS.test(t))
    out.requirements = (worded.length ? worded : loose).map(t => ({ text: t, kind: NICE_WORDS.test(t) ? 'nice' : 'must' }))
  }
  for (const r of out.requirements) r.keywords = keywordsIn(r.text)
  out.keywords = [...new Set([...out.requirements.flatMap(r => r.keywords), ...keywordsIn(rest.join('\n'), { vocabOnly: true })])]

  const top = lines.filter(l => l && !headingOf(l) && !LABEL.test(l) && !BULLET.test(l))
  if (!out.title) {
    const first = top.find(isTitleLike) ?? ''
    const at = first.match(/^(.+?)\s+(?:at|@)\s+(.+)$/)
    out.title = at ? at[1] : first
    if (at) out.company ||= at[2]
  }
  if (!out.company) {
    const about = lines.map(l => l.replace(/^#+\s*/, '').match(/^about\s+(?!the\b|us\b|you\b|this\b|our\b)([A-Z][\w&.' -]{1,40})$/)).find(Boolean)
    const is = src.match(/^([A-Z][\w&.' -]{1,40}?) is (?:hiring|looking|seeking)\b/m)
    out.company = (about?.[1] ?? is?.[1] ?? '').trim()
  }
  if (!out.location) out.location = top.slice(0, 8).find(l => l !== out.title && isLocationLike(l)) ?? ''
  // "Acme Robotics · Remote (US)" under the title: company first, location after the separator
  const split = out.location.split(/\s+[·|•–—-]\s+/)
  if (!out.company && split.length > 1 && !isLocationLike(split[0])) {
    out.company = split[0].trim()
    out.location = split.slice(1).join(' · ').trim()
  }
  const words = src.split(/\s+/).filter(Boolean).length
  out.signals = { emails: [...new Set(src.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? [])], words }
  if (!out.salary) delete out.salary
  if (!out.postedAt) delete out.postedAt
  return out
}

