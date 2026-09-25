// Job links → job text (assist spec 3): ATS public APIs → local proxy (serve.js) → webFetch callback → paste.
import { extractHtml } from '../io/extract.js'

const GH_BOARDS = /^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/

/** Known ATS posting URL → `{ source, apiUrl, id }`, else null. */
export function parseAtsUrl(url) {
  let u
  try { u = new URL(url) } catch { return null }
  if (!/^https?:$/.test(u.protocol)) return null
  const host = u.hostname.toLowerCase()
  const [a, b] = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const q = k => u.searchParams.get(k)
  const gh = (board, id) => board && /^\d+$/.test(id ?? '')
    ? { source: 'greenhouse', apiUrl: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${id}`, id }
    : null
  if (GH_BOARDS.test(host)) {
    if (a === 'embed') return gh(q('for'), q('token'))
    return u.pathname.split('/')[2] === 'jobs' ? gh(a, u.pathname.split('/')[3]) : gh(a, q('gh_jid'))
  }
  // Company career pages embedding Greenhouse: the board is usually the site's name
  if (q('gh_jid')) return gh(q('for') ?? host.replace(/^www\./, '').split('.')[0], q('gh_jid'))
  const lever = host.match(/^jobs\.((?:eu\.)?)lever\.co$/)
  if (lever && a && b) return { source: 'lever', apiUrl: `https://api.${lever[1]}lever.co/v0/postings/${encodeURIComponent(a)}/${encodeURIComponent(b)}`, id: b }
  if (host === 'jobs.ashbyhq.com' && a && b) return { source: 'ashby', apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(a)}`, id: b }
  return null
}

const htmlText = html => extractHtml(String(html ?? '')).text
const day = v => {
  const d = new Date(v)
  return v != null && !isNaN(d) ? d.toISOString().slice(0, 10) : undefined
}
const slugOf = apiUrl => decodeURIComponent(apiUrl.match(/(?:boards|postings|job-board)\/([^/]+)/)[1])

const FROM_ATS = {
  greenhouse(data, ats) {
    // The API returns the description HTML entity-escaped
    const html = /&lt;/.test(data.content ?? '') ? htmlText(data.content) : data.content
    return { title: data.title, company: data.company_name || slugOf(ats.apiUrl), location: data.location?.name,
      postedAt: day(data.first_published ?? data.updated_at), text: htmlText(html) }
  },
  lever: (data, ats) => ({
    title: data.text, company: slugOf(ats.apiUrl), location: data.categories?.location, postedAt: day(data.createdAt),
    text: [data.descriptionPlain, ...(data.lists ?? []).map(l => `${l.text}\n${htmlText(l.content)}`), data.additionalPlain]
      .filter(Boolean).join('\n\n')
  }),
  ashby(data, ats) {
    const job = (data.jobs ?? []).find(j => j.id === ats.id)
    if (!job) return null
    return { title: job.title, company: slugOf(ats.apiUrl), location: job.location, postedAt: day(job.publishedAt),
      text: job.descriptionPlain || htmlText(job.descriptionHtml) }
  }
}

const needsPaste = () => Object.assign(new Error('needs-paste'), { code: 'needs-paste' })

// Any failure moves on to the next strategy, except the user cancelling
async function attempt(fn, signal) {
  try {
    return await fn()
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') throw err
    return null
  }
}

async function getJson(fetch, url, signal) {
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/**
 * `{ url, source, title, company, location, text, postedAt? }`; rejects with `{ code: 'needs-paste' }` when nothing works.
 * `proxyBase`: origin of serve.js (local mode). `webFetch(url) → text` e.g. Anthropic's web_fetch tool.
 */
export async function fetchJob(url, { fetch = globalThis.fetch, proxyBase, webFetch, signal } = {}) {
  let href
  try { href = new URL(url).href } catch { throw needsPaste() }
  if (!/^https?:/.test(href)) throw needsPaste()
  const job = (source, fields) => {
    const out = { url, source, title: fields.title ?? '', company: fields.company ?? '', location: fields.location ?? '', text: fields.text ?? '' }
    if (fields.postedAt) out.postedAt = fields.postedAt
    return out
  }

  const ats = parseAtsUrl(href)
  if (ats) {
    const fields = await attempt(async () => FROM_ATS[ats.source](await getJson(fetch, ats.apiUrl, signal), ats), signal)
    if (fields?.text) return job(ats.source, fields)
  }
  if (proxyBase) {
    const data = await attempt(() => getJson(fetch, `${proxyBase}/api/fetch?url=${encodeURIComponent(href)}`, signal), signal)
    if (data?.text) return job('url', { text: data.text })
  }
  if (webFetch) {
    const got = await attempt(() => webFetch(href), signal)
    const text = typeof got === 'string' ? got : got?.text
    if (text) return job('url', { text })
  }
  throw needsPaste()
}
