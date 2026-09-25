// Source editor (spec 5.3 Left): a transparent <textarea> over a highlighted, aria-hidden <pre> in one scroll
// container (so they can never drift), line gutter with issue markers, caret hint, Insert menu, syntax popover.
import { classifyLine, ENTRY_FIELDS } from '../model/markdown.js'
import { HEADER_SEPARATORS } from '../model/separators.js'
import { h, on, uid } from './dom.js'

// ---------- pure: line analysis, tokens, hints, snippets ----------

/** Per line: { kind, region } where region is 'pre' | 'name' | 'header' | 'body' (spec 3.2 regions). */
export function analyzeLines(lines) {
  let region = 'pre', prev = 'blank'
  return lines.map(line => {
    let kind = classifyLine(line, prev)
    prev = kind
    if (kind === 'section') region = 'body'
    else if (kind === 'name' && region === 'pre') { region = 'header'; return { kind, region: 'name' } }
    else if (kind === 'name') kind = 'text' // later '# ' lines are plain text (+ diagnostic)
    return { kind, region }
  })
}

// Highlighting only: approximate inline markup (the parser stays the authority).
const INLINE = /(\\[*_[\]()|#\\`])|(`[^`]+`)|(\*\*[^*\s](?:[^*]*[^*\s])?\*\*)|(\*[^*\s](?:[^*]*[^*\s])?\*|(?<![\p{L}\p{N}])_[^_\s](?:[^_]*[^_\s])?_(?![\p{L}\p{N}]))|(\[[^\]]*\]\([^)\s]*\))|(https?:\/\/[^\s<>]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/gu
const INLINE_CLS = [null, 'ed-esc', 'ed-code', 'ed-strong', 'ed-em', 'ed-link', 'ed-link']
const SEP_SPLIT = new RegExp(`(${HEADER_SEPARATORS.map(s => s.replace(/[|.*+?^${}()[\]\\]/g, '\\$&')).join('|')})`)
const cls = (...c) => c.filter(Boolean).join(' ') || null

function inline(s, base = null) {
  const out = []
  let at = 0
  for (const m of s.matchAll(INLINE)) {
    if (m.index > at) out.push([base, s.slice(at, m.index)])
    out.push([cls(base, INLINE_CLS[m.findIndex((v, i) => i && v !== undefined)]), m[0]])
    at = m.index + m[0].length
  }
  if (at < s.length) out.push([base, s.slice(at)])
  return out
}

function entryTokens(line) {
  const mark = /^###/.exec(line)[0]
  const out = [['ed-mark', mark]]
  let field = 0, buf = ''
  const flush = () => {
    const c = 'ed-f' + Math.min(field, 3)
    if (buf) out.push(...(field < 2 ? inline(buf, c) : [[c, buf]])) // title/org carry inline markup
    buf = ''
  }
  for (let i = mark.length; i < line.length; i++) {
    if (line[i] === '\\' && i + 1 < line.length) buf += line[i] + line[++i]
    else if (line[i] === '|') { flush(); out.push(['ed-pipe', '|']); field++ } else buf += line[i]
  }
  flush()
  return out
}

/** Tokens [className|null, text] whose texts concatenate to exactly `line`. */
export function tokenizeLine(line, { kind, region }) {
  if (kind === 'blank') return line ? [[null, line]] : []
  if (region === 'pre') return [['ed-ignored', line]]
  if (kind === 'rule') return [['ed-rule', line]]
  if (region === 'name') {
    const m = /^#\s*/.exec(line)[0]
    return [['ed-mark', m], ...inline(line.slice(m.length), 'ed-name')]
  }
  if (region === 'header') return line.split(SEP_SPLIT).flatMap((p, i) => i % 2 ? [['ed-sep', p]] : inline(p, 'ed-header'))
  if (kind === 'section') {
    const m = /^##\s*/.exec(line)[0]
    const rest = line.slice(m.length)
    const id = /\s*\{#[a-z0-9-]+\}\s*$/.exec(rest)
    const title = id ? rest.slice(0, id.index) : rest
    return [['ed-mark', m], ...inline(title, 'ed-section'), ...(id ? [['ed-id', id[0]]] : [])]
  }
  if (kind === 'entry') return entryTokens(line)
  if (kind === 'bullet') {
    const m = /^\s*[-*•] /.exec(line)[0]
    return [['ed-bullet', m], ...inline(line.slice(m.length))]
  }
  return inline(line)
}

const unescapedPipes = s => (s.replace(/\\./g, '').match(/\|/g) ?? []).length

/** Caret-context hint for one line; `isContact` = the parser read this header line as a contact line. */
export function caretHint(text, col, { kind, region }, t, isContact = false) {
  if (kind === 'blank') return t('editor.hint.blank')
  if (region === 'pre') return t('editor.hint.ignored')
  if (region === 'name') return t('editor.hint.name')
  if (kind === 'rule') return t('editor.hint.rule')
  if (region === 'header') return t(isContact ? 'editor.hint.contact' : 'editor.hint.tagline')
  if (kind === 'section') return t('editor.hint.section')
  if (kind === 'entry') {
    const n = Math.min(unescapedPipes(text.slice(0, col)) + 1, ENTRY_FIELDS.length)
    return t('editor.hint.entry', { n, total: ENTRY_FIELDS.length, field: t('editor.field.' + ENTRY_FIELDS[n - 1]) })
  }
  if (kind === 'bullet' || kind === 'cont') return t('editor.hint.bullet')
  return t('editor.hint.paragraph')
}

// [before, placeholder, after]; block snippets go on their own line, `gap` ones after a blank line.
const SNIPPETS = {
  section: t => ({ gap: true, parts: ['## ', t('editor.ph.section'), ''] }),
  entry: t => ({ parts: ['### ', t('editor.ph.title'), ` | ${t('editor.ph.org')} | ${t('editor.ph.date')} | ${t('editor.ph.city')}`] }),
  bullet: t => ({ parts: ['- ', t('editor.ph.bullet'), ''] }),
  rule: () => ({ parts: ['---', '', ''] }),
  panel: t => ({ gap: true, parts: ['## {#panel}\n', t('editor.ph.panel'), ''] }),
  break: () => ({ inline: true, parts: ['\\\n', '', ''] }),
}
export const SNIPPET_KINDS = Object.keys(SNIPPETS)

/** Where and what to insert for a snippet at caret `pos`: { at, text, selStart, selEnd } (offsets after insertion). */
export function snippetEdit(value, pos, kind, t) {
  const s = SNIPPETS[kind]?.(t)
  if (!s) return null
  let at = pos, lead = ''
  if (!s.inline) {
    const eol = value.indexOf('\n', pos)
    const end = eol < 0 ? value.length : eol
    const start = value.lastIndexOf('\n', end - 1) + 1
    if (value.slice(start, end).trim()) { at = end; lead = s.gap ? '\n\n' : '\n' } else at = start
  }
  const [before, ph, after] = s.parts
  const selStart = at + lead.length + before.length
  return { at, text: lead + before + ph + after, selStart, selEnd: selStart + ph.length }
}

// ---------- syntax reference ----------

const GRAMMAR = [
  ['name', '# Jane Doe'],
  ['header', 'jane@doe.dev · +49 151 0000000 · Berlin'],
  ['section', '## Experience'],
  ['sectionId', '## Experience {#work}'],
  ['untitled', '## {#panel}'],
  ['entry', '### Title | Organisation | Jan 2021 – Present | City'],
  ['dates', 'Jan 2021 – Present · 2019 – 2021 · 03/2020'],
  ['bullet', '- Cut deploy time by 70%'],
  ['cont', '  indented line continues the bullet'],
  ['rule', '---'],
  ['paragraph', 'Plain lines join into one paragraph'],
  ['break', 'A line ending in \\'],
  ['strong', '**bold**'],
  ['em', '*italic* or _italic_'],
  ['code', '`code`'],
  ['link', '[text](https://example.com)'],
  ['escape', '\\* \\_ \\| \\# \\\\'],
]
const DIAG_ROW = {
  'text-before-name': 'name', 'extra-name': 'name', 'header-markup': 'section', 'unclosed-emphasis': 'strong',
  'unsafe-link': 'link', 'entry-extra-fields': 'entry', 'unparseable-date': 'dates',
}
const SEVERITY = ['error', 'warn', 'info']

// Position a popover under its invoker before it opens (align 'start' or 'end' of the button).
function anchor(pop, btn, align) {
  on(pop, 'beforetoggle', e => {
    if (e.newState !== 'open') return
    const r = btn.getBoundingClientRect()
    Object.assign(pop.style, { top: `${r.bottom + 4}px`, left: align === 'start' ? `${r.left}px` : 'auto', right: align === 'end' ? `${innerWidth - r.right}px` : 'auto' })
  })
}

const REWRITES = ['stronger', 'shorter', 'quantify', 'grammar', 'formal']

// ---------- mount ----------

export function mountEditor(root, store, ctx) {
  const { t } = ctx
  const helpId = uid('ed-help'), hintId = uid('ed-hint'), menuId = uid('ed-insert'), syntaxId = uid('ed-syntax'), rewriteId = uid('ed-rewrite')

  const pre = h('pre', { class: 'ed-hl', 'aria-hidden': 'true' })
  const ta = h('textarea', {
    class: 'ed-input', spellcheck: false, autocomplete: 'off', autocapitalize: 'off', 'aria-label': t('editor.label'),
    'aria-describedby': `${hintId} ${helpId}`,
  })
  const scroller = h('div', { class: 'ed-scroll ui-scroll' }, h('div', { class: 'ed-stack' }, pre, ta))

  const menu = h('div', { class: 'ui-menu ed-pop', id: menuId, popover: 'auto', role: 'menu' },
    SNIPPET_KINDS.map(kind => h('button', { class: 'ui-menu__item', type: 'button', role: 'menuitem', onClick: () => { menu.hidePopover(); insert(kind) } }, t('editor.insert.' + kind))))
  const rows = new Map(GRAMMAR.map(([key, example]) => [key, h('tr', {}, h('th', { scope: 'row' }, t('editor.syntax.' + key)), h('td', {}, h('code', {}, example)))]))
  const syntax = h('div', { class: 'ui-menu ed-pop ed-syntax', id: syntaxId, popover: 'auto', role: 'dialog', 'aria-label': t('editor.syntax.title') },
    h('p', { class: 'ui-menu__label' }, t('editor.syntax.title')),
    h('div', { class: 'ui-scroll ed-syntax__body' }, h('table', {}, h('tbody', {}, [...rows.values()]))))
  const insertBtn = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', popovertarget: menuId, 'aria-haspopup': 'menu' }, t('editor.insert'), ' ▾')
  const helpBtn = h('button', { class: 'ui-btn ui-btn--sm ui-btn--icon', type: 'button', popovertarget: syntaxId, title: t('editor.syntax.title'), 'aria-label': t('editor.syntax.title') }, '?')
  // Selection → "✨ Rewrite" chip → instruction → AI diff cards in the Suggest tab (assist spec §7).
  const customInput = h('input', { class: 'ui-input', type: 'text', placeholder: t('editor.rewrite.customPh'), 'aria-label': t('editor.rewrite.custom') })
  const rewriteMenu = h('div', { class: 'ui-menu ed-pop', id: rewriteId, popover: 'auto', role: 'menu' },
    REWRITES.map(id => h('button', { class: 'ui-menu__item', type: 'button', role: 'menuitem', onClick: () => rewrite(id) }, t('editor.rewrite.' + id))),
    h('div', { class: 'ui-menu__sep' }),
    h('form', { class: 'ed-rewrite-custom', onSubmit: e => { e.preventDefault(); if (customInput.value.trim()) rewrite(customInput.value.trim()) } },
      customInput, h('button', { class: 'ui-btn ui-btn--sm', type: 'submit' }, t('editor.rewrite.go'))))
  const rewriteBtn = h('button', { class: 'ui-btn ui-btn--sm ed-rewrite', type: 'button', popovertarget: rewriteId, 'aria-haspopup': 'menu', hidden: true }, t('editor.rewrite'))
  anchor(menu, insertBtn, 'start')
  anchor(rewriteMenu, rewriteBtn, 'start')
  anchor(syntax, helpBtn, 'end')
  on(syntax, 'toggle', e => { if (e.newState === 'closed') for (const r of rows.values()) r.classList.remove('is-hit') })

  const hintCtx = h('span', { class: 'ed-hint__ctx' })
  const hintIssue = h('span', { class: 'ed-hint__issue' })
  const hintPos = h('span', { class: 'ed-hint__pos' })
  root.append(
    h('div', { class: 'ed-bar' }, insertBtn, rewriteBtn, h('span', { class: 'ui-spacer' }), helpBtn),
    scroller,
    h('div', { class: 'ed-hint', id: hintId }, hintCtx, hintIssue, hintPos),
    h('p', { class: 'visually-hidden', id: helpId }, t('editor.tabHelp')),
    menu, syntax, rewriteMenu,
  )

  let lines = [], info = [], lineEls = [], contactLines = new Set(), escaped = false

  // ---- rendering ----
  function render() {
    lines = ta.value.split('\n')
    info = analyzeLines(lines)
    const frag = document.createDocumentFragment()
    lineEls = lines.map((line, i) => {
      const el = h('div', { class: 'ed-ln ed-ln--' + (info[i].region === 'body' ? info[i].kind : info[i].region) },
        h('span', { class: 'ed-num', dataset: { line: i + 1 } }, i + 1),
        tokenizeLine(line, info[i]).map(([c, s]) => c ? h('span', { class: c }, s) : s),
        line ? null : ' ') // an empty line still needs a line box
      frag.append(el)
      return el
    })
    pre.replaceChildren(frag)
    scroller.style.setProperty('--ed-digits', String(lines.length).length)
    paintMarkers()
    updateHint()
  }

  function issuesByLine() {
    const map = new Map()
    for (const issue of store.state.issues ?? []) {
      if (!issue.line) continue
      if (!map.has(issue.line)) map.set(issue.line, [])
      map.get(issue.line).push(issue)
    }
    return map
  }

  function paintMarkers() {
    for (const el of pre.querySelectorAll('.ed-dot')) el.remove()
    for (const [line, list] of issuesByLine()) {
      const num = lineEls[line - 1]?.firstChild
      if (!num) continue
      const sev = SEVERITY.find(s => list.some(i => i.severity === s)) ?? 'info'
      num.append(h('span', { class: `ed-dot is-${sev}`, title: list.map(i => t(i.msg, i.vars)).join('\n'), dataset: { line } }))
    }
    updateHint()
  }

  // ---- caret ----
  const lineStart = n => lines.slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0)
  const caret = () => {
    const before = ta.value.slice(0, ta.selectionStart)
    const line = before.split('\n').length
    return { line, col: ta.selectionStart - before.lastIndexOf('\n') - 1 }
  }

  function updateHint() {
    const { line, col } = caret()
    if (!info[line - 1]) return
    hintCtx.textContent = caretHint(lines[line - 1], col, info[line - 1], t, contactLines.has(line))
    hintPos.textContent = t('editor.pos', { line, col: col + 1 })
    const issue = issuesByLine().get(line)?.[0]
    const code = issue?.rule === 'markup-diagnostic' ? issue.msg.replace(/^diag\./, '') : null
    hintIssue.replaceChildren(...(issue ? [
      h('span', { class: `ed-dot is-${issue.severity}` }),
      h('span', { class: 'ed-hint__msg', title: t(issue.msg, issue.vars) }, t(issue.msg, issue.vars)),
      code ? h('button', { class: 'ed-link-btn', type: 'button', onClick: () => showSyntax(code) }, t('editor.syntax.help')) : null,
    ].filter(Boolean) : []))
  }

  // Lines touched by the selection; a selection ending at column 0 does not include that line.
  function selectedLines() {
    const { selectionStart: a, selectionEnd: b } = ta
    if (a === b || !ta.value.slice(a, b).trim()) return []
    const first = ta.value.slice(0, a).split('\n').length
    const last = ta.value.slice(0, b).split('\n').length - (ta.value[b - 1] === '\n' ? 1 : 0)
    return Array.from({ length: last - first + 1 }, (_, i) => first + i).filter(n => lines[n - 1]?.trim())
  }

  function rewrite(instruction) {
    rewriteMenu.hidePopover()
    const picked = selectedLines()
    if (!picked.length) return
    customInput.value = ''
    if (ctx.runAssist) ctx.runAssist(assist => assist.rewrite(picked, instruction))
    else ctx.toast?.(t('app.unavailable'))
  }

  function onCaret() {
    updateHint()
    if (document.activeElement === ta) rewriteBtn.hidden = !selectedLines().length
    const { line } = caret()
    if (line !== store.state.caretLine) store.setCaretLine(line)
    if (document.activeElement !== ta) return
    const section = store.state.doc?.sections.findLast(s => s.line <= line)
    const sel = store.state.selection
    if (section && !(sel?.kind === 'section' && sel.id === section.id)) store.select({ kind: 'section', id: section.id })
  }

  // ---- editing ----
  function insertText(text) {
    if (!document.execCommand('insertText', false, text)) { // keeps native undo where supported
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  function insert(kind) {
    const e = snippetEdit(ta.value, ta.selectionEnd, kind, t)
    if (!e) return
    ta.focus({ preventScroll: true })
    ta.setSelectionRange(e.at, e.at)
    insertText(e.text)
    ta.setSelectionRange(e.selStart, e.selEnd)
    onCaret()
  }

  // External change (undo, fix, move, doc switch): replace the value, keep the caret on the same line.
  function replaceValue(content) {
    const { line, col } = caret()
    ta.value = content
    const ls = ta.value.split('\n')
    const n = Math.min(line, ls.length)
    const pos = ls.slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0) + Math.min(col, ls[n - 1].length)
    ta.setSelectionRange(pos, pos)
  }

  function revealLine(line) {
    const el = lineEls[line - 1]
    if (!el) return
    const start = lineStart(line)
    ta.setSelectionRange(start, start + lines[line - 1].length)
    scroller.scrollTop = el.offsetTop - scroller.clientHeight / 3
    el.classList.remove('is-revealed')
    void el.offsetWidth // restart the flash animation
    el.classList.add('is-revealed')
    onCaret()
  }

  function showSyntax(code) {
    if (!syntax.matches(':popover-open')) syntax.showPopover()
    const row = rows.get(DIAG_ROW[code])
    for (const r of rows.values()) r.classList.toggle('is-hit', r === row)
    row?.scrollIntoView({ block: 'nearest' })
  }

  // ---- events ----
  on(ta, 'input', () => store.setContent(ta.value))
  on(ta, 'keydown', e => {
    if (e.key === 'Escape') { escaped = true; return }
    if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (escaped) { escaped = false; return } // Esc then Tab leaves the editor
      e.preventDefault()
      insertText('  ')
    }
    if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) escaped = false
  })
  for (const type of ['keyup', 'mouseup', 'focus', 'select']) on(ta, type, onCaret)
  on(document, 'selectionchange', () => { if (document.activeElement === ta) onCaret() })
  on(pre, 'click', e => {
    const dot = e.target.closest('.ed-dot')
    if (dot) store.reveal(Number(dot.dataset.line))
  })

  store.subscribe((s, changed) => {
    if (changed.has('doc')) contactLines = new Set(s.doc?.header?.contacts.map(c => c.line))
    if (changed.has('content')) {
      if (s.content !== ta.value) replaceValue(s.content)
      render()
    } else if (changed.has('issues')) paintMarkers()
    if (changed.has('reveal') && s.reveal) revealLine(s.reveal.line)
  })

  contactLines = new Set(store.state.doc?.header?.contacts.map(c => c.line))
  ta.value = store.state.content
  ta.setSelectionRange(0, 0)
  render()

  return {
    focusLine(line) {
      if (store.state.ui.tab !== 'write') store.setUi({ tab: 'write' })
      revealLine(line)
      ta.focus({ preventScroll: true })
    },
    insert,
    showSyntax,
  }
}
