// LinkedIn application import (optional). LinkedIn has no public API for a member's applications, so the user downloads
// their own data archive and uploads the "Job Applications" CSV. Pure: CSV text in, tracker jobs out (status 'applied').

export const LINKEDIN_SOURCE = 'linkedin'

/** RFC 4180-ish CSV: quoted fields, "" escapes, newlines inside quotes, CRLF or LF. Blank rows are dropped. */
export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '')
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c !== '"') field += c
      else if (s[i + 1] === '"') { field += '"'; i++ }
      else quoted = false
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(c => c.trim()))
}

const norm = s => String(s ?? '').trim().toLowerCase()

/** True when the first row has the columns LinkedIn's applications export uses. */
export function isLinkedInApplications(text) {
  const head = (parseCsv(text)[0] ?? []).map(norm)
  return head.includes('company name') && head.includes('job title')
}

/** Applications → tracker-ready jobs. Stable ids (link, else company|title|date) make a re-import a duplicate, not a copy. */
export function linkedinApplications(text, { now = () => new Date() } = {}) {
  const [head = [], ...rows] = parseCsv(text)
  const col = name => head.findIndex(h => norm(h) === name)
  const [date, company, title, url] = ['application date', 'company name', 'job title', 'job url'].map(col)
  if (company < 0 || title < 0) return []
  const get = (r, i) => i < 0 ? '' : (r[i] ?? '').trim()
  return rows.flatMap(r => {
    const co = get(r, company)
    const ti = get(r, title)
    if (!co && !ti) return []
    const link = /^https?:\/\//i.test(get(r, url)) ? get(r, url) : ''
    const parsed = Date.parse(get(r, date))
    const at = Number.isFinite(parsed) ? new Date(parsed).toISOString() : now().toISOString()
    return [{
      id: `${LINKEDIN_SOURCE}:${link || `${co}|${ti}|${at}`}`,
      source: LINKEDIN_SOURCE,
      status: 'applied',
      title: ti, company: co, url: link, text: '',
      createdAt: at, updatedAt: at
    }]
  })
}
