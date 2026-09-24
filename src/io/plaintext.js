// Paste-text import (spec 6.5): text copied from an existing CV → Recto Markdown the user then tidies.
// Pure module. Entry lines (### title | org | date | location) are left for the user to write.
import { detectContact } from '../model/markdown.js'
import { categorize } from '../model/categories.js'
import { DEFAULT_CONTACT_SEP } from '../model/separators.js'
import { escText, escLine, guardLine } from './jsonresume.js'

const PART_SEP = /\s+[|·•●▪○■–]\s+|\t+|\s{2,}/ // how pasted contact lines separate their parts
const BULLET = /^(?:[•▪●○■·]\s*|[–*-]\s+)/

const isHeading = (line, lang) => !!categorize(line, lang) || // categorize ignores case and a trailing ':'
  (/\p{L}/u.test(line) && line === line.toUpperCase() && line.split(/\s+/).length <= 4)

// A line whose parts include a contact, with its separators normalized; null otherwise.
function contactLine(line) {
  const parts = line.split(PART_SEP)
  return parts.some(p => detectContact(p, 0).kind !== 'text') ? guardLine(parts.map(escText).join(DEFAULT_CONTACT_SEP)) : null
}

export function fromPlainText(text, lang = 'en') {
  const out = []
  let seen = -1, header = true // seen: non-empty lines after the name; header: no heading yet
  for (const raw of String(text ?? '').split(/\r\n?|\n/)) {
    const line = raw.trim() // also drops a BOM
    if (!line) {
      if (out.length && out.at(-1) !== '') out.push('')
      continue
    }
    seen++
    const contact = header && seen >= 1 && seen <= 5 ? contactLine(line) : null
    if (seen === 0) out.push('# ' + escLine(line))
    else if (contact) out.push(contact)
    else if (BULLET.test(line)) {
      const item = escText(line.replace(BULLET, ''))
      if (item) out.push('- ' + item) // a lone bullet glyph line is dropped
    } else if (isHeading(line, lang)) {
      header = false
      out.push('## ' + escText(line.replace(/\s*:$/, '')))
    } else out.push(escLine(line))
  }
  if (out.at(-1) === '') out.pop()
  return out.length ? out.join('\n') + '\n' : ''
}
