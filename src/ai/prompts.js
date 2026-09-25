// Prompt builders and JSON schemas per AI feature (assist spec §6). Pure.

export const NO_FABRICATION = 'Only rephrase, reorder, cut or emphasise facts already present in the CV. Never add employers, titles, dates, degrees, metrics, tools or achievements that are not in the CV. If a suggestion needs a fact the CV lacks, ask for it in `needsInput` instead of inventing it.'

export const GRAMMAR = `Recto Markdown (strict, one meaning per line):
- "# Name" is the first line; lines after it and before the first "##" are header lines (tagline, or contacts separated by " · ").
- "## Title" starts a section ("##" alone is an untitled section).
- "### Title | Org | Date | Location" is an entry; fields are split on "|" and keep their order and count.
- "- text" is a bullet; a line indented 2+ spaces right after a bullet continues it.
- "---" is a rule; any other line is paragraph text.
- Inline: **bold**, *italic*, [text](https://link); escape literal * _ [ ] ( ) | # with a backslash.`

const CATEGORIES = ['impact', 'clarity', 'keyword', 'concision', 'grammar', 'structure']

const INSTRUCTIONS = {
  stronger: 'Make them stronger: lead with an action verb and show impact.',
  shorter: 'Make them shorter without losing facts.',
  quantify: 'Quantify them using only numbers already in the CV; if a number is missing, ask for it in needsInput.',
  grammar: 'Fix grammar, spelling and punctuation only.',
  formal: 'Make them more formal.',
}

const str = { type: 'string' }
const strings = { type: 'array', items: str }
const obj = (title, properties, required = Object.keys(properties)) => ({ ...(title ? { title } : {}), type: 'object', properties, required })

const SUGGESTION = obj(null, {
  line: { type: 'integer' },
  expect: str,
  replacement: str,
  reason: str,
  category: { type: 'string', enum: CATEGORIES },
  needsInput: str,
}, ['line', 'expect', 'replacement', 'reason', 'category'])

const SUGGESTIONS = obj('suggestions', { suggestions: { type: 'array', items: SUGGESTION } })
const TAILOR = obj('tailor', { suggestions: { type: 'array', items: SUGGESTION }, keywordsAdded: strings, summary: str })
const EVALUATION = obj('evaluation', {
  score: { type: 'integer', minimum: 1, maximum: 5 },
  recommendation: { type: 'string', enum: ['apply', 'consider', 'skip'] },
  summary: str,
  requirements: {
    type: 'array',
    items: obj(null, { text: str, weight: { type: 'number' }, evidence: str, verdict: { type: 'string', enum: ['met', 'partial', 'missing'] } }),
  },
  gaps: strings,
  levelFit: str,
  legitimacy: obj(null, { level: { type: 'string', enum: ['ok', 'caution', 'red-flag'] }, notes: str }),
  pitch: str,
})
const COVER_LETTER = obj('cover_letter', { subject: str, paragraphs: strings }, ['paragraphs'])
const JOB = obj('job', {
  title: str,
  company: str,
  location: str,
  requirements: { type: 'array', items: obj(null, { text: str, kind: { type: 'string', enum: ['must', 'nice'] }, keywords: strings }) },
  keywords: strings,
  salary: str,
  postedAt: str,
}, ['title', 'company', 'location', 'requirements', 'keywords'])

/** Source with 1-based line numbers, e.g. "12│ - Led …", so replies can cite `line` and `expect` exactly. */
export const numberSource = source => String(source ?? '').split('\n').map((l, i) => `${i + 1}│ ${l}`).join('\n')

const SYSTEM = `You are a careful CV editor for Recto, a text-first CV builder.
${GRAMMAR}

Rule: ${NO_FABRICATION}

Suggestions: "line" is the line number, "expect" is that line's exact current text (without the number prefix), "replacement" is the full new line of the same kind (a bullet stays a bullet, an entry keeps its fields). Reply with JSON only, matching the schema.`

const cvBlock = source => `CV (line numbers are not part of the text):\n${numberSource(source)}`
const jobBlock = job => `Job posting:\nTitle: ${job?.title ?? ''}\nCompany: ${job?.company ?? ''}\n${job?.text ?? ''}`
const build = (json, ...parts) => ({ system: SYSTEM, messages: [{ role: 'user', content: parts.join('\n\n') }], json })

export const suggestPrompt = ({ source }) =>
  build(SUGGESTIONS, 'Suggest improvements to this CV: impact, clarity, concision, grammar and structure.', cvBlock(source))

export function rewritePrompt ({ source, lines, instruction }) {
  const how = INSTRUCTIONS[instruction] ?? `Instruction: ${instruction}`
  return build(SUGGESTIONS, `Rewrite lines ${lines.join(', ')} only. ${how}`, cvBlock(source))
}

export const tailorPrompt = ({ source, job }) =>
  build(TAILOR, 'Tailor this CV to the job: emphasise matching facts and use the posting\'s wording for skills the CV already shows. List keywords you worked in as keywordsAdded and summarise the changes.', cvBlock(source), jobBlock(job))

export const evaluatePrompt = ({ source, job }) =>
  build(EVALUATION, 'Evaluate how well this CV fits the job: score 1–5, a recommendation, each requirement with evidence from the CV (cite line numbers) and a verdict, gaps, level fit, posting legitimacy and a short pitch.', cvBlock(source), jobBlock(job))

export const coverLetterPrompt = ({ source, job }) =>
  build(COVER_LETTER, 'Write a concise cover letter for this job (3–5 plain-text paragraphs, no markup, no address block).', cvBlock(source), jobBlock(job))

export const extractJobPrompt = ({ text }) => ({
  system: 'You extract structured fields from job postings. Use only what the posting says; leave unknown fields empty. Reply with JSON only, matching the schema.',
  messages: [{ role: 'user', content: `Job posting:\n${text}` }],
  json: JOB,
})
