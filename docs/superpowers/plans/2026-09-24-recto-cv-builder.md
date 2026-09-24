# Recto CV Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Recto, a zero-dependency, text-first CV builder with a live paged canvas, preflight checks and ATS-safe PDF output, runnable locally (`node serve.js`) or from any static host.

**Architecture:** Native ES modules, no build. Pure modules (`src/model`, `src/preflight`, `src/io/jsonresume.js`, `src/io/plaintext.js`, `src/render/theme.js`, `src/render/paginate.js`) are shared by the browser app, Node tests and the CLI. The browser renders pages into a shadow root with a measure → paginate → build → verify loop. A small store owns state/history; UI modules mount into fixed regions and talk only through the store and a `ctx` object.

**Tech Stack:** Vanilla JS (ES2022 modules), HTML, CSS; Node ≥ 20 stdlib (`node:test`, `node:http`, `child_process`); headless Chromium via DevTools protocol over a pipe for smoke tests and the CLI.

**Spec:** `docs/superpowers/specs/2026-09-24-recto-cv-builder-design.md` — every task implicitly includes the spec sections it cites. Where this plan refines the spec (marked **Refines spec**), the plan wins.

## Global Constraints

- Zero runtime and zero dev dependencies. Never run `npm install`. Only Node stdlib and browser APIs.
- No build step. Browser code is native ES modules loaded with relative paths ending in `.js`.
- Node ≥ 20. Tests: `node:test` + `node:assert/strict`, files `test/<name>.test.js`, run with `node --test test/<name>.test.js`.
- Pure modules must not touch `document`, `window`, `localStorage` or `fetch` at import time or in pure functions.
- Units: geometry in mm, font sizes in pt; CSS in cv.css / theme / templates uses only `pt`, `mm`, `em` or unitless (never `rem`, `vh`, `vw`, `%` heights).
- Rendering user data: `createElement` / `textContent` / `setAttribute` only. Never assign `innerHTML` from a non-literal.
- ATS paint invariant (spec 4.2): text-bearing elements inside `.cv-page` are static, in normal flow, no float/position/transform/opacity<1/z-index/filter/order.
- Separators between adjacent text fields are real text nodes from `src/model/separators.js`.
- Public DOM/CSS contract: class names and `--cv-*` variables exactly as spec 4.1 and Task 4.
- Allowed link schemes: `http`, `https`, `mailto`, `tel`.
- CSP (spec 8) must keep working: no inline `<script>`, no `eval`, no external requests.
- Style: 2-space indent, no semicolons, single quotes, small focused functions, short comments only where the why is non-obvious.
- Budget: app JS + CSS ≤ 300 KB uncompressed.

## Review Focus

1. **Pasted text from Word/LinkedIn/Windows** (CRLF line endings, tabs, NBSP, BOM, smart quotes, soft hyphens): the parser must normalize CRLF/BOM, treat tabs as 2 spaces for indentation, treat NBSP as a space for line classification, and never crash. → Task 1 test "normalizes pasted text".
2. **Empty and degenerate documents** (empty string, only a name, only `##`, a section with only a rule): every pure module and the renderer must return a valid result — one blank page, no exceptions. → Tests in Tasks 1, 2, 6, 7; render check in Task 8.
3. **Very long content and long unbreakable strings** (5 000-line CV; a 120-char URL in a narrow sidebar): parsing < 200 ms, pagination terminates, the long URL wraps inside its column instead of widening it. → Task 1 perf test, Task 3 perf test, Task 8 render check.
4. **Corrupt or foreign stored/imported data** (invalid JSON, wrong types, future `version`, missing `layout`, unknown template id): load returns a usable document plus warnings, never throws. → Task 2 `migrateFile` tests, Task 9 store load test, Task 6 foreign JSON Resume test.
5. **Typing through a heading rename** (`## Experience` → `## Experien` → `## Experience`): the section's layout config (column, variant, panel) must survive each intermediate id. → Task 2 `renameSectionIds` test and Task 9 store test.

---

## Execution model (for the orchestrator)

- Waves run in order; tasks inside a wave run in parallel in the **same working tree**.
- A task creates/modifies **only** the files listed under its **Files**. If it needs something from another task's file, it codes against the **Interfaces** block and reports anything missing in its final output under `requests`.
- Agents never commit, never run `git` write commands, never run the whole suite as a gate (other tasks may be mid-flight). They run their own test files.
- UI strings: tasks never edit `locales/en.json`. Each task that needs strings writes `locales/_parts/<task-key>.json` (flat `{ "key": "English text" }`); the orchestrator merges parts into `locales/en.json` after each wave.
- Styles: `styles/cv.css` (Task 8), `styles/app.css` (Task 10), `styles/editor.css` (Task 11), `styles/canvas.css` (Task 12), `styles/inspector.css` (Task 13). **Refines spec §11.**
- After each wave the orchestrator runs `node --test`, merges locale parts, and commits.

| Wave | Tasks |
|---|---|
| 1 | 1 Parser · 2 Layout model · 3 Paginate · 4 Theme & contrast · 5 Server & Chrome driver |
| 2 | 6 ATS / JSON Resume / plaintext · 7 Preflight rules · 8 Render engine · 9 Store & IO |
| 3 | 10 App shell · 11 Editor · 12 Canvas · 13 Inspector & panels |
| 4 | 14 Templates & smoke · 15 CLI · 16 Docs & OSS |
| 5 | Integration QA (orchestrator + reviewers) |

Already present (orchestrator-written, do not modify): `package.json`, `LICENSE`, `.gitignore`, `src/model/categories.js` (+ test), `src/model/separators.js`, `samples/sample.cv.json`.

`categories.js` exports: `LANGS`, `CATEGORIES`, `PRESENT_WORDS`, `RANGE_WORDS`, `normalizeHeading(s)`, `categorize(title, lang) → category|null`, `isStandardHeading(title, lang) → boolean`, `presentWords(lang) → string[]` (lang + en, longest first), `rangeWords(lang) → string[]`.
`separators.js` exports: `HEADER_SEPARATORS`, `DEFAULT_CONTACT_SEP`, `TAG_SEP`, `ORG_SEP`, `DATE_SEP`, `FIELD_SEP`.

---

## Wave 1

### Task 1: Recto Markdown parser

**Files:**
- Create: `src/model/markdown.js`
- Test: `test/markdown.test.js`

**Interfaces:**
- Consumes: `categories.js` (`presentWords`, `rangeWords`, `categorize`), `separators.js` (`HEADER_SEPARATORS`, `DEFAULT_CONTACT_SEP`).
- Produces:
  - `parse(source: string) → Doc` (spec 3.3; never throws; `Doc.diagnostics[]` = `{ line, code, vars }`).
  - `parseInline(text: string, ctx?: { line, diagnostics }) → Inline[]`
  - `inlineText(inlines: Inline[]) → string` (plain text; `br` → `'\n'`)
  - `slugify(s: string) → string`
  - `detectContact(part: string, line: number) → Contact` (always returns a Contact; `kind:'text'` when not contact-like; `isContactLike(contact)` = `kind !== 'text'`)
  - `parseDateRange(text: string, lang = 'en') → null | { start: {y, m?}, end: {y, m?} | null, current: boolean, style }`
  - `formatDate(point: {y, m?}, style, lang = 'en') → string`
  - `DATE_STYLES = ['YYYY', 'YYYY-MM', 'MM/YYYY', 'Mon YYYY', 'Month YYYY']`
  - `DIAG_CODES = ['text-before-name', 'extra-name', 'header-markup', 'unclosed-emphasis', 'unsafe-link', 'entry-extra-fields', 'unparseable-date']`
  - `ENTRY_FIELDS = ['title', 'org', 'date', 'location']`
  - `splitEntryFields(raw: string) → string[]` (raw text after `### `, split on unescaped `|`, trimmed, escapes kept — used by fixes to rewrite one field byte-for-byte)
  - `joinEntryFields(fields: string[]) → string` (`'### ' + fields.join(' | ')`, trailing empty fields dropped)

**Requirements:** spec 3.2 in full (line classification table and every bullet), 3.3.
- Pre-normalize: strip BOM; `\r\n`/`\r` → `\n`; for classification, tabs count as 2 spaces and NBSP (U+00A0) as a space. Source line numbers are preserved (1-based).
- `section.endLine` = last line before the next `##` (or last line of file), trailing blank lines excluded.
- Contact-category sections (`categorize(title) === 'contact'`): run `detectContact` over each list item's `inlineText` split by header separators and over each paragraph's text parts; fill `section.contacts` (only contact-like ones).
- Dates: match present-words (longest first) before splitting on range words. Month names: build from `Intl.DateTimeFormat(lang, { month: 'short' | 'long' })` for months 0–11 plus English; compare lowercase with trailing `.` removed; `sept` → 9. `MM/YYYY` requires `1 ≤ MM ≤ 12`. Year range 1900–2100. If start and end parse but their styles differ (ignoring a present end), `style` is still the start's style.
- `formatDate`: `YYYY` → `2021`; `YYYY-MM` → `2021-03`; `MM/YYYY` → `03/2021`; `Mon YYYY` → short month in `lang` with first letter uppercased and trailing `.` removed (`Mar 2021`); `Month YYYY` → long month capitalized (`March 2021`).

- [ ] **Step 1: Write the failing tests** — `test/markdown.test.js` must include at least these (plus one test per remaining bullet of spec 3.2):

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse, parseInline, inlineText, slugify, parseDateRange, formatDate, detectContact, splitEntryFields, joinEntryFields } from '../src/model/markdown.js'

const sample = JSON.parse(readFileSync(new URL('../samples/sample.cv.json', import.meta.url))).content

test('parses the sample CV', () => {
  const d = parse(sample)
  assert.equal(d.header.name, 'Alex Morgan')
  assert.equal(inlineText(d.header.taglines[0].inlines), 'Senior Software Engineer · Developer Tools')
  assert.deepEqual(d.header.contacts.map(c => c.kind), ['email', 'phone', 'url', 'url', 'text'])
  assert.equal(d.header.contacts[2].href, 'https://alexmorgan.dev')
  assert.ok(d.header.contacts.every(c => c.valid))
  assert.equal(d.header.contactSep, ' · ')
  assert.deepEqual(d.sections.map(s => s.id), ['summary', 'experience', 'projects', 'education', 'skills', 'languages', 'certifications'])
  const exp = d.sections[1].blocks
  assert.equal(exp.length, 3)
  assert.equal(exp[0].type, 'entry')
  assert.equal(inlineText(exp[0].title), 'Senior Software Engineer')
  assert.equal(inlineText(exp[0].org), 'Lumen Labs')
  assert.equal(exp[0].location, 'San Francisco, CA')
  assert.deepEqual(exp[0].dateRange, { start: { y: 2022, m: 3 }, end: null, current: true, style: 'Mon YYYY' })
  assert.equal(exp[0].blocks[0].type, 'list')
  assert.equal(exp[0].blocks[0].items.length, 3)
  assert.deepEqual(d.diagnostics, [])
})

test('normalizes pasted text (CRLF, BOM, tabs, NBSP)', () => {
  const d = parse('﻿# Jane\r\n\r\n## Skills\r\n- Go\r\n\t- Rust\r\n')
  assert.equal(d.header.name, 'Jane')
  assert.deepEqual(d.sections[0].blocks[0].items.map(i => inlineText(i.inlines)), ['Go', 'Rust'])
})

test('degenerate documents never throw', () => {
  for (const src of ['', '#', '# ', '##', '## \n---', '###', '- a', '---', '\n\n\n', '# A\n## B {#b}\n## B']) {
    const d = parse(src)
    assert.ok(Array.isArray(d.sections))
  }
  assert.equal(parse('').header, null)
  assert.equal(parse('hello\n## A').diagnostics[0].code, 'text-before-name')
})

test('entry fields: escapes, extras, missing', () => {
  const d = parse('# N\n## Work\n### A \\| B | Org | 2020 | X | Y\n### Solo')
  const [e1, e2] = d.sections[0].blocks
  assert.equal(inlineText(e1.title), 'A | B')
  assert.equal(e1.location, 'X | Y')
  assert.equal(d.diagnostics.find(x => x.code === 'entry-extra-fields').line, 3)
  assert.deepEqual(e2.org, [])
  assert.equal(e2.date, '')
  assert.deepEqual(splitEntryFields('A \\| B | Org | 2020'), ['A \\| B', 'Org', '2020'])
  assert.equal(joinEntryFields(['T', 'O', '2021', '']), '### T | O | 2021')
})

test('rule inside an entry closes it; bullets, continuation, paragraphs', () => {
  const d = parse('# N\n## S\n### E\nIntro line\n- one\n  continued\n- two\nAfter list\n---\nTail')
  const b = d.sections[0].blocks
  assert.deepEqual(b.map(x => x.type), ['entry', 'rule', 'paragraph'])
  assert.deepEqual(b[0].blocks.map(x => x.type), ['paragraph', 'list', 'paragraph'])
  assert.equal(inlineText(b[0].blocks[1].items[0].inlines), 'one continued')
})

test('inline markup, autolinks, unsafe links, raw HTML', () => {
  const r = parseInline('**b** *i* `c` [x](https://x.dev) snake_case see https://a.dev/p). <b>hi</b>')
  assert.deepEqual(r.slice(0, 1), [{ t: 'strong', c: [{ t: 'text', v: 'b' }] }])
  assert.ok(inlineText(r).includes('snake_case'))
  const link = r.find(n => n.t === 'link' && n.href === 'https://a.dev/p')
  assert.ok(link, 'autolink excludes trailing ).')
  assert.ok(inlineText(r).includes('<b>hi</b>'))
  const d = parse('# N\n## S\n[bad](javascript:alert(1)) and **open')
  assert.deepEqual(d.diagnostics.map(x => x.code).sort(), ['unclosed-emphasis', 'unsafe-link'])
  assert.ok(!JSON.stringify(d).includes('"href":"javascript'))
})

test('contact detection is loose, validation strict', () => {
  assert.equal(detectContact('Node.js', 1).kind, 'text')
  const e = detectContact('Email: jane@doe.dev', 1)
  assert.deepEqual([e.kind, e.label, e.text, e.valid], ['email', 'Email', 'jane@doe.dev', true])
  assert.equal(detectContact('jane@doe', 1).valid, false)
  assert.equal(detectContact('linkedin.com/in/x', 1).href, 'https://linkedin.com/in/x')
  assert.equal(detectContact('+49 151 0000000', 1).kind, 'phone')
  const d = parse('# N\nStaff Engineer · Go · Node.js\n')
  assert.equal(d.header.taglines.length, 1)
  assert.equal(d.header.contacts.length, 0)
})

test('contact sections collect contacts', () => {
  const d = parse('# N\n## Contact\n- jane@doe.dev\n- +1 555 555 5555')
  assert.deepEqual(d.sections[0].contacts.map(c => c.kind), ['email', 'phone'])
})

test('dates', () => {
  assert.deepEqual(parseDateRange('2017 – 2020'), { start: { y: 2017 }, end: { y: 2020 }, current: false, style: 'YYYY' })
  assert.deepEqual(parseDateRange('03/2019 - 11/2021').style, 'MM/YYYY')
  assert.deepEqual(parseDateRange('2019-03 to 2021-11').end, { y: 2021, m: 11 })
  assert.deepEqual(parseDateRange('Sept. 2020 — Present'), { start: { y: 2020, m: 9 }, end: null, current: true, style: 'Mon YYYY' })
  assert.deepEqual(parseDateRange('März 2020 bis heute', 'de'), { start: { y: 2020, m: 3 }, end: null, current: true, style: 'Mon YYYY' })
  assert.equal(parseDateRange('January 2020').style, 'Month YYYY')
  assert.deepEqual(parseDateRange('2019'), { start: { y: 2019 }, end: { y: 2019 }, current: false, style: 'YYYY' })
  assert.equal(parseDateRange("Summer '19"), null)
  assert.equal(parseDateRange('13/2020'), null)
  assert.equal(formatDate({ y: 2021, m: 3 }, 'Mon YYYY'), 'Mar 2021')
  assert.equal(formatDate({ y: 2021, m: 3 }, 'Month YYYY'), 'March 2021')
  assert.equal(formatDate({ y: 2021, m: 3 }, 'MM/YYYY'), '03/2021')
  assert.equal(formatDate({ y: 2021, m: 3 }, 'YYYY-MM'), '2021-03')
  const d = parse("# N\n## Work\n### A | B | Summer '19")
  assert.equal(d.diagnostics[0].code, 'unparseable-date')
})

test('ids: explicit reserved first, slugs deduped, non-Latin', () => {
  const d = parse('# N\n## Skills\n## Tools {#skills}\n## Skills\n## 技能')
  assert.deepEqual(d.sections.map(s => s.id), ['skills-2', 'skills', 'skills-3', 'section'])
  assert.equal(slugify('Über  Uns!'), 'uber-uns')
  assert.equal(d.sections[1].explicitId, true)
  assert.equal(d.sections[1].title, 'Tools')
})

test('endLine spans a section', () => {
  const d = parse('# N\n## A\nx\n\n## B\ny\n')
  assert.deepEqual([d.sections[0].line, d.sections[0].endLine, d.sections[1].line, d.sections[1].endLine], [2, 3, 5, 6])
})

test('parses 5000 lines quickly', () => {
  const src = '# N\n' + Array.from({ length: 1000 }, (_, i) => `## S${i}\n### T | O | 2020 – 2021\n- bullet **bold** text\n- another [l](https://x.dev)\n`).join('')
  const t = performance.now(); parse(src)
  assert.ok(performance.now() - t < 200)
})
```

- [ ] **Step 2: Run to verify failure** — `node --test test/markdown.test.js` → FAIL (module not found).
- [ ] **Step 3: Implement `src/model/markdown.js`** per spec 3.2/3.3 and the Requirements above. Structure: `normalize(source) → lines[]`, `classify(line, prev)`, a single pass state machine (`region: 'pre' | 'header' | 'body'`, current section/entry/list/paragraph accumulator), `parseInline` as a small recursive-descent scanner over characters (escape → code → link → strong → em → autolink → text), `detectContact`, date helpers.
- [ ] **Step 4: Run** `node --test test/markdown.test.js` → all PASS.

### Task 2: Layout model, templates, edits, remix

**Files:**
- Create: `src/model/layout.js`, `src/model/templates.js`, `src/model/edits.js`, `src/model/remix.js`
- Test: `test/layout.test.js`, `test/templates.test.js`, `test/edits.test.js`, `test/remix.test.js`

**Interfaces:**
- Consumes: `categories.js` (`categorize`); Doc shape from spec 3.3 (tests build Docs by hand or via `parse` from Task 1 — if `markdown.js` is not there yet, build Docs by hand).
- Produces (`layout.js`):
  - `PAGE_SIZES`, `THEME_DEFAULTS` (spec 3.5 table), `SECTION_DEFAULTS` (spec 3.4, `keepTogether: true`, `column` resolved at call time), `VARIANTS`, `ENUMS` (every enum in 3.5), `FONT_PRESETS = ['system-ui','neo-grotesque','humanist','geometric','transitional','old-style','didone','slab','mono']`
  - `defaultLayout(size = 'A4') → Layout`
  - `normalizeLayout(input: any) → Layout` — never throws; fills defaults, clamps (spec 3.4), validates colors/enums, 1–3 columns with unique ids (`[a-z0-9-]+`, invalid → `col-N`), `readingOrder` = permutation of column ids (missing ids appended, unknown/duplicates removed; default widest first, ties by visual order), `headerSpan` ∈ `'full'` or a column id, `photo.src` must start with `data:image/` (≤ 200 000 chars) else `null`, decor items normalized (unique ids `d1…`), `customCss` ≤ 50 000 chars, `sectionDefaults` keys ∈ categories ∪ `'*'`.
  - `migrateFile(json: any) → { file: { format:'recto', version:1, name, content, layout, fonts? }, warnings: string[] }` — accepts objects or JSON strings; non-object → default file + warning `'invalid-file'`; `version > 1` → warning `'newer-version'` (best effort); missing content → `''`; unknown keys dropped.
  - `applyLayoutOps(layout, ops: Array<{ path: (string|number)[], value }>) → Layout` (immutable: returns a new object; `value === undefined` deletes; then normalize)
  - `getPath(obj, path)` helper
  - `sectionConfig(layout, section) → SectionConfig`
  - `placeSections(doc, layout) → { [colId]: Array<{ section, config }> }` (every grid column key present, even if empty)
  - `renameSectionIds(prevDoc, nextDoc, layout) → Layout`
  - `columnGeometry(layout) → Array<{ id, x, w }>` (mm, relative to page left edge, content box; widths from fr and gutter)
  - `contentBox(layout) → { x, y, w, h }` (mm)
- Produces (`templates.js`): `applyTemplate(layout, template) → Layout` (spec 5.2), `loadTemplates(base = 'templates/') → Promise<Template[]>` (fetch `index.json` = `{ templates: ['classic', …] }`, then each `<id>.json`; skips failures).
- Produces (`edits.js`):
  - `applyContentEdits(content, edits: Array<{ line, expect, text }>) → { content, stale: boolean }` — if any `expect` mismatches, returns the original content with `stale: true`; applies bottom-up; `text: null` deletes the line.
  - `moveSectionSource(content, doc, id, beforeSectionId: string|null, afterSectionId: string|null) → string` — moves lines `section.line..section.endLine` to just before `beforeSectionId`'s line, or just after `afterSectionId`'s `endLine`, or to EOF if both null; keeps exactly one blank line between sections.
  - `setEntryField(line: string, index: number, value: string) → string` — rewrites one `###` field keeping others byte-for-byte (uses `splitEntryFields`/`joinEntryFields` semantics; implement locally if Task 1 not ready: split on unescaped `|`).
- Produces (`remix.js`): `ACCENTS` (12 curated hex colors, all ≥ 4.5:1 on white), `remix(layout, rand = Math.random) → ops[]` (paths into `theme`).

**Requirements:** spec 3.4, 3.5 (clamps/enums), 3.1 migrate, 5.2 applyTemplate.

- [ ] **Step 1: Write failing tests.** Required cases:

```js
// test/layout.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultLayout, normalizeLayout, migrateFile, applyLayoutOps, sectionConfig, placeSections, renameSectionIds, columnGeometry, THEME_DEFAULTS } from '../src/model/layout.js'

const doc = (...titles) => ({ header: null, diagnostics: [], sections: titles.map((t, i) => ({ id: t.toLowerCase(), title: t, titleInlines: [], explicitId: false, line: i + 1, endLine: i + 1, contacts: [], blocks: [] })) })

test('normalizeLayout survives garbage', () => {
  for (const bad of [null, undefined, 42, 'x', [], { page: 'x', grid: { columns: [] }, theme: { sizeBody: 'big', colorText: 'red; }' } }]) {
    const l = normalizeLayout(bad)
    assert.equal(l.version, 1)
    assert.equal(l.grid.columns.length, 1)
    assert.equal(l.theme.sizeBody, THEME_DEFAULTS.sizeBody)
    assert.equal(l.theme.colorText, THEME_DEFAULTS.colorText)
  }
})

test('clamps and enums', () => {
  const l = normalizeLayout({ page: { margins: { top: -5, left: 500 } }, theme: { headingLetterSpacing: 0.3, bulletChar: '★', density: 3 } })
  assert.equal(l.page.margins.top, 0)
  assert.equal(l.page.margins.left, 60)
  assert.equal(l.theme.headingLetterSpacing, 0.08)
  assert.equal(l.theme.bulletChar, '•')
  assert.equal(l.theme.density, 1.2)
})

test('columns, reading order and header span', () => {
  const l = normalizeLayout({ grid: { columns: [{ id: 'side', width: 1 }, { id: 'main', width: 2 }, { id: 'main', width: 1 }, { id: 'x' }], headerSpan: 'nope', readingOrder: ['zzz', 'side'] } })
  assert.equal(l.grid.columns.length, 3)
  assert.equal(new Set(l.grid.columns.map(c => c.id)).size, 3)
  assert.deepEqual([...l.grid.readingOrder].sort(), l.grid.columns.map(c => c.id).sort())
  assert.equal(l.grid.headerSpan, 'full')
  assert.deepEqual(normalizeLayout({ grid: { columns: [{ id: 'side', width: 1 }, { id: 'main', width: 2 }] } }).grid.readingOrder, ['main', 'side'])
})

test('migrateFile never throws', () => {
  assert.equal(migrateFile('not json').warnings[0], 'invalid-file')
  assert.equal(migrateFile({ format: 'recto', version: 9, content: '# A' }).warnings.includes('newer-version'), true)
  const { file } = migrateFile({ format: 'recto', version: 1, content: '# A', layout: null, snapshots: [1], junk: 1 })
  assert.equal(file.content, '# A')
  assert.equal('snapshots' in file, false)
  assert.equal(file.layout.version, 1)
})

test('applyLayoutOps sets, creates and deletes immutably', () => {
  const a = defaultLayout()
  const b = applyLayoutOps(a, [{ path: ['theme', 'lineHeight'], value: 1.5 }, { path: ['sections', 'skills', 'variant'], value: 'tags' }])
  assert.equal(a.theme.lineHeight, THEME_DEFAULTS.lineHeight)
  assert.equal(b.theme.lineHeight, 1.5)
  assert.equal(b.sections.skills.variant, 'tags')
  const c = applyLayoutOps(b, [{ path: ['sections', 'skills'], value: undefined }])
  assert.equal(c.sections.skills, undefined)
})

test('sectionConfig merge order and column fallback', () => {
  const l = normalizeLayout({ grid: { columns: [{ id: 'main', width: 2 }, { id: 'side', width: 1 }] }, sectionDefaults: { '*': { variant: 'compact' }, skills: { column: 'side', variant: 'tags' } }, sections: { skills: { showTitle: false }, work: { column: 'gone' } } })
  const d = doc('Skills', 'Work')
  assert.deepEqual([sectionConfig(l, d.sections[0]).column, sectionConfig(l, d.sections[0]).variant, sectionConfig(l, d.sections[0]).showTitle], ['side', 'tags', false])
  assert.equal(sectionConfig(l, d.sections[1]).column, 'main')
  assert.equal(sectionConfig(l, d.sections[1]).keepTogether, true)
  const placed = placeSections(d, l)
  assert.deepEqual(Object.keys(placed).sort(), ['main', 'side'])
  assert.deepEqual(placed.side.map(p => p.section.id), ['skills'])
})

test('renameSectionIds survives typing through a rename', () => {
  let l = normalizeLayout({ sections: { experience: { variant: 'timeline' } } })
  const steps = [doc('Summary', 'Experience'), doc('Summary', 'Experien'), doc('Summary', 'Experience')]
  for (let i = 1; i < steps.length; i++) l = renameSectionIds(steps[i - 1], steps[i], l)
  assert.equal(l.sections.experience.variant, 'timeline')
  assert.equal(l.sections.experien, undefined)
})

test('columnGeometry', () => {
  const l = normalizeLayout({ page: { size: 'A4', margins: { top: 10, right: 10, bottom: 10, left: 10 } }, grid: { columns: [{ id: 'a', width: 1 }, { id: 'b', width: 3 }], gutter: 10 } })
  assert.deepEqual(columnGeometry(l), [{ id: 'a', x: 10, w: 45 }, { id: 'b', x: 65, w: 135 }])
})
```

Plus `test/templates.test.js` (applyTemplate keeps `lang`, `customCss`, `header.photo`, `page.size/width/height/targetPages`; replaces grid/theme/margins/decor; resets `sections` keeping only `hidden: true`; ignores a template's `page.size`), `test/edits.test.js` (applyContentEdits bottom-up, delete, stale on mismatch; moveSectionSource before/after/EOF preserving one blank line; setEntryField keeps `\|` escapes byte-for-byte), `test/remix.test.js` (seeded `rand` → deterministic ops; every op path starts with `theme`; values pass `normalizeLayout` unchanged).

- [ ] **Step 2: Run** `node --test test/layout.test.js test/templates.test.js test/edits.test.js test/remix.test.js` → FAIL.
- [ ] **Step 3: Implement** the four modules.
- [ ] **Step 4: Run** the same command → PASS.

### Task 3: Paginate (pure)

**Files:**
- Create: `src/render/paginate.js`
- Test: `test/paginate.test.js`

**Interfaces:**
- Produces: `paginate(input) → { pages: Array<{ [colId]: number[] }>, flags: Array<{ kind: 'overflow'|'forced-split', page: number /* 1-based */, colId, atom: number }> }` with `input` exactly as spec 4.3 step 3. Also export `usedHeight(atoms, indices) → number`.

**Algorithm (implement exactly):**
```
for each colId:
  atoms = input.columns[colId]; chunks = group consecutive atoms i..j where atoms[k].keepWithNext joins k→k+1, and atoms with equal non-null group join
  page = 0; placed = []   // placed = indices on current page
  cap(p) = input.capacityOverride?.[p]?.[colId] ?? (p === 0 ? input.capacityFirst[colId] : input.capacityRest)
  for chunk of chunks:
    if chunk[0].breakBefore && placed.length: newPage()
    if fits(placed ∪ chunk, cap(page)): place all; continue
    if placed.length: newPage()                         // try the whole chunk on a fresh page
    if fits(chunk, cap(page)): place all; continue
    // chunk taller than a page: place atom by atom
    for i of chunk:
      if placed.length && !fits(placed ∪ [i], cap(page)): newPage()
      place i
      if placed.length === 1 && !fits([i], cap(page)): flag overflow(page, i)
    if chunk.length > 1: flag forced-split(first page of chunk, chunk[0])
fits(ix, c) = usedHeight(atoms, ix) <= c + epsilon
usedHeight(ix) = hStart[ix0] + Σ h[ix0..ixLast−1] + hEnd[ixLast]
pages[p][colId] = indices; pages array length = max pages over columns; columns with fewer pages get [] on later pages
```

- [ ] **Step 1: Write failing tests** covering: all fit on one page; greedy overflow to page 2; `keepWithNext` heading never last on a page; `group` moves whole entry to next page; group taller than a page → split + `forced-split`; single atom taller than capacity → alone + `overflow`, next atom on next page; `breakBefore`; independent columns (main 3 pages, side 1 page → side has `[]` on pages 2–3); `capacityFirst` smaller than `capacityRest`; `capacityOverride` shrinks one page; `hStart`/`hEnd` accounting (an atom that fits by `h` but not by `hEnd` moves); empty columns → `pages.length === 1`; 1 000 atoms in < 20 ms.

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { paginate } from '../src/render/paginate.js'
const A = (h, o = {}) => ({ h, hStart: 0, hEnd: h, keepWithNext: false, group: null, breakBefore: false, ...o })
const run = (atoms, cap = 100, extra = {}) => paginate({ columns: { main: atoms }, capacityFirst: { main: cap }, capacityRest: cap, epsilon: 0.5, ...extra })

test('heading kept with next', () => {
  const r = run([A(60), A(30, { keepWithNext: true }), A(30)])
  assert.deepEqual(r.pages.map(p => p.main), [[0], [1, 2]])
})
test('oversized atom is flagged and alone', () => {
  const r = run([A(10), A(250), A(10)])
  assert.deepEqual(r.pages.map(p => p.main), [[0], [1], [2]])
  assert.deepEqual(r.flags, [{ kind: 'overflow', page: 2, colId: 'main', atom: 1 }])
})
test('empty input yields one empty page', () => {
  assert.deepEqual(paginate({ columns: { main: [], side: [] }, capacityFirst: { main: 100, side: 100 }, capacityRest: 100, epsilon: 0.5 }).pages, [{ main: [], side: [] }])
})
```
- [ ] **Step 2: Run** `node --test test/paginate.test.js` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

### Task 4: Theme CSS and contrast

**Files:**
- Create: `src/render/theme.js`, `src/preflight/contrast.js`
- Test: `test/theme.test.js`, `test/contrast.test.js`

**Interfaces:**
- Produces (`theme.js`):
  - `FONT_STACKS: { [preset]: string }` (spec 3.5; each sans stack ends `Arial, 'Liberation Sans', Arimo, sans-serif`, serif `'Times New Roman', 'Liberation Serif', Tinos, serif`, mono `'Courier New', 'Liberation Mono', Cousine, monospace`)
  - `resolveFont(value) → string` (preset → stack; `font:<family>` → `"<escaped family>", <neo-grotesque stack>`; unknown → neo-grotesque stack)
  - `scaledTheme(theme) → theme` (density applied: gaps × d; lineHeight = 1 + (lh − 1) × d; sizes × (1 + (d − 1) × 0.35); rounded to 2 decimals)
  - `themeToCss(theme) → string` — declarations only (no selector), one per line, exactly these properties: `--cv-font-body`, `--cv-font-heading`, `--cv-font-mono`, `--cv-size-name|section|entry|body|small` (pt), `--cv-line-height`, `--cv-gap-paragraph|entry|section` (mm), `--cv-color-text|muted|accent|heading|rule|page` (hex; `heading` resolved from `'accent'`/`'text'`), `--cv-heading-transform` (`uppercase|none`), `--cv-heading-size-factor` (`0.82` for small-caps else `1`), `--cv-heading-letter-spacing` (em), `--cv-heading-weight`, `--cv-name-weight`, `--cv-name-transform`, `--cv-bullet-char` (CSS string, `""` for none), `--cv-link-decoration` (`none|underline`), `--cv-link-color` (`inherit` or accent hex).
  - `themeAttrs(theme) → { 'data-heading-rule', 'data-date-style', 'data-link-style', 'data-heading-case' }`
  - `columnCss(column) → string` — `--cv-col-text/muted/accent` declarations for overrides present (empty string if none).
- Produces (`contrast.js`): `parseColor(s) → { r, g, b, a } | null` (hex 3/6/8, `rgb()`/`rgba()`, `transparent`, `white`, `black`), `toHex({r,g,b}) → '#rrggbb'`, `composite(top, bottom) → {r,g,b,a:1}`, `relativeLuminance(c)`, `contrastRatio(a, b) → number` (WCAG 2.x, 2 decimals), `bestTextColor(bg) → '#000000' | '#ffffff'`.

- [ ] **Step 1: Tests**: every token appears in `themeToCss(THEME_DEFAULTS)` (import `THEME_DEFAULTS` from layout.js if present, else a literal copy of the spec table); density 1.2 scales gaps by 1.2 and sizeBody by 1.07; `font:My "Font"` is escaped; no `rem|vh|vw` in output; contrast `#000` vs `#fff` = 21; `#767676` vs `#fff` ≈ 4.54; composite 50 % black over white = `#808080` ± 1; `bestTextColor('#1d4ed8') === '#ffffff'`.
- [ ] **Step 2–4:** fail → implement → `node --test test/theme.test.js test/contrast.test.js` PASS.

### Task 5: Static server and Chrome DevTools driver

**Files:**
- Create: `serve.js`, `cli/chrome.js`
- Test: `test/serve.test.js`, `test/chrome.test.js`

**Interfaces:**
- Produces (`serve.js`):
  - `createServer({ root = <repo dir>, extra = {} /* { '/path': Buffer|string|{ body, type } } */ }) → http.Server` (not listening)
  - `listen(server, { host = '127.0.0.1', port = 8710, tries = 10 }) → Promise<{ url, port }>` (on `EADDRINUSE` tries port+1…; `port: 0` = random)
  - When run directly (`node serve.js [--host H] [--port N]`): listens and prints `Recto running at http://127.0.0.1:8710`.
  - MIME: `.html .js .mjs .css .json .svg .png .jpg .jpeg .webp .woff2 .woff .ttf .otf .md .txt .ico .webmanifest`. `/` → `index.html`. Directories → 404 (no listing). Path traversal (`..`, encoded `%2e%2e`, absolute) → 403. `Cache-Control: no-cache`. Only GET/HEAD (others 405).
- Produces (`cli/chrome.js`):
  - `findChrome() → string | null` (`CHROME_PATH`; macOS `/Applications/{Google Chrome,Chromium,Microsoft Edge,Brave Browser}.app/Contents/MacOS/*`; Linux `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `microsoft-edge` on PATH; Windows Program Files paths)
  - `launch({ executable = findChrome(), args = [] }) → Promise<Browser>`; spawns `--headless=new --remote-debugging-pipe --no-first-run --no-default-browser-check --disable-gpu --user-data-dir=<tmp dir> --hide-scrollbars --font-render-hinting=none`, stdio `['ignore', 'ignore', 'pipe', 'pipe', 'pipe']` (fd 3 = write to Chrome, fd 4 = read), messages NUL-delimited JSON.
  - `Browser = { send(method, params = {}, sessionId?) → Promise<result>, newPage(url) → Promise<Page>, close() → Promise<void> }` (close kills the process and removes the temp profile)
  - `Page = { sessionId, evaluate(expression, { awaitPromise = true } = {}) → Promise<value> /* returnByValue; throws on exceptionDetails */, pdf(options = {}) → Promise<Buffer> /* Page.printToPDF with preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false, merged with options */, close() }`
  - `newPage(url)`: `Target.createTarget({ url: 'about:blank' })` → `Target.attachToTarget({ targetId, flatten: true })` → `Page.enable` → `Page.navigate({ url })` → wait for `Page.loadEventFired` (timeout 30 s).
  - `countPdfPages(buf) → number` using `/\/Type\s*\/Page(?![A-Za-z])/g`.

- [ ] **Step 1: Tests**: `serve.test.js` — listen on port 0, GET `/` → 200 `text/html`, GET `/src/model/categories.js` → `text/javascript`, GET `/../package.json` and `/%2e%2e/package.json` → 403 (use `http.request` with a raw path), GET `/src/` → 404, `extra` route served with its type, two servers on the same fixed port → second gets port+1. `chrome.test.js` — `test.skip` when `findChrome()` is null; else launch, `newPage('data:text/html,<title>x</title><p>hi</p>')`, `evaluate('document.title')` → `'x'`, `evaluate('Promise.resolve(2)')` → 2, `pdf()` → Buffer starting `%PDF` with `countPdfPages === 1`, close.
- [ ] **Step 2–4:** fail → implement → `node --test test/serve.test.js test/chrome.test.js` PASS. (Create a throwaway `index.html` only inside a temp dir in the test by passing `root`; do not create the real `index.html`.)

---

## Wave 2

### Task 6: ATS extraction, JSON Resume, plain-text import

**Files:**
- Create: `src/preflight/ats.js`, `src/io/jsonresume.js`, `src/io/plaintext.js`
- Test: `test/ats.test.js`, `test/jsonresume.test.js`, `test/plaintext.test.js`, `test/fixtures/jsonresume-foreign.json`

**Interfaces:**
- Consumes: `markdown.js` (`parse`, `inlineText`, `parseDateRange`, `formatDate`, `detectContact`), `layout.js` (`normalizeLayout`, `defaultLayout`, `placeSections`, `sectionConfig`), `categories.js`, `separators.js`.
- Produces:
  - `extractText(doc, layout, placement = null) → string` — spec 6.2. Line format: header: name; each tagline; contacts joined with `doc.header.contactSep`. Section: title (as written; omitted if untitled or `showTitle: false`). Entry head: `title` + (`ORG_SEP` + org if org) + (`FIELD_SEP` + date if date) + (`FIELD_SEP` + location if location). Paragraph: text. Bullet: `'- ' + text` (tags variant: one line per item, chips joined with `TAG_SEP`). Rule: omitted. Blank line between sections. With placement: `--- page N ---` marker lines are **not** included (the panel adds them); output is ordered by placement.
  - `extractFields(doc, layout) → { name, label, emails, phones, urls, location, sections: [{ id, title, category, entries: [{ title, org, start, end, current, location, bullets }] }] }` (`start`/`end` as ISO `YYYY` or `YYYY-MM`).
  - `allContacts(doc, lang) → Contact[]` — header contacts then contact-section contacts (used by rules and JSON Resume).
  - `toJsonResume({ content, layout }) → { json, warnings }`, `fromJsonResume(json) → { content, layout, warnings }` — spec 6.4 in full.
  - `fromPlainText(text, lang = 'en') → string` — spec 6.5.

- [ ] **Step 1: Tests** (required): logical `extractText` of the sample equals a checked-in expectation written by hand in the test (first 6 lines exactly: `Alex Morgan`, `Senior Software Engineer · Developer Tools`, contacts line, blank, `Summary`, summary paragraph); two-column layout with `readingOrder: ['main','side']` puts `skills` (side) after all main sections; with a placement fixture that interleaves pages, side content of page 1 appears before main content of page 2; `extractFields(sample)` has 3 experience entries with `start: '2022-03'`, `current: true`; `toJsonResume(sample)` → `basics.name`, `basics.email`, `basics.profiles[0].network === 'GitHub'`, `work.length === 3`, `work[0].highlights.length === 3`, no `endDate` on current role, `skills[0]` = `{ name: 'Languages', keywords: ['TypeScript','Go','Python','SQL'] }`, `languages[0]` = `{ language: 'English', fluency: 'Native' }`, `meta.recto.content === sample`; round trip `fromJsonResume(toJsonResume(x).json).content === x.content`; editing `work[0].position` in the exported JSON → rebuilt from fields with the new position and warning `edited-outside`; foreign fixture (v0 `company`/`website`, a highlight containing `*stars*` and `a | b`, a `name` starting with `# `) → generated Markdown parses with 0 diagnostics and the escaped text survives `inlineText`; degenerate `toJsonResume({ content: '', layout: {} })` doesn't throw; `fromPlainText` on a pasted fixture (ALL CAPS headings, `●` bullets, contact line) → `parse()` gives name, contacts, 3 sections, bullets.
- [ ] **Step 2–4:** fail → implement → `node --test test/ats.test.js test/jsonresume.test.js test/plaintext.test.js` PASS.

### Task 7: Preflight rules

**Files:**
- Create: `src/preflight/rules.js`, `locales/_parts/preflight.json`
- Test: `test/rules.test.js`

**Interfaces:**
- Consumes: `markdown.js`, `layout.js` (`sectionConfig`, `placeSections`), `categories.js` (`categorize`, `isStandardHeading`), `contrast.js` (`contrastRatio`, `bestTextColor`), `ats.js` (`allContacts`) — if `ats.js` is not present yet, implement contact collection via `doc.header.contacts` + `section.contacts` directly (same semantics).
- Produces:
  - `runPreflight({ source, doc, layout, report = null, placement = null, now = new Date(), lang = layout.lang }) → Issue[]` (spec 6.1; sorted error → warn → info, then by line).
  - `RULES: Array<{ id, needsReport: boolean }>` in table order (used by the i18n parity test).
  - `SEVERITY_ORDER = { error: 0, warn: 1, info: 2 }`
- `locales/_parts/preflight.json`: `preflight.<rule>` for every rule (with `{var}` placeholders), `preflight.<rule>.fix` for every rule that can offer a fix, `diag.<code>` for every `DIAG_CODES` entry. Plain, friendly English, e.g. `"preflight.pages-over-target": "Your CV runs to {pages} pages; the target is {target}."`, `"preflight.pages-over-target.fix": "Fit to {target} page(s)"`.

- [ ] **Step 1: Tests**: for **every** rule in the spec tables: one positive case (fires with the right severity, `line`/`sectionId`/`page` set when applicable, correct `vars`), one negative case, and for rules with fixes: applying the fix (`applyContentEdits` from edits.js for content, `applyLayoutOps` for layout) and re-running removes the issue. Plus: the sample CV with `defaultLayout()` and `report = null` yields **zero errors**; `runPreflight` never throws on each degenerate doc from Task 1's list; `date-format-mixed` never rewrites a `YYYY` date and leaves `\|` escapes intact; `bullet-punctuation-mixed` ignores `Acme Inc.` and bullets ending in URLs; `hidden-link-target` body fix appends ` (x.dev)` without replacing the link text; `low-contrast` fix picks `#ffffff` on `#1d4ed8`; content fixes carry `expect` equal to the current line; report fixture builder:

```js
const report = (o = {}) => ({ pageCount: 1, targetPages: 1, lastPageFill: 0.6, flags: [], textStyles: [], fontsMissing: [], pages: [{ firstText: '', lastText: '', columnsWithText: ['main'] }], ...o })
```
- [ ] **Step 2–4:** fail → implement → `node --test test/rules.test.js` PASS.

### Task 8: Render engine, print mode, cv.css

**Files:**
- Create: `src/render/render.js`, `src/render/pages.js`, `src/render/decor.js`, `src/render/fit.js`, `styles/cv.css`, `index.html` (minimal: CSP meta from spec 8, `<style id="recto-page">`, `<div id="app"></div>`, `<script type="module" src="src/main.js">`), `src/main.js` (print mode only for now), `scripts/render-check.js`
- Test: `scripts/render-check.js` (browser check, not `node --test`)

**Interfaces:**
- Consumes: `markdown.js`, `layout.js` (`normalizeLayout`, `migrateFile`, `placeSections`, `sectionConfig`, `columnGeometry`, `contentBox`, `PAGE_SIZES`), `theme.js`, `paginate.js`, `contrast.js` (`parseColor`, `composite`, `toHex`), `categories.js`, `separators.js`, `templates.js` (`applyTemplate`, `loadTemplates`), `cli/chrome.js`, `serve.js`.
- Produces:
  - `renderAtoms(doc, layout, document = globalThis.document) → { header: HTMLElement | null, columns: { [colId]: Atom[] } }` (spec 4.3 step 1, DOM contract 4.1)
  - `createPagesHost(container: HTMLElement) → ShadowRoot` (attaches shadow root, adopts cv.css via `<link rel="stylesheet" href="styles/cv.css">` inside the shadow root, adds `<style data-theme>`, `<style data-custom>`)
  - `layoutPages(doc, layout, host: ShadowRoot) → Promise<{ pages: HTMLElement[], report: RenderReport, placement: Placement }>` (spec 4.3–4.6: measure, paginate, build, verify, report; writes `@page` into `document.getElementById('recto-page')`)
  - `renderDecor(layout, pageIndex /* 1-based */, pageCount, z: 'back'|'front', document) → SVGElement` (column bgs on back layer)
  - `fitToPages(doc, layout, host, pages) → Promise<{ density, reachedFloor, layout }>` (spec 4.7; uses a detached measuring host so the visible canvas doesn't flicker)
  - `paintViolations(host) → Array<{ selector, prop, value, text }>` (spec 4.2 check; exported from pages.js)
  - Print mode in `src/main.js`: `?print=<url>[&template=<id>][&report=1]` → `window.rectoReady: Promise<{ report, issues, placement, violations }>` (issues via dynamic `import('./preflight/rules.js')` guarded with `.catch(() => null)` so render works before Task 7 lands).
  - `scripts/render-check.js`: starts `createServer`, launches Chrome, for the sample (and a stress doc written to a temp route via `extra`: 40 entries, a 120-char URL in a sidebar column, a `bg` sidebar, a panel section split across pages, decor rect + line) loads `?print=…&report=1`, awaits `rectoReady`, asserts: `violations.length === 0`, no `overflow`/`verify-failed` flags on the sample, sample `pageCount` ≤ 2, PDF page count === `pageCount`, stress doc renders ≥ 3 pages and finishes < 5 s, and in every page column `scrollHeight <= clientHeight + 1`; writes PDFs to `out/`. Exit 1 on failure.

**Requirements:** spec 4.1–4.7 and 3.6, 3.7 exactly. Additional:
- Entry head DOM order follows visual order; for `dateStyle: right`: row 1 `[title ORG_SEP org] … [date]`, row 2 `[location]` right-aligned under the date (flex, `margin-left: auto`); `inline`: `title, org — date · location` in one text flow; `below`: date/location on a muted line under the title; `left`: date in a 22 mm left gutter via `.cv-entry { padding-left: 24mm }` and head grid with `margin-left: -24mm` (no positioning).
- `.cv-section-title` rules for `data-heading-rule`: `below` = bottom border, `above` = top border, `bar` = left border 0.8mm accent + padding-left, `none`.
- `tags`: chips with 0.3 mm border, radius 1 mm; separators ` · ` as muted text; `grid`: 2 columns.
- `timeline`: entry grid `[4mm rail][content]` where the rail is a static cell with a left border and a dot made by `::before` (no text).
- Photo: `img.cv-photo` with width/height = `size` mm, `object-fit: cover`, shape via border-radius, placed left/right of the name block via flex order in DOM (left: before, right: after).
- `layoutPages` must await `document.fonts.ready` and decode the photo before measuring.

- [ ] **Step 1:** Write `scripts/render-check.js` (the failing check).
- [ ] **Step 2:** Run `node scripts/render-check.js` → FAIL (no render code).
- [ ] **Step 3:** Implement render.js, decor.js, pages.js, fit.js, cv.css, index.html, main.js (print mode).
- [ ] **Step 4:** Run `node scripts/render-check.js` → PASS; open `out/sample.pdf` pages count and report JSON in output.

### Task 9: Store, storage and files

**Files:**
- Create: `src/store.js`, `src/io/storage.js`, `src/io/files.js`
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: `markdown.js` (`parse`), `layout.js` (`defaultLayout`, `normalizeLayout`, `migrateFile`, `applyLayoutOps`, `renameSectionIds`), `edits.js` (`applyContentEdits`, `moveSectionSource`), `templates.js` (`applyTemplate`).
- Produces (`store.js`): `createStore({ storage, runPreflight = () => [], now = () => new Date(), locale = 'en-US', debounceMs = 500 }) → Store`. **Refines spec 5.1:** preflight is injected (no static import of rules.js); adds `reveal`.
  - `store.state` (read-only snapshot, spec 5.1 shape plus `reveal: { line, seq } | null`, `warnings: string[]`, `canUndo`, `canRedo`, `docs: [{ id, name, updatedAt }]`)
  - Actions (spec 5.1): `setContent(text)`, `setLayout(ops, { coalesceKey } = {})`, `moveSection(id, toColId, beforeSectionId = null)`, `applyFix(issue) → boolean` (content/layout fixes; returns `false` for `action` fixes and stale content fixes), `applyTemplate(template)`, `select(sel)`, `setCaretLine(n)`, `reveal(line)` (increments `seq`), `setUi(patch)`, `setRender({ report, placement })`, `undo()`, `redo()`, `newDoc()`, `openDoc(id)`, `duplicateDoc()`, `renameDoc(name)`, `deleteDoc(id)`, `loadFile(container, { handle } = {})` (via `migrateFile`; stores `warnings`), `markSaved({ name, savedAt })`, `toContainer() → file container`, `subscribe(fn) → unsubscribe` (`fn(state, changedKeys: Set<string>)`, called synchronously after each action).
  - `newDoc()` uses the skeleton content (spec 5.3 First run) and `defaultLayout(locale in ['en-US','en-CA','es-MX','fr-CA'] ? 'Letter' : 'A4')`.
  - `moveSection`: content via `moveSectionSource` (before `beforeSectionId`, else after the last section placed in `toColId`, else EOF) + `sections[id].column` op — one history entry.
- Produces (`storage.js`):
  - `createMemoryStorage() → StorageAdapter` (for tests and `?print` mode)
  - `createBrowserStorage(ls = localStorage) → StorageAdapter`
  - `StorageAdapter = { listDocs() → [{ id, name, updatedAt }], loadDoc(id) → container | null (corrupt JSON → null), saveDoc(id, container) → { ok: true } | { ok: false, error: 'quota' | 'unknown' }, deleteDoc(id), onExternalChange(fn(id)) → unsubscribe }`
  - `saveFont(family, blob)`, `loadFonts() → Promise<Array<{ family, blob }>>`, `deleteFont(family)` (IndexedDB `recto` / store `fonts`)
  - `registerFonts(list) → Promise<string[]>` (FontFace load + `document.fonts.add`; returns loaded families)
  - `downscalePhoto(file: Blob) → Promise<string /* data URL */>` (≤ 400 px long side, JPEG 0.85; rejects `Error('photo-too-large')` if > 150 KB)
  - `requestPersistence()` (calls `navigator.storage?.persist?.()` once)
- Produces (`files.js`): `canUseFileSystemAccess() → boolean`, `openFile({ accept }) → Promise<{ name, text, handle | null } | null>`, `saveFile({ suggestedName, text, handle }) → Promise<{ handle | null, name }>` (FS Access when available, download fallback), `download(name, data: string | Blob, mime)`, `readFileText(file) → Promise<string>`, `fontsToBase64(list) / base64ToBlob(b64, type)`.

- [ ] **Step 1: Tests** (`test/store.test.js`, memory storage, fake preflight): `newDoc` has skeleton with 4 sections; `setContent` updates `doc`; typing through a rename keeps `sections.experience.variant`; two `setLayout` calls with the same `coalesceKey` → one undo step; `undo` then `redo` restores; text edits within 1 s coalesce (inject `now`); `moveSection` moves source lines and sets column, single undo; `applyFix` content with stale `expect` → returns `false` and content unchanged; `applyTemplate` keeps a `hidden: true` section; `loadFile('garbage')` → usable doc + `warnings` contains `invalid-file`; `saveDoc` quota failure → `state.saveStatus === 'error'`; `duplicateDoc` → new id, name suffixed ` (copy)`; `deleteDoc` removes from index; subscribers get `changedKeys` containing `content` after `setContent`; autosave debounced (inject `debounceMs: 0` and await a tick).
- [ ] **Step 2–4:** fail → implement → `node --test test/store.test.js` PASS.

---

## Wave 3 (UI)

Before Wave 3 the orchestrator writes: `src/ui/dom.js` (`h(tag, props, ...children)`, `$`, `$$`, `on`, `debounce`, `clamp`, `uid`), `src/ui/i18n.js` (`loadLocale(lang) → Promise`, `t(key, vars) → string` returning the key when missing), `styles/app.css` tokens + base components (buttons, inputs, selects, tabs, dialog, toast, `.ui-*` classes), and an `index.html` shell with mount points: `#topbar`, `#editor`, `#canvas`, `#inspector`, `#panels`, `#dialogs`, `#toasts`, and `<link>`s for `styles/app.css`, `editor.css`, `canvas.css`, `inspector.css`.

Shared UI contract (**Refines spec 5**): every UI module exports one `mount*` function taking `(root: HTMLElement, store, ctx)`. `ctx = { t, runPreflight, canvas, editor, toast(msg, { action?: { label, run } }), openDialog(el) → close }` is built in `main.js` (Task 10); `ctx.canvas` / `ctx.editor` are filled after their mounts return. Modules communicate only through store state/actions and these return values.

### Task 10: App shell, top bar, gallery, boot

**Files:**
- Modify: `index.html`, `styles/app.css`, `src/main.js` (keep print mode intact; add app mode)
- Create: `src/ui/topbar.js`, `src/ui/gallery.js`, `locales/_parts/app.json`

**Interfaces:**
- Consumes: `store.js`, `storage.js`, `files.js`, `jsonresume.js`, `plaintext.js`, `ats.js` (`extractText`), `templates.js` (`loadTemplates`, `applyTemplate`), `pages.js` (`createPagesHost`, `layoutPages`), `rules.js` (`runPreflight`), `i18n.js`, `dom.js`, and the mount functions from Tasks 11–13 (`mountEditor`, `mountCanvas`, `mountInspector`, `mountPanels`) imported from `./ui/editor.js`, `./ui/canvas.js`, `./ui/inspector.js`, `./ui/panels.js`.
- Produces: `mountTopbar(root, store, ctx)`, `openGallery(store, ctx, templates)`; app boot in `main.js`: load locale → `createBrowserStorage` → `createStore({ storage, runPreflight, locale: navigator.language })` → open last doc or first run (fetch `samples/sample.cv.json`, `loadFile`, open gallery, first-run note) → register fonts → mount all → responsive tabs (**Write · Design · Check** below 900 px) → keyboard shortcuts (`Cmd/Ctrl+S` save, `Cmd/Ctrl+Shift+S` save as, `Cmd/Ctrl+O` open, `Cmd/Ctrl+P` print via `ctx.canvas.print()`, `Cmd/Ctrl+Z`/`Shift+Z` app undo/redo when focus is not in a text field) → `storage.onExternalChange` banner → `beforeprint`/`afterprint` title swap → Firefox/Safari print checklist (one-time, `localStorage` flag).
- Top bar per spec 5.3: document switcher, Open, Save, Save as, Import (`.cv.json`, `.md`, JSON Resume, paste text dialog), Export (PDF, `.txt`, JSON Resume, `.cv.json` with fonts embedded), Templates, Undo/Redo, preflight badge (click → `store.setUi({ panel: 'check' })`), save status text, light/dark toggle (`data-theme` on `<html>`, stored in `localStorage`).
- Gallery: modal grid of all templates, each with a live page-1 thumbnail of the current content (own shadow host per card via `createPagesHost` + `layoutPages`, scaled with `transform`), name and description; click applies (`store.applyTemplate`) and toasts "Template applied · Undo".

- [ ] **Step 1:** Implement; run `node serve.js`, open the app with the Browser pane / Chrome via `cli/chrome.js`, verify: loads with no console errors, first run shows gallery, applying a template changes pages, Save/Export `.txt` downloads (inspect via `evaluate`), badge shows counts. Record a screenshot to `out/app.png`.

### Task 11: Source editor

**Files:**
- Create: `src/ui/editor.js`, `styles/editor.css`, `locales/_parts/editor.json`

**Interfaces:**
- Consumes: `store` (`state.content`, `state.issues`, `state.reveal`, `setContent`, `setCaretLine`, `select`), `markdown.js` (`parse` line kinds via a local classifier reusing its regexes, `ENTRY_FIELDS`), `dom.js`, `ctx.t`.
- Produces: `mountEditor(root, store, ctx) → { focusLine(line), insert(snippetKind) }`.
- Behaviour (spec 5.3 Left): textarea + highlighted `<pre>` (same font metrics, scroll-synced, `aria-hidden`), line-number gutter with issue markers (severity colour dot, `title` = message), caret-context hint ("Entry · field 3 of 4: date", "Section heading", "Bullet", "Header · contact line"), Insert menu (Section, Entry, Bullet, Rule, Untitled panel, Line break) inserting at caret with the first placeholder selected, `?` syntax popover (grammar table with examples; markup-diagnostic issues link to it), `Tab` inserts two spaces (with `Esc` then `Tab` escaping focus for accessibility), store updates on `input` (the store/canvas handle debouncing), external content changes (undo, fixes, moves) replace the value while keeping the caret line, `reveal` scrolls to and selects the line. Highlighting runs in one pass per input and stays < 5 ms for the sample.

- [ ] **Step 1:** Implement; verify in the browser: typing updates pages, Insert → Entry selects `Job title`, caret hint updates, clicking an issue marker reveals it, `reveal(line)` from the console scrolls correctly.

### Task 12: Canvas, handles, decor tools

**Files:**
- Create: `src/ui/canvas.js`, `src/ui/handles.js`, `src/ui/decor-tools.js`, `styles/canvas.css`, `locales/_parts/canvas.json`

**Interfaces:**
- Consumes: `pages.js` (`createPagesHost`, `layoutPages`), `fit.js` (`fitToPages`), `layout.js` (`columnGeometry`, `contentBox`, `sectionConfig`), `store`, `dom.js`, `ctx.t`.
- Produces: `mountCanvas(root, store, ctx) → { host: ShadowRoot, print(), fit(pages) → Promise<{ reachedFloor }>, evaluate(layout) → Promise<Issue[]> /* off-screen render + preflight via ctx.runPreflight */, relayout() }`. (`ctx.runPreflight` is provided by main.js.)
- Behaviour (spec 5.3 Center): render loop subscribed to `content`/`layout` (text changes debounced 120 ms, layout immediate; never two renders concurrently — coalesce to the latest), `store.setRender`; zoom controls (fit width, 50–200 %) via `transform: scale` on a wrapper; mm rulers; overlay layer (outside `.cv-page`, `display: none` in print) holding: margin handles on 4 edges, gutter/column handles, live mm readouts, snap (1 mm, margins, column edges, page centre; `Alt` disables), section hover outline + grip (drag → `store.moveSection` with drop indicator), click selects section (`store.select`, `store.reveal(line)`), double-click text → `ctx.editor.focusLine(line)`; X-ray mode (`state.ui.xray`) numbers blocks from `state.placement` and dims decor; decor tools (Line, Panel, Ellipse): drag to draw on a page, select, move, resize handles, arrows nudge 1 mm (`Shift` 5 mm), `Delete` removes, `[`/`]` toggles z; every drag = one `setLayout` history entry via `coalesceKey`; `print()` sets zoom 1 for print, calls `window.print()`, restores.
- Overlay geometry: read positions with `getBoundingClientRect()` on shadow elements and convert to the overlay's coordinate space (divide by zoom).

- [ ] **Step 1:** Implement; verify in the browser: drag left margin 16 → 25 mm updates the page and the inspector value, gutter drag changes widths, drag Skills to another column (2-column template) moves the source lines, draw a panel and a line, delete one, X-ray numbers visible, print preview (via `cli/chrome.js` `pdf()` on the app page) has no handles.

### Task 13: Inspector and panels

**Files:**
- Create: `src/ui/inspector.js`, `src/ui/panels.js`, `styles/inspector.css`, `locales/_parts/inspector.json`

**Interfaces:**
- Consumes: `store`, `layout.js` (`PAGE_SIZES`, `THEME_DEFAULTS`, `ENUMS`, `FONT_PRESETS`, `sectionConfig`, `getPath`), `theme.js` (`FONT_STACKS`), `remix.js`, `storage.js` (`saveFont`, `registerFonts`, `downscalePhoto`), `ats.js` (`extractText`, `extractFields`), `files.js` (`download`), `dom.js`, `ctx.t`, `ctx.canvas` (`fit`, `evaluate`), `ctx.editor`.
- Produces: `mountInspector(root, store, ctx)`, `mountPanels(root, store, ctx)`.
- Inspector tabs per spec 5.3 Right (Page, Theme, Section, Decor, CSS). Controls are generated from small field descriptors (`{ path, kind: 'number'|'select'|'color'|'toggle'|'text', min, max, step, options }`) → `store.setLayout([{ path, value }], { coalesceKey: pathKey })`. Color fields: `<input type="color">` + hex text input. Section tab shows the selected section (or a section picker). Decor tab edits the selected decor item. Theme tab: font preset selects + "Upload font" (`saveFont`, `registerFonts`, sets `font:<family>`), density slider, **Fit to N pages** button (`ctx.canvas.fit(targetPages)`; toast when `reachedFloor`), **Remix** (retry ≤ 10 via `ctx.canvas.evaluate`, accept first with zero errors and no new warnings; one history step). Page tab: photo upload via `downscalePhoto` (toast on `photo-too-large`), reading order as a reorderable list.
- Panels: **Check** (issues grouped by severity, message via `ctx.t(issue.msg, issue.vars)`, Locate → `store.reveal(line)` + `store.select({ kind: 'section', id })`; Fix → `store.applyFix(issue)` or, for `action`, `ctx.canvas.fit(issue.fix.pages)`; stale → toast "Content changed; fix no longer applies"), **ATS** (`extractText` with placement and `--- page N ---` markers between pages, detected fields list, Copy / Download `.txt`), switching via `state.ui.panel`.

- [ ] **Step 1:** Implement; verify in the browser: every Page/Theme control changes the page, font upload works with a local `.ttf` via the file input, Fit reduces a 2-page CV to 1, Remix yields a valid look, Check panel Fix buttons work, ATS text shows page markers.

---

## Wave 4

### Task 14: Templates and end-to-end smoke test

**Files:**
- Create: `templates/index.json`, `templates/{classic,modern,minimal,compact,timeline,executive,academic,bold}.json`, `scripts/smoke.js`
- Modify: `samples/sample.cv.json` only if needed to satisfy all templates (keep the same person and sections)

**Interfaces:**
- Consumes: `cli/chrome.js`, `serve.js`, print mode (`?print=/samples/sample.cv.json&template=<id>&report=1`, `window.rectoReady`).
- Produces: 8 template files per spec 5.3 table: `{ id, name, description, targetPages, layout, sectionDefaults }` (no `page.size`, no id-keyed `sections`); `scripts/smoke.js` per spec 12 (exit 1 on failure; prints a table: template, pages, target, lastPageFill, errors, warnings, violations, pdf pages).
- Each template must look distinct and professional; `modern` and `bold` use column `bg` + `bleed`; `executive` uses a decor accent rule; `academic` uses `dateStyle: left`; `timeline` uses `sectionDefaults.experience.variant: 'timeline'`; `compact` targets 1 page with 2 columns; `modern`/`compact`/`bold` put skills/languages/certifications in the side column with `tags`/`grid` variants.

- [ ] **Step 1:** Write `scripts/smoke.js`. **Step 2:** Run → FAIL (no templates). **Step 3:** Write templates, iterate visually (PDFs in `out/`, screenshots via `Page.captureScreenshot`) until every template passes with ≥ 8 % slack. **Step 4:** `node scripts/smoke.js` → PASS.

### Task 15: CLI

**Files:**
- Create: `cli/recto.js`
- Test: `test/cli.test.js`

**Interfaces:**
- Consumes: `cli/chrome.js`, `serve.js`, `markdown.js`, `layout.js` (`migrateFile`, `defaultLayout`), `jsonresume.js`, `ats.js`, `rules.js`.
- Produces: executable `cli/recto.js` (`#!/usr/bin/env node`) implementing spec 10: `export <in> -o <out> [--template id]`, `check <in> [--template id]`, `--help`. Input detection: `.cv.json` (Recto container), `.json` (Recto container if `format === 'recto'`, else JSON Resume), `.md`/`.txt` (Markdown). Output by extension `.pdf`/`.txt`/`.json`. PDF path uses `/__cli/doc.json` via `createServer({ extra })`. Exit codes: 0 ok, 1 preflight errors (check) or page-count mismatch (export), 2 usage/input error; messages on stderr.

- [ ] **Step 1: Tests**: `export sample.cv.json -o x.txt` output starts with `Alex Morgan`; `export … -o x.json` is JSON Resume with `basics.name`; `export sample.md` works; `check` on a doc with a `javascript:` link exits 0 but prints the warning; `check` on a doc with no name exits 1; PDF export test skipped without Chrome, else PDF page count ≥ 1. **Step 2–4:** fail → implement → `node --test test/cli.test.js` PASS.

### Task 16: Docs and open-source packaging

**Files:**
- Create: `README.md`, `CONTRIBUTING.md`, `docs/syntax.md`, `docs/templates.md`, `docs/self-hosting.md`, `docs/cli.md`, `docs/architecture.md`, `Dockerfile`, `.dockerignore`, `.github/workflows/ci.yml`, `.github/workflows/pages.yml`, `test/i18n.test.js`, `test/security.test.js`

**Requirements:**
- README: one-paragraph pitch, features (text-first, canvas, preflight, ATS X-ray, templates, local + hosted, zero deps), quick start (`node serve.js`), hosting, CLI, privacy statement, browser support (Chromium exact, Firefox/Safari best-effort), the note that `file://` is unsupported and that page breaks can differ across OSes unless a custom font is embedded, contributing link, license. A screenshot placeholder must not be used — reference `docs/screenshot.png` only if Task 14/Integration produced one (the orchestrator adds it).
- docs/syntax.md: the full grammar from spec 3.2 with examples; docs/templates.md: template JSON schema, the public styling contract (spec 4.1) and unit rules for custom CSS; docs/self-hosting.md: static hosts, Docker, GitHub Pages; docs/cli.md: commands, exit codes, CI example building a CV PDF; docs/architecture.md: module map, render pipeline, manual QA checklist (spec 12).
- Dockerfile: `FROM nginx:alpine` + `COPY . /usr/share/nginx/html` (+ `.dockerignore` excluding `.git`, `out`, `test`, `docs/superpowers`).
- ci.yml: ubuntu-latest, Node 22, `sudo apt-get install -y fonts-liberation`, `npm test`, `npm run smoke`. pages.yml: deploy the repo root (excluding `test`, `docs/superpowers`, `out`) to GitHub Pages on push to `main`.
- `test/i18n.test.js`: every `RULES` id has `preflight.<id>` in `locales/en.json`; every `DIAG_CODES` code has `diag.<code>`; every `locales/*.json` has exactly the keys of `en.json`; every `t('literal.key'` used in `src/ui/*.js` exists in `en.json` (regex scan).
- `test/security.test.js`: scans `src/**/*.js` — no `innerHTML =`/`outerHTML =`/`insertAdjacentHTML(` with a non-literal argument, no `eval(`/`new Function(`; `index.html` contains the exact CSP from spec 8; hostile Markdown through `parse` produces no `javascript:` hrefs and keeps `<script>` as text.

- [ ] **Step 1:** Write the two tests; **Step 2:** run (i18n test may fail until the orchestrator merges locales — report which keys are missing); **Step 3:** write docs and packaging; **Step 4:** `node --test test/security.test.js` PASS.

---

## Wave 5: Integration QA (orchestrator)

- [ ] Merge `locales/_parts/*.json` into `locales/en.json`; delete `_parts`; `node --test` all green.
- [ ] `node scripts/render-check.js` and `node scripts/smoke.js` green.
- [ ] Drive the app in the Browser pane through spec success criterion 1 (open → template → edit → paste-import → print) and the manual QA checklist; fix defects.
- [ ] Measure budgets: JS + CSS size (`du`), keystroke → render time via `performance.now()` in the console.
- [ ] Independent whole-repo review (multi-lens: correctness, spec compliance, ATS invariants, security, UX) → verify findings → fix.
- [ ] Screenshot for README (`docs/screenshot.png`), final commit.
