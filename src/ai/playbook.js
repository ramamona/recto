// Loads the agent playbook (agent/*.md) that prompts.js puts in each system prompt.
// `read(path)` returns the file text for a path relative to the app root.

const FILES = {
  core: 'agent/recto.md',
  writing: 'agent/writing.md',
  grammar: 'agent/grammar.md',
}
const MODES = {
  review: 'review', rewrite: 'rewrite', tailor: 'tailor', evaluate: 'evaluate', coverLetter: 'cover-letter', extractJob: 'extract-job', answer: 'answer',
}

async function defaultRead (path) {
  const url = new URL('../../' + path, import.meta.url)
  if (url.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises')
    return readFile(url, 'utf8')
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.text()
}

async function load (read) {
  const text = async p => String(await read(p)).trim()
  const [core, writing, grammar, ...modes] = await Promise.all([
    ...Object.values(FILES).map(text),
    ...Object.values(MODES).map(m => text(`agent/modes/${m}.md`)),
  ])
  return { core, writing, grammar, modes: Object.fromEntries(Object.keys(MODES).map((k, i) => [k, modes[i]])) }
}

let cached
/** Cached for the default reader; an injected `read` loads fresh. Rejects when any file is missing. */
export function loadPlaybook ({ read } = {}) {
  if (read) return load(read)
  cached ??= load(defaultRead).catch(e => { cached = undefined; throw e })
  return cached
}
