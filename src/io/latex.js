// LaTeX export (spec 6 "pdf, text, latex", 8 T57): the parsed document model → a self-contained,
// ATS-friendly single-column article. Pure module; never throws on foreign input.
// Only packages every TeX distribution ships: geometry (margins), hyperref (links), enumitem (bullet spacing).
import { normalizeLayout, placeSections } from '../model/layout.js'

const ESCAPES = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '$': '\\$',
  '&': '\\&',
  '#': '\\#',
  '^': '\\textasciicircum{}',
  '_': '\\_',
  '%': '\\%',
  '~': '\\textasciitilde{}',
}
// A single-pass replace (not sequential .replace calls) so an escape's own backslash never gets re-escaped.
const escLatex = s => String(s ?? '').replace(/[\\{}$&#^_%~]/g, c => ESCAPES[c])

// hyperref parses \href's URL argument with its own catcodes (like url.sty), so # % & _ ~ ^ are literal
// there; only a backslash or brace would break the macro argument, so that's all this guards.
const escUrl = s => String(s ?? '').replace(/[\\{}]/g, c => ({ '\\': '\\\\', '{': '\\{', '}': '\\}' }[c]))

const ALLOWED_SCHEME = /^(https?|mailto|tel):/i

function inlineLatex(nodes) {
  return (nodes ?? []).map(n => {
    if (n.t === 'text') return escLatex(n.v)
    if (n.t === 'br') return '\\\\\n'
    if (n.t === 'code') return `\\texttt{${escLatex(n.v)}}`
    if (n.t === 'strong') return `\\textbf{${inlineLatex(n.c)}}`
    if (n.t === 'em') return `\\emph{${inlineLatex(n.c)}}`
    if (n.t === 'link' && ALLOWED_SCHEME.test(n.href ?? '')) return `\\href{${escUrl(n.href)}}{${inlineLatex(n.c)}}`
    return n.c ? inlineLatex(n.c) : ''
  }).join('')
}

function contactLatex(c) {
  const text = escLatex(c.label ? `${c.label}: ${c.text}` : c.text)
  return c.href && ALLOWED_SCHEME.test(c.href) ? `\\href{${escUrl(c.href)}}{${text}}` : text
}

function headerLatex(header, fallbackName) {
  const name = header?.name || fallbackName || ''
  if (!name && !header) return ''
  const lines = [`{\\LARGE\\bfseries ${escLatex(name)}}\\\\[4pt]`]
  for (const tag of header?.taglines ?? []) lines.push(`${inlineLatex(tag.inlines)}\\\\`)
  const contacts = (header?.contacts ?? []).map(contactLatex).filter(Boolean)
  if (contacts.length) lines.push(contacts.join(header.contactSep ?? ' \\textbar\\ ') + '\\\\')
  return lines.join('\n')
}

function itemizeLatex(items) {
  const body = (items ?? []).map(i => `  \\item ${inlineLatex(i.inlines)}`).join('\n')
  return `\\begin{itemize}[leftmargin=*, itemsep=1pt, topsep=2pt]\n${body}\n\\end{itemize}`
}

function entryLatex(e) {
  const title = inlineLatex(e.title), org = inlineLatex(e.org)
  const head = [title, org].filter(Boolean).join(', ')
  const right = [e.date, e.location].filter(Boolean).map(escLatex).join(' \\textbar\\ ')
  const first = (right ? `\\textbf{${head}} \\hfill ${right}` : `\\textbf{${head}}`) + '\\\\'
  const body = (e.blocks ?? []).map(blockLatex).filter(Boolean).join('\n')
  return [first, body].filter(Boolean).join('\n')
}

function blockLatex(b) {
  if (b.type === 'rule') return '\\noindent\\hrulefill\\par'
  if (b.type === 'paragraph') return inlineLatex(b.inlines) + '\\par'
  if (b.type === 'list') return itemizeLatex(b.items)
  if (b.type === 'entry') return entryLatex(b)
  return ''
}

function sectionLatex(s) {
  const body = (s.blocks ?? []).map(blockLatex).filter(Boolean).join('\n')
  return [`\\section*{${escLatex(s.title)}}`, body].filter(Boolean).join('\n')
}

const PREAMBLE = `\\documentclass[11pt]{article}
\\usepackage[margin=2cm]{geometry}
\\usepackage{hyperref}
\\usepackage{enumitem}
\\hypersetup{colorlinks=true, urlcolor=blue, linkcolor=blue}
\\pagestyle{empty}
\\setlength{\\parindent}{0pt}
\\begin{document}
`

// Visible sections in the layout's column reading order (single-column output, like the .txt export).
function orderedSections(doc, layout) {
  const l = normalizeLayout(layout)
  const placed = placeSections({ sections: doc?.sections ?? [] }, l)
  return l.grid.readingOrder.flatMap(id => placed[id] ?? []).map(p => p.section)
}

/** doc (from src/model/markdown.js parse) + layout → a self-contained .tex string. Hidden sections are
 *  skipped. `name` is a fallback title used only when the document has no `# Name` header line. */
export function toLatex(doc, layout, { name } = {}) {
  const parts = [headerLatex(doc?.header, name), ...orderedSections(doc, layout).map(sectionLatex)].filter(Boolean)
  return PREAMBLE + parts.join('\n\n') + '\n\n\\end{document}\n'
}
