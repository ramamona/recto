// Source edits made by the app (spec 5.2): line fixes, section moves, entry-field rewrites. Pure.
import { splitEntryFields, joinEntryFields } from './markdown.js'

/** Replace/delete whole 1-based lines, bottom-up; all-or-nothing when any `expect` no longer matches. */
export function applyContentEdits(content, edits) {
  const lines = content.split('\n')
  if (edits.some(e => lines[e.line - 1] !== e.expect)) return { content, stale: true }
  for (const e of [...edits].sort((a, b) => b.line - a.line)) {
    if (e.text === null) lines.splice(e.line - 1, 1)
    else lines[e.line - 1] = e.text
  }
  return { content: lines.join('\n'), stale: false }
}

const blank = s => !s.trim()
function trim(part, start, end) {
  let a = 0, b = part.length
  if (start) while (a < b && blank(part[a])) a++
  if (end) while (b > a && blank(part[b - 1])) b--
  return part.slice(a, b)
}

/**
 * Move a section's lines (line..endLine) before `beforeSectionId`, after `afterSectionId`, or to EOF.
 * Exactly one blank line separates the moved block from its neighbours. Unknown ids → content unchanged.
 */
export function moveSectionSource(content, doc, id, beforeSectionId, afterSectionId) {
  const find = sid => doc.sections.find(s => s.id === sid)
  const sec = find(id)
  const before = beforeSectionId == null ? null : find(beforeSectionId)
  const after = afterSectionId == null ? null : find(afterSectionId)
  if (!sec || before === undefined || after === undefined || before === sec || after === sec) return content
  const nl = content.endsWith('\n')
  const lines = (nl ? content.slice(0, -1) : content).split('\n')
  const s = sec.line - 1, e = sec.endLine
  const t = before ? before.line - 1 : after ? after.endLine : lines.length
  const block = trim(lines.slice(s, e), true, true)
  const parts = t <= s
    ? [lines.slice(0, t), block, lines.slice(t, s), lines.slice(e)]
    : [lines.slice(0, s), lines.slice(e, t), block, lines.slice(t)]
  const out = parts.map((p, i) => trim(p, i > 0, i < parts.length - 1)).filter(p => p.length)
  return out.map(p => p.join('\n')).join('\n\n') + (nl ? '\n' : '')
}

/** Rewrite field `index` (0 title, 1 org, 2 date, 3 location) of a `###` line; other fields keep their text. */
export function setEntryField(line, index, value) {
  if (!/^###(\s|$)/.test(line)) return line
  const fields = splitEntryFields(line.slice(3))
  while (fields.length <= index) fields.push('')
  fields[index] = value
  return joinEntryFields(fields)
}
