# Recto — CV builder design spec

Date: 2026-09-24 · Status: revised after 4-lens adversarial review, awaiting owner review · Working name: **Recto** (rename freely)

## 1. Intent

**What the owner asked for**
- A CV builder built from scratch (inspired by, not forked from, atsresume, Reactive Resume, RenderCV).
- Open source, public-product quality.
- Runs locally with minimal resources **and** is hostable by anyone ("whoever wants local uses local, whoever wants to host can host").
- Fully customizable: move margins, add lines, add panels, "as much customization as possible". Very creative.
- Fool-proof output: **preflight checks** and **ATS-safe output**.
- Content written text-first (Markdown dialect); layout manipulated visually on a live paged canvas.

**Assumptions (not stated by owner)**
- Output is a real-text PDF produced by Chromium's print engine; also `.txt` and JSON Resume exports.
- No accounts, no backend, no telemetry. Data lives in the browser and in files the user saves.
- English UI in v1 with a working i18n mechanism; community adds locales.
- MIT license.

**Success criteria**
1. A new user opens the app, picks a template, edits the sample (or pastes their old CV as text), and prints a correct PDF in under 5 minutes.
2. Every built-in template renders the sample CV with zero preflight errors, within its target page count, with ≥ 8 % slack on the last page (enforced by the smoke test on macOS and Ubuntu).
3. In Chromium (app and CLI) the printed PDF has the same pages and breaks as the canvas. Firefox and Safari are best-effort (the app shows a print checklist there).
4. `pdftotext -raw` of the output contains name, email, phone and every section title, in the order the ATS X-ray shows.
5. Zero runtime and zero dev dependencies, no build step; app JS + CSS ≤ 300 KB uncompressed; keystroke → updated pages ≤ 50 ms for a 2-page CV (excluding the debounce).
6. Works identically from `node serve.js` on localhost and from a static host (GitHub Pages).

**Non-goals (v1)**: accounts/cloud sync, collaboration, AI writing, template marketplace site, docs site, WYSIWYG text editing on the canvas, nested lists, single-file offline build, PWA/service worker, auto-hyphenation, snapshots (use Duplicate), UI locales beyond `en`.

## 2. Deployment modes (local + hosted, same bundle)

The repository root **is** the app: static files, native ES modules, no build.

| Mode | How | Notes |
|---|---|---|
| Local | `node serve.js` → `http://127.0.0.1:8710` | Zero-dep Node stdlib server. Binds 127.0.0.1; `--host`, `--port` flags; on `EADDRINUSE` tries the next port (up to 10) and prints the URL used. Any static server works too. |
| Hosted | Upload the folder to any static host | GitHub Pages workflow included. `Dockerfile` (`nginx:alpine`, copy folder). |
| CLI | `node cli/recto.js export my.cv.json -o cv.pdf` | Headless Chromium via DevTools protocol over a pipe (stdlib only). `.txt`/JSON Resume need no browser. |

No mode has a backend; a hosted instance stores nothing server-side. `file://` is unsupported (browsers block ES modules there); README says so. `package.json` exists only for `npm start` / `npm test` / `npm run smoke` scripts and `"type": "module"`, `"engines": { "node": ">=20" }`.

## 3. Document model

### 3.1 File container: `*.cv.json`

```json
{ "format": "recto", "version": 1, "name": "Jane Doe — Acme",
  "content": "# Jane Doe\n...", "layout": { },
  "fonts": [ { "family": "My Font", "data": "<base64>" } ] }
```
`fonts` is optional and only present in saved/exported files (never in localStorage). `migrateFile(json) → { file, warnings }` runs version migrations (and drops unknown keys such as a legacy `snapshots`), then `normalizeLayout`. Loading never throws on bad input: it returns a usable document plus warnings.

### 3.2 Content: Recto Markdown (strict, line-oriented)

```
# Jane Doe
Staff Platform Engineer
Email: jane@doe.dev · +49 151 0000000 · linkedin.com/in/janedoe · Berlin, DE

## Summary
Engineer who likes boring infrastructure and fast feedback loops.

## Experience {#work}
### Staff Engineer | Acme Corp | Jan 2021 – Present | Berlin
Led the platform group.
- Cut deploy time **70%** by rebuilding CI on ephemeral runners
- Mentored 6 engineers; 3 promoted
---
### Senior Engineer | Globex | 2017 – 2020

## Skills
- **Languages:** Go, Rust, TypeScript
- **Infra:** Kubernetes, Terraform
```

**Line classification** (first match wins, tested in this order):

| # | Pattern | Meaning |
|---|---|---|
| 1 | blank | ends paragraph/list; skipped in header region |
| 2 | `^-{3,}\s*$` | **rule**. In header region → `header.rule = true`. Inside an entry → closes the entry, pushed as section-level `{type:'rule'}`. |
| 3 | `^# ` (space required) | **name**. Only the first; later ones become paragraph text + diagnostic `extra-name`. |
| 4 | `^##(\s\|$)` | **section**. Optional trailing `{#id}` (end of line, `[a-z0-9-]+`). Empty title = untitled section. |
| 5 | `^###(\s\|$)` | **entry**. `####`+ is paragraph text. |
| 6 | `^\s*[-*•] ` | **bullet**. Indentation ignored (flat lists). |
| 7 | `^\s{2,}\S` directly after a bullet line | continuation of that bullet (joined with a space) |
| 8 | other | paragraph line (consecutive lines joined with a space; trailing `\` = hard break `{t:'br'}`) |

- **Header region** = lines after the `#` line and before the first `##`. Each non-blank, non-rule line is taken literally as a header line (bullets/`###` here get diagnostic `header-markup`). No `#` line → `header = null`; lines before the first `##` are ignored with diagnostic `text-before-name`.
- **Header line** split on ` · `, ` | `, ` • ` into parts. A part may start with a label matching `/^\p{L}[\p{L} ]{0,19}:\s*/u` (stored as `label`, rendered as text before the value). If **any** part is contact-like, the line is a **contact line**: every part becomes a contact (non-contact-like parts → kind `text`, e.g. a city). Otherwise it's a **tagline**. `header.contactSep` = first separator found in contact lines (default ` · `).
- **Contact detection is loose, validation is strict.** Email-like: a single token containing `@`. URL-like: has `scheme:`, or starts with `www.`, or matches `^[\w-]+(\.[\w-]+)+(/\S*)?$` **and** (has a `/path` or its last label is lowercase and in `TLDS = com org net io dev app me co ai page site xyz info eu uk de fr es it nl ch at se no dk fi pl in ca au us`). A markdown link `[text](href)` takes its kind from the href scheme. Phone-like: only `+ digits space ( ) - .` with ≥ 7 digits. `valid`: email matches `^[^\s@]+@[^\s@]+\.[^\s@]+$`; URL passes `new URL(href)` with allowed scheme and a host containing `.`; phone always valid.
- Sections whose category is `contact` (see 6.3) also run contact detection over their list items and paragraph parts; `extractFields`, JSON Resume `basics` and contact rules use header contacts first, then these.
- **Entry line**: the raw text after `### ` is split on unescaped `|` *before* inline parsing (pipes inside code/links must be escaped `\|`). Fields trimmed; positional **title | org | date | location**; missing → `[]`/`''`; fields beyond 4 are joined into location with ` | ` + diagnostic `entry-extra-fields`. `date` and `location` are plain text (escapes removed). An entry owns following paragraphs/lists until the next `###`, `##` or `---`.
- **Paragraph** ends at a blank line or any rule/heading/bullet line; a bullet may directly follow a paragraph line. After a bullet, an unindented plain line ends the list and starts a paragraph.
- **Inline**: `**strong**`, `*em*`, `_em_` (only when the outer side of each `_` is not alphanumeric, so `snake_case` is safe), `` `code` ``, `[text](url)`. Bare `http(s)://` URLs and emails autolink; trailing `.,;:!?'"` are excluded, and a trailing `)` is excluded when parentheses are unbalanced. Backslash escapes `\* \_ \[ \] \( \) \| \# \\ \``. Unmatched `**`/`*`/`_` render literally + diagnostic `unclosed-emphasis`. Whitespace runs inside text collapse to one space.
- **Links**: schemes `http`, `https`, `mailto`, `tel` only; a URL-like bare domain gets `https://`. Anything else renders as plain text + diagnostic `unsafe-link`.
- **Never interpreted**: raw HTML (rendered as text), images, tables.
- **Section ids**: explicit `{#id}` reserved first; then `slugify(title)` = NFKD, strip combining marks, lowercase, runs of non-`[a-z0-9]` → `-`, trim `-`, empty → `section`; deduped with `-2`, `-3`, …
- **Dates** — `parseDateRange(text, lang) → null | { start, end, current, style }`:
  - Endpoint formats: `YYYY`, `YYYY-MM`, `MM/YYYY`, `Mon YYYY`, `Month YYYY` (month names via `Intl.DateTimeFormat(lang)` and English, case-insensitive, trailing `.` allowed, `Sept` accepted).
  - Range separators: `–`, `—`, ` - `, `-` between endpoints, `to` / per-language equivalents (`bis`, `à`, `a`).
  - Present-words (per language, see 6.3) → `end: null, current: true`. Single date → `start = end`, `current: false`.
  - `start`/`end` = `{ y, m? }`. `style ∈ 'YYYY' | 'YYYY-MM' | 'MM/YYYY' | 'Mon YYYY' | 'Month YYYY'`, taken from the start endpoint. Unparseable → `null` + diagnostic `unparseable-date` (text still renders).
  - `formatDate(point, style, lang) → string` is the inverse for month-precision styles (used by fixes and JSON Resume import).

**Diagnostic codes** (fixed list): `text-before-name`, `extra-name`, `header-markup`, `unclosed-emphasis`, `unsafe-link`, `entry-extra-fields`, `unparseable-date`. Diagnostics are `{ line, code, vars }`.

### 3.3 AST — the contract every module shares

```js
Doc = {
  header: null | {
    name: string, line: number, rule: boolean, contactSep: string,
    taglines: Array<{ line, inlines: Inline[] }>,
    contacts: Array<Contact>
  },
  sections: Array<{
    id: string, explicitId: boolean, title: string, titleInlines: Inline[], line: number,
    endLine: number,                     // last source line belonging to the section (for moves)
    contacts: Contact[],                 // only filled for category 'contact'
    blocks: Block[]
  }>,
  diagnostics: Array<{ line, code, vars }>
}
Contact = { kind: 'email'|'phone'|'url'|'text', text: string, href?: string, label?: string, valid: boolean, line: number }
Block =
  | { type: 'entry', line, title: Inline[], org: Inline[], date: string, location: string,
      dateRange: null | { start, end, current, style }, blocks: Array<Paragraph|List> }
  | Paragraph = { type: 'paragraph', line, inlines: Inline[] }
  | List      = { type: 'list', line, items: Array<{ line, inlines: Inline[] }> }
  | { type: 'rule', line }
Inline = { t:'text', v } | { t:'br' } | { t:'code', v } | { t:'strong', c } | { t:'em', c } | { t:'link', href, c }
```
Line numbers are 1-based source lines. `markdown.js` exports `parse(source)`, `parseInline(text)`, `inlineText(inlines)`, `slugify(s)`, `parseDateRange(text, lang)`, `formatDate(point, style, lang)`, `detectContact(part)`.

### 3.4 Layout (JSON, version 1). Geometry in **mm**, font sizes in **pt**.

```js
Layout = {
  version: 1,
  lang: 'en',                                   // CV language: dates, present-words, heading dictionary, lang attr
  page: { size: 'A4'|'Letter'|'Legal'|'A5'|'custom', width: 210, height: 297,
          margins: { top: 16, right: 16, bottom: 16, left: 16 }, targetPages: 1 },
  grid: {
    columns: [ { id: 'main', width: 1,          // width in fr; 1–3 columns, visual left→right
                 bg?: '#hex', bleed?: false,     // column background, follows geometry (see 4.5)
                 textColor?, mutedColor?, accentColor? } ],
    gutter: 8,
    headerSpan: 'full' | '<columnId>',
    readingOrder: ['main']                       // DOM/PDF stream order of columns; default: widest first
  },
  header: { align: 'left'|'center'|'right',
            photo: null | { src: 'data:image/jpeg;base64,…', size: 28, shape: 'circle'|'rounded'|'square', position: 'left'|'right' } },
  theme: ThemeTokens,                            // 3.5
  sectionDefaults: { [category | '*']: Partial<SectionConfig> },   // copied from the applied template
  sections: { [sectionId]: Partial<SectionConfig> },               // per-section overrides
  decor: DecorItem[],                            // 3.7
  customCss: ''
}
SectionConfig = {
  column: '<columnId>', hidden: false,
  variant: 'list'|'compact'|'timeline'|'tags'|'grid',
  showTitle: true, ruleAbove: false, ruleBelow: false,
  breakBefore: false, keepTogether: true,        // keepTogether: keep each entry on one page when possible
  panel: null | { bg: '#f4f4f5', border: 'none'|'solid'|'dashed', borderColor: '#e4e4e7', borderWidth: 0.3, radius: 2, padding: 3 }
}
```
- `PAGE_SIZES = { A4: [210, 297], Letter: [215.9, 279.4], Legal: [215.9, 355.6], A5: [148, 210] }`.
- Clamps: margins 0–60, gutter 0–40, column width 0.2–5, page 80–600, `targetPages` 1–10, decor geometry −50…page+50, strings ≤ 20 000 chars (customCss ≤ 50 000), colors `^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$`i.
- **There is no section `order`.** Within a column, sections appear in Markdown source order. Moving a section is a content edit (5.2).
- `sectionConfig(layout, section) → SectionConfig` = shallow merge of `SECTION_DEFAULTS` ← `sectionDefaults['*']` ← `sectionDefaults[categorize(section.title, layout.lang)]` ← `sections[section.id]` (panel merged as a whole). `SECTION_DEFAULTS.column` = first grid column; a column id not in the grid resolves to `readingOrder[0]`. **Only this function resolves section config.**
- `placeSections(doc, layout) → { [colId]: Array<{ section, config }> }` — excludes hidden sections, keeps source order.
- `renameSectionIds(prevDoc, nextDoc, layout) → layout`: if the id list changed by exactly one removed and one added id at the same index, move `sections[old]` to `sections[new]`.
- `applyLayoutOps(layout, ops) → layout`: `ops = [{ path: (string|number)[], value }]`; each op sets the value at the path (creating objects as needed; `value: undefined` deletes the key), then `normalizeLayout`. Every inspector edit, drag and layout fix uses this.
- `defaultLayout(size = 'A4')` returns a fresh default (1 column, `neo-grotesque`, target 1). The store passes `'Letter'` for new docs when `navigator.language` is `en-US`/`en-CA`/`es-MX`/`fr-CA`.

### 3.5 Theme tokens

| Token | Default | Clamp / enum |
|---|---|---|
| fontBody, fontHeading | `'neo-grotesque'` | preset key or `font:<family>` |
| fontMono | `'mono'` | same |
| sizeName / sizeSection / sizeEntry / sizeBody / sizeSmall | 24 / 11 / 10.5 / 9.75 / 8.75 pt | 6–48 |
| lineHeight | 1.35 | 1.0–2.0 |
| gapParagraph / gapEntry / gapSection | 1.2 / 3 / 5 mm | 0–20 |
| density | 1 | 0.7–1.2 |
| colorText / colorMuted / colorAccent / colorRule / colorPage | `#111827` / `#4b5563` / `#1d4ed8` / `#d1d5db` / `#ffffff` | hex |
| colorHeading | `'accent'` | `'accent'`, `'text'` or hex |
| headingCase | `'upper'` | `none`, `upper`, `small-caps` |
| headingLetterSpacing | 0.06 em | **0–0.08** (wider breaks text extraction) |
| headingWeight / nameWeight | 700 / 700 | 300–900 |
| headingRule | `'below'` | `none`, `below`, `above`, `bar` |
| nameCase | `'none'` | `none`, `upper` |
| bulletChar | `'•'` | `•`, `◦`, `▪`, `–`, `-`, `·`, `''` |
| dateStyle | `'right'` | `right`, `inline`, `below`, `left` |
| linkStyle | `'plain'` | `plain`, `underline`, `accent` |

- `density` multiplies gaps and `(lineHeight − 1)`, and scales font sizes by `1 + (density − 1) × 0.35`. Applied inside `themeToCss`.
- `headingCase: small-caps` is faux: `text-transform: uppercase; font-size: 0.82em`. Never `font-variant: small-caps` / `smcp` (real smcp glyphs extract as garbage in some parsers).
- **Font presets** (system stacks, CC0 "modern font stacks", each ending in metric-compatible fallbacks so pagination is stable across OSes): `system-ui`, `neo-grotesque`, `humanist`, `geometric`, `transitional`, `old-style`, `didone`, `slab`, `mono`. Sans stacks end `…, Arial, 'Liberation Sans', Arimo, sans-serif`; serif `…, 'Times New Roman', 'Liberation Serif', Tinos, serif`; mono `…, 'Courier New', 'Liberation Mono', Cousine, monospace`.
- **Custom fonts**: upload `.woff2/.woff/.ttf/.otf` → IndexedDB → `new FontFace(family, buffer)` → `await face.load()` → `document.fonts.add(face)` before the first render. Referenced as `font:<family>`, emitted as a quoted, escaped CSS string. Embedded (base64) only in saved/exported files.
- **Remix** (`src/model/remix.js`, pure, takes a `rand()` function): picks a heading/body preset pair, an accent from a curated list of 12, and random `headingCase`/`headingRule`/`bulletChar`/`nameCase`; returns layout ops. The UI retries (≤ 10) until preflight has zero errors and no new warnings. Keeps content, page and grid. One undo step.

### 3.6 Section variants

- `list` — default: entry head (title, org, date, location per `dateStyle`), paragraphs, bullets.
- `compact` — entry head on one line: **title**`, `org` — `date (separators are real text nodes).
- `timeline` — entries hang off an accent line with dots, built from a narrow static grid cell with borders/background (no positioning).
- `tags` — each list item splits on `,` into chips with a visible muted ` · ` text node between chips; a leading `**Label:**` becomes a group label.
- `grid` — list items in two columns; `**Label:** value` aligns labels.

In `tags` and `grid` the whole list is **one atom** (items share lines/rows). Everywhere else each bullet is its own atom. Variants never change the DOM text order.

### 3.7 Decor layer (ornaments: lines and panels anywhere)

```js
DecorItem = { id, kind: 'rect'|'line'|'ellipse', pages: 'all'|'first'|'rest'|number[],
  x, y, w, h,                      // mm from page top-left; line = (x,y)→(x+w,y+h)
  fill: '#hex'|null, stroke: '#hex'|null, strokeWidth: 0.5, radius: 0, opacity: 1, z: 'back'|'front' }
```
Rendered in an `aria-hidden` SVG per page (vector in the PDF), which also paints column backgrounds. Decor never contains text. Sidebar backgrounds use `columns[i].bg` (which follows margins/gutter/page size), not decor.

## 4. Rendering, pagination and print

### 4.1 Public styling contract (stable within a major version; used by render.js, cv.css, templates, the canvas, and users' custom CSS)

```
.cv-pages[lang]                                   container of all pages (inside the shadow root)
  .cv-page[data-page=N]                            position: relative; isolation: isolate
    svg.cv-decor.cv-back / svg.cv-decor.cv-front   decor + .cv-col-bg rects (aria-hidden)
    .cv-page-grid
      .cv-header                                   page 1 only
        img.cv-photo  h1.cv-name  p.cv-tagline  .cv-contacts > .cv-contact[data-kind] (+ separator text)
      .cv-col[data-col=ID]
        .cv-section[data-section][data-category][data-variant]  (+ .cv-panel when panel is set)
          h2.cv-section-title
          .cv-entry > .cv-entry-head > .cv-entry-title .cv-org .cv-date .cv-location
                    > p.cv-p  ul.cv-list > li.cv-li
          p.cv-p  ul.cv-list > li.cv-li  hr.cv-rule
          .cv-tags > .cv-tag-group > .cv-tag-label .cv-tag      (tags variant)
          .cv-grid > .cv-grid-item > .cv-label                  (grid variant)
```
- Every atom root has `data-atom=<kind>` and `data-line=<source line>`.
- Fragment classes: `.cv-first` on the first atom of a page column and on every wrapper re-opened there (`margin-top: 0`); `.cv-cont-prev` / `.cv-cont-next` mark a wrapper fragment continuing from / onto another page (styling hooks only, no geometry change). Every wrapper fragment is a complete closed box (full padding, border, radius).
- Theme tokens → CSS custom properties `--cv-<kebab-token>` on `.cv-pages` (e.g. `--cv-font-body`, `--cv-size-body: 9.75pt`, `--cv-gap-entry: 3mm` after density, `--cv-bullet-char: "•"`). Per-column overrides `--cv-col-text/muted/accent` on `.cv-col`. cv.css uses only these variables.
- Units in cv.css, themeToCss and templates: `pt`, `mm`, `em` or unitless only. Never `rem`, `vh`, `vw`, or `%` heights.

### 4.2 ATS paint invariant

Chromium writes PDF text in **paint order**, not DOM order. Inside `.cv-page`, every element that contains text stays in normal flow and is static: no `float`, no `position` other than `static`, no `transform`, `opacity < 1`, `z-index`, `filter`, or `order`. All placement uses flex/grid with DOM order = visual order (right-aligned dates via `margin-left: auto`; timeline dot/line via a static grid cell). Only these may be positioned: `.cv-page` itself, the decor SVGs (`position: absolute; z-index: -1` back, `1` front), and pseudo-elements without letters or digits in `content`. Canvas affordances (grips, selection, X-ray numbers, dimming) live in an overlay layer **outside** `.cv-page` and are `display: none` in print. Separators between contacts, tags and compact fields are real, visible text nodes (flex `gap` alone leaves no character). The smoke test fails if any text-bearing element inside a page has a forbidden computed style.

### 4.3 Pipeline

`layoutPages(doc, layout, host: ShadowRoot) → Promise<{ pages: HTMLElement[], report: RenderReport, placement: Placement }>` (in `src/render/pages.js`). On every change (debounced 120 ms for text, immediate for drags):

1. `renderAtoms(doc, layout) → { header: HTMLElement|null, columns: { [colId]: Atom[] } }` (`src/render/render.js`, DOM creation only via `createElement`/`textContent`, never `innerHTML` with user data).
   `Atom = { el, kind: 'title'|'entry-head'|'p'|'li'|'list'|'rule', sectionId, line, keepWithNext, group: string|null, breakBefore, wrap: Array<{ key, el }> }`. `wrap` runs outer→inner (section, entry, list); `el` is an empty shallow template cloned once per fragment; consecutive atoms with the same `key` share one clone. Section titles and entry heads are `keepWithNext`. `group = '<sectionId>:<entryIndex>'` when `keepTogether`. `breakBefore` on a section's first atom when its config says so.
2. **Measure.** A hidden measurer page built by the same builder (same grid template, classes and stylesheet stack: cv.css + theme vars + customCss), inside the same shadow root, `position: absolute; left: -99999px; visibility: hidden`, rows `auto`, never under the zoom transform. Each column's atoms are laid out continuously. Using fractional `getBoundingClientRect()`:
   - `h[i]` = top(atom i+1) − top(atom i) (last atom: its `hEnd`);
   - `hEnd[i]` = own border-box height + padding-bottom + border-bottom of every wrapper containing it;
   - `hStart[i]` = padding-top + border-top of every wrapper containing it.
   CV CSS uses only `margin-top` for vertical spacing and every wrapper is `display: flow-root`, so margins never collapse through wrappers.
3. **`paginate(input) → { pages, flags }`** (`src/render/paginate.js`, pure):
   - `input = { columns: { [colId]: Array<{ h, hStart, hEnd, keepWithNext, group, breakBefore }> }, capacityFirst: { [colId]: px }, capacityRest: px, capacityOverride?: { [pageIndex]: { [colId]: px } }, epsilon: 0.5 }`.
   - Used height of a page column = `hStart[first] + Σ h[first..last−1] + hEnd[last]` ≤ capacity + epsilon.
   - Consecutive atoms joined by `keepWithNext` and atoms sharing a `group` form a **chunk**. Chunks are placed greedily; a chunk that doesn't fit moves to the next page; `breakBefore` starts a new page.
   - The first chunk on a page is always placed: if it is taller than the capacity it is split at atom boundaries (flag `forced-split`); a single atom taller than the capacity is placed alone (flag `overflow`). So no page is ever empty and the algorithm always terminates.
   - Columns flow independently; page count = max over columns.
   - Output: `pages: Array<{ [colId]: number[] }>` (atom indices), `flags: Array<{ kind: 'overflow'|'forced-split', page, colId, atom }>`.
4. **Build pages.** `.cv-page { box-sizing: border-box; width: Wmm; height: Hmm; padding: <margins> }`, `.cv-page-grid { display: grid; height: 100%; grid-template-columns: minmax(0, w1fr) …; column-gap: <gutter>mm }` with rows `auto minmax(0, 1fr)` on page 1 (header in row 1, `grid-column: 1 / -1` for `full` or the named column; other columns `grid-row: 1 / -1`) and `minmax(0, 1fr)` on later pages. Column cells: `min-width: 0; min-height: 0; overflow: hidden` on screen, `overflow: visible` in print (a reflowed line spills into the margin instead of vanishing). `capacityFirst[col]` = content height − (header border-box height + header margin-bottom) for columns under the header. Links and contacts get `overflow-wrap: anywhere`.
5. **Verify.** For each page column check `scrollHeight > clientHeight + 1`. On the first overflowing (page p, column c) rerun `paginate` with `capacityOverride[p][c] = capacity − (scrollHeight − clientHeight) − 1`, rebuild, re-verify. A page column holding only an `overflow` atom is exempt. After 5 passes keep the result and add a `verify-failed` flag. Capacities only shrink, so this terminates.
6. **Report.**
```js
RenderReport = {
  pageCount, targetPages,
  lastPageFill,            // 0–1: max over columns of used ÷ capacity on the last page
  flags: Array<{ kind: 'overflow'|'forced-split'|'verify-failed', page, colId, sectionId: string|null, line }>,
  textStyles: Array<{      // one per atom per distinct style
    sectionId: string|null, line, page, role: 'name'|'heading'|'body'|'small',
    sizeToken: 'sizeName'|'sizeSection'|'sizeEntry'|'sizeBody'|'sizeSmall'|null, fontSizePt,
    color, colorPath: (string|number)[]|null,   // layout path the colour came from; null = custom CSS
    background, family }>, // background = opaque hex composited bottom-up: colorPage → column bg → back decor intersecting the atom box (fill × opacity) → section panel bg
  fontsMissing: string[],  // 'font:<family>' with no loaded FontFace of that family (never use document.fonts.check)
  pages: Array<{ firstText, lastText, columnsWithText: string[] }>
}
Placement = Array<{ page, colId: string|null, sectionId: string|null, line, kind }>   // every rendered atom in stream order; the header is { page: 1, colId: null, kind: 'header' }
```
All `page` fields in flags, report, placement and issues are **1-based**; `paginate`'s `pages` array index is 0-based.

### 4.4 Isolation, zoom, fonts

- Pages live in a **shadow root**. cv.css starts with `:host { all: initial; display: block; }` and then sets font family/size (pt), line-height, color, `color-scheme: light`, `-webkit-text-size-adjust: 100%` explicitly, so the app's inherited styles never leak in.
- Zoom = `transform: scale(z)` on a light-DOM wrapper around the host. Never CSS `zoom`. Verify uses `scrollHeight/clientHeight` (layout space, unaffected by transform).
- `document.fonts.addEventListener('loadingdone', relayout)`. The photo `<img>` always has explicit width/height in mm.
- `lang` attribute on `.cv-pages` from `layout.lang`. `hyphens: manual` everywhere.

### 4.5 Column backgrounds

For each column with `bg`, the back SVG paints a rect computed from live geometry on every page: inner edges at the gutter midpoint; outer edges (top, bottom, outer side) reach the page edge when `bleed`, otherwise the column box + 4 mm clamped to the page.

### 4.6 Printing

No cloning. The shadow host itself is printed.
- A light-DOM `<style id="recto-page">` in `<head>` holds `@page { size: Wmm Hmm; margin: 0 }`, rewritten on every render (`@page` is ignored inside shadow roots).
- app.css `@media print`: hide all app UI and overlays; on the host and its ancestors `transform: none; margin: 0; padding: 0; display: block`; `html, body { margin: 0; background: none }`.
- cv.css `@media print`: `.cv-pages { display: block; gap: 0 }`; `.cv-page { margin: 0; box-shadow: none; break-inside: avoid; break-after: page; overflow: hidden; print-color-adjust: exact; -webkit-print-color-adjust: exact }`; `.cv-page:last-child { break-after: auto }`.
- `beforeprint` sets `document.title = '<Name> — CV'` (PDF title); `afterprint` restores it.
- Firefox/Safari: the Print button first shows a one-time checklist (paper size, scale 100 %, headers & footers off, background graphics on).

### 4.7 Print mode (for the CLI and smoke test)

`?print=<relative url of a .cv.json>[&template=<id>][&report=1]`: fetches the document, applies the template if given, renders pages only (no app UI, zoom 1), skips localStorage. Exposes `window.rectoReady`: a promise resolving to `{ report, issues, placement }` after the doc fetch, template application, every embedded `FontFace.load()`, `document.fonts.ready`, photo `img.decode()`, and render + verify. Fit is `src/render/fit.js`: `fitToPages(doc, layout, host, pages) → Promise<{ density, reachedFloor }>` binary-searches `density` (8 iterations) for the largest value that fits `pages`, never letting body text go below 9 pt (then `reachedFloor: true`).

## 5. The app

### 5.1 Store (`src/store.js`)

```js
state = {
  docId, name, content, layout,
  doc, report, issues, placement,             // derived
  selection: null | { kind: 'section', id } | { kind: 'decor', id },
  caretLine: number,
  file: null | { name, savedAt },             // File System Access handle kept privately
  saveStatus: 'browser' | 'file' | 'error',   // 'Saved in browser · not saved to a file' / 'Saved to <file> at hh:mm'
  ui: { zoom, xray, tab, panel, dialog }
}
```
Actions: `setContent(text)` (parses synchronously, then `renameSectionIds`), `setLayout(ops, { coalesceKey })`, `moveSection(id, toColId, beforeSectionId|null)`, `applyFix(issue)`, `applyTemplate(template)`, `select(sel)`, `setCaretLine(n)`, `setUi(patch)`, `setRender({ report, placement })` (runs `runPreflight`, stores `issues`), `undo()`, `redo()`, `newDoc()`, `openDoc(id)`, `duplicateDoc()`, `renameDoc(name)`, `deleteDoc(id)`, `loadFile(container, handle?)`, `subscribe(fn(state, changedKeys: Set)) → unsubscribe`.

- **History**: `{ content, layout }` snapshots, 100 steps; text edits coalesce within 1 s; consecutive `setLayout` calls with the same `coalesceKey` (a drag) replace the top entry. Inside the textarea `Cmd/Ctrl+Z` is native text undo; elsewhere it is app undo.
- **Who renders**: `src/ui/canvas.js` subscribes to `content`/`layout`, calls `layoutPages`, then `store.setRender`.

### 5.2 Content edits made by the app

- `applyFix` content edits: `{ kind: 'content', edits: [{ line, expect, text }] }` replaces whole 1-based line `line` only if its current text equals `expect` (else the fix is shown as stale); `text: null` deletes the line. Edits apply bottom-up as one undo step, then re-parse.
- `moveSection`: moves the section's source lines (`line`…`endLine`) to just before the `##` line of `beforeSectionId`, or after the last section placed in `toColId` (EOF if none); if `toColId` differs, sets `sections[id].column` in the same history step.
- `applyTemplate(layout, template) → layout` (in `templates.js`): start from `defaultLayout()`, deep-merge `template.layout` (grid, theme, header.align, page.margins, decor), set `sectionDefaults = template.sectionDefaults`; keep from the old layout `lang`, `customCss`, `header.photo`, `page.size/width/height/targetPages`; reset `sections` to `{}` keeping only `hidden: true` flags; normalize. One undo step, toast "Template applied · Undo". Template files never set page size or id-keyed section config.

### 5.3 Layout of the UI

Three resizable panes; below 900 px they become tabs **Write · Design · Check**.

**Left — Source editor** (`src/ui/editor.js`). `<textarea>` over a highlighted `<pre>` (headings, entry fields coloured per position, bullets, emphasis, links, rules), line-number gutter with issue markers, caret-context hint line under the editor (e.g. "Entry · field 3 of 4: date"). **Insert menu** (Section, Entry, Bullet, Rule, Untitled panel, Line break) inserts a snippet at the caret with the first placeholder selected (entry snippet: `### Job title | Organisation | Jan 2024 – Present | City`). **`?` Syntax popover** shows the 3.2 grammar with one example per row; every markup diagnostic links to it. Caret line ↔ canvas selection sync.

**Center — Canvas** (`src/ui/canvas.js`, `src/ui/handles.js`, `src/ui/decor-tools.js`).
- Zoom (fit width, 50–200 %), mm rulers.
- **Margin handles** (4 edges), **gutter/column-width handles**, live mm readouts, snap to 1 mm / margins / column edges / page centre (`Alt` disables). One history entry per drag.
- Click a section → select (inspector shows it, editor jumps to its line). Hover grip → drag to reorder or move to another column with drop indicators (`moveSection`).
- **Decor tools**: Line, Panel (rect), Ellipse. Drag to draw; handles to resize; arrows nudge 1 mm (`Shift` 5 mm); `Delete` removes; `[`/`]` toggle z.
- **ATS X-ray** toggle: dims decor, numbers blocks in stream order (from `placement`).
- Double-click text → focus editor at that line.

**Right — Inspector** (`src/ui/inspector.js`) tabs: **Page** (size, W×H, margins, target pages, columns add/remove/width/bg/bleed/colours, gutter, header span and alignment, photo upload/remove, reading order), **Theme** (fonts with presets + upload, sizes, spacing, colours, heading style, bullet, dates, links, density slider, **Fit to N pages**, **Remix**), **Section** (selected section's config), **Decor** (selected item geometry, pages, colours, stroke, radius, opacity, z), **CSS** (custom CSS). Every drag has a numeric equivalent here.

**Right — Panels** (`src/ui/panels.js`): **Check** (issues errors→warnings→info, each with Locate and **Fix** when available; stale fixes greyed), **ATS** (stream-order text with `--- page N ---` markers, detected fields, Copy / Download `.txt`).

**Top bar** (`src/ui/topbar.js`): document switcher (new, duplicate, rename, delete with a confirm naming the document), Open file, Save (`Cmd/Ctrl+S`; File System Access API in Chromium, download elsewhere), Save as, Import (`.cv.json`, `.md`, JSON Resume, **Paste text from an existing CV**), Export (PDF via print, `.txt`, JSON Resume, `.cv.json`), Templates gallery (`src/ui/gallery.js`, live thumbnails of the current content), Undo/Redo, preflight badge (`2 errors · 3 warnings`), save status, light/dark UI.

**First run**: loads `samples/sample.cv.json`, opens the gallery, and shows a one-time note "Your CV lives in this browser. Save to a file to keep a copy." **New** creates a skeleton (name, contact line, Summary/Experience/Education/Skills with one placeholder entry each), never an empty document.

**Templates (8)** in `templates/<id>.json`, listed in `templates/index.json`: `{ id, name, description, targetPages, layout: Partial<Layout>, sectionDefaults }`.

| id | Look |
|---|---|
| classic | 1 column, transitional serif, centered header, faux small-caps headings with rule |
| modern | left sidebar via column `bg` + bleed, sans, accent colour, skills as tags, header over main column |
| minimal | 1 column, neo-grotesque, generous whitespace, muted headings |
| compact | dense 2 columns (main + narrow right), fits a lot on one page |
| timeline | 1 column, experience as timeline |
| executive | old-style serif, large name, accent rule decor at top |
| academic | 1 column serif, dates in the left gutter (`dateStyle: left`) |
| bold | dark full-height left sidebar (column `bg` + bleed, light column text colours), geometric sans |

## 6. Fool-proofing

### 6.1 Preflight

`runPreflight({ source, doc, layout, report, placement, now, lang }) → Issue[]` in `src/preflight/rules.js` — pure, Node-testable. `report`/`placement` may be `null` (CLI without a browser): report-dependent rules are skipped.

```js
Issue = { rule, severity: 'error'|'warn'|'info', msg: 'preflight.<rule>' | 'diag.<code>', vars,
          line?, sectionId?, page?, fix? }
fix = { kind: 'content', edits: [{ line, expect, text }] }
    | { kind: 'layout', ops: [{ path, value }] }
    | { kind: 'action', action: 'fit-pages', pages }
```
i18n: message key `preflight.<rule>`, fix button label `preflight.<rule>.fix`, diagnostics `diag.<code>`. A test asserts every rule id and diagnostic code has its keys in `en.json`. A content fix is offered only when the change fits in one source line.

**Content rules** (no render needed)

| Rule | Sev | Check | vars | Fix |
|---|---|---|---|---|
| missing-name | error | no `#` line | | — |
| missing-email | warn | no valid email contact (header, then contact sections) | | — |
| missing-phone | info | no phone contact | | — |
| invalid-email | error | email-like contact not valid | value | — |
| invalid-url | warn | URL-like contact not valid | value | — |
| phone-format | info | phone without leading `+` | value | — |
| entry-date | warn | experience/education/volunteering entry with empty or unparseable date | title | if another field parses as a date range, move it to field 3 |
| date-format-mixed | info | >1 month-precision style across entries (`YYYY` exempt) | styles | rewrite field 3 to the majority month style; never touches year-only dates; other fields byte-for-byte |
| date-order | error | end before start | title | — |
| date-future | warn | start after `now` | title | — |
| not-reverse-chronological | info | entries in a section not newest-first | section | — |
| bullet-too-long | info | > 200 chars | length, max | — |
| too-many-bullets | info | > 6 bullets in one entry | count, max | — |
| bullet-punctuation-mixed | info | some bullets end with `.`, some don't (excluding bullets ending in `? ! : ) …`, a link, code, a URL, an initial, or an abbreviation `etc. Inc. Ltd. Co. Corp. e.g. i.e. vs. Jr. Sr.`) | | add/remove exactly one `.` at the end of the last text inline |
| repeated-word | info | same letters-only word twice in a row within one text inline (skip `that that`, `had had`, both-capitalized pairs) | word | remove duplicate |
| invisible-characters | warn | U+00AD, U+200B–U+200D, U+2060, U+FEFF | count | delete them |
| special-characters | warn | `\p{Extended_Pictographic}` (minus ©®™), Private Use Area, U+2600–27BF, U+25A0–25FF. Never flags `• · – — … ‘ ’ “ ” → ×` | chars | — |
| empty-section | warn | section with no blocks | section | — |
| untitled-section | warn | non-empty section rendered without a title (empty title or `showTitle: false`) | section | `showTitle: true` when the title is non-empty |
| markup-diagnostic | warn | each parser diagnostic (`msg: diag.<code>`) | per code | — |
| nonstandard-heading | info | heading not in the CV-language dictionary | title | — |
| hidden-link-target | warn (header) / info (body) | normalized link text ≠ normalized href (strip scheme, `mailto:`, `tel:`, `www.`, trailing `/`; digits only for tel) | text, href | header: replace the `[text](href)` span with the normalized href; body: append ` (<normalized href>)` |
| photo-present | info | `header.photo` set | | — |
| custom-css | info | `customCss` non-empty | | — |
| margin-too-small | warn | any margin < 7 mm | side, value, min | set that margin to 10 |
| line-height-tight | warn | lineHeight < 1.15 | value | set 1.25 |

**Render rules** (need `report` / `placement`)

| Rule | Sev | Check | vars | Fix |
|---|---|---|---|---|
| page-overflow | error | `overflow` or `verify-failed` flag | page | locate |
| pages-over-target | warn | `pageCount > targetPages` | pages, target | fit-pages `targetPages` |
| sparse-last-page | info | `pageCount > 1` and `lastPageFill < 0.15` | fill | fit-pages `pageCount − 1` |
| forced-split | info | `forced-split` flag | page | — |
| font-too-small | warn / error | role body/heading/name: < 9 / < 7.5 pt; role small: < 8 / < 7 pt | size, min | set the `sizeToken` to 9 (small: 8) |
| low-contrast | warn (< 4.5) / error (< 3) | WCAG ratio of `color` vs `background` | ratio, min | set `colorPath` to `#000000` or `#ffffff`, whichever passes |
| missing-font | warn | `fontsMissing` non-empty | family | — |
| multi-column | warn | any page has text in ≥ 2 columns | order | — (message names stream order, suggests a 1-column template for ATS-heavy applications) |
| column-interrupts-entry | warn | an entry in `readingOrder[0]` continues from page N to N+1 while a later column has text on page N | title | locate |

### 6.2 ATS output (`src/preflight/ats.js`)

- `extractText(doc, layout, placement?) → string`. With placement: page by page, in stream order (page 1 header, then each column in `readingOrder`), which is what a content-stream extractor sees. Without placement (`.txt` export, CLI without browser): logical order (header, then columns in `readingOrder`, each in source order); the ATS panel labels this "logical order". Separator strings come from the same helper the renderer uses.
- `extractFields(doc, layout) → { name, label, emails, phones, urls, location, sections: [{ id, title, category, entries: [{ title, org, start, end, current, location, bullets }] }] }`.

### 6.3 Heading dictionary (`src/model/categories.js`)

`categorize(title, lang) → category | null` for `summary, experience, education, skills, projects, certifications, awards, publications, languages, volunteering, interests, references, contact`, with synonyms in **en, de, fr, es** (case- and diacritic-insensitive, trailing `:` ignored). `PRESENT_WORDS`: en `present, current, now, today, ongoing`; de `heute, aktuell, jetzt, bis heute`; fr `présent, aujourd'hui, actuel, en cours`; es `presente, actualidad, actual, hoy`. `RANGE_WORDS`: en `to`, de `bis`, fr `à`, es `a`.

### 6.4 JSON Resume (`src/io/jsonresume.js`)

`toJsonResume({ content, layout }) → { json, warnings }`; `fromJsonResume(json) → { content, layout, warnings }`.

Export: all strings via `inlineText`; the first link in title/org → `url`; bullets → `highlights`; paragraphs → `summary` (joined `\n`); current role omits `endDate`; unparseable dates omitted and named in warnings; dates ISO `YYYY` / `YYYY-MM`.

| Category | JSON Resume |
|---|---|
| experience | `work { position: title, name: org, location, startDate, endDate, summary, highlights }` |
| volunteering | `volunteer { position, organization: org, startDate, endDate, summary, highlights }` |
| education | `education { area: title, institution: org, startDate, endDate, courses: bullets }` (studyType not guessed) |
| projects | `projects { name, entity: org, description, highlights, startDate, endDate, url }` |
| awards | `awards { title, awarder: org, date: start, summary }` |
| certifications | `certificates { name, issuer: org, date: start, url }` |
| publications | `publications { name, publisher: org, releaseDate: start, url, summary }` |
| skills, interests | `**L:** a, b` → `{ name: L, keywords: [a, b] }`; unlabeled → `{ name, keywords: [] }`; an entry → `{ name: title, level: org, keywords: bullets }` |
| languages | `**German:** Native` → `{ language, fluency }` |
| references | entry → `{ name: title, reference: summary }` |
| summary | `basics.summary` (paragraphs joined `\n\n`) |

`basics`: name, label (first tagline), email, phone, url (first non-profile URL), location (first `text` contact split at its last comma → `{ city, region }`), profiles (linkedin, github, gitlab, x/twitter, stackoverflow, medium, behance, dribbble → `{ network, username: last path segment, url }`). Sections with no category or category `contact` are not exported (warned). Export writes `meta.recto = { content, layout }`.

Import: accepts v0 aliases (`company` → name, `website` → url); backslash-escapes `\ * _ [ ] | `` ` in generated strings and a leading `#`, `- `, `* `, `• `, `---`; newlines inside highlights → spaces. `meta.recto` is used only if `toJsonResume(meta.recto)` (without `meta`) deep-equals the file's non-meta fields; otherwise rebuild from fields, keep `meta.recto.layout`, and warn "edited outside Recto — rebuilt from JSON Resume fields".

### 6.5 Paste-text import (`src/io/plaintext.js`)

`fromPlainText(text, lang) → content`: first non-empty line → `# `; lines among the next 5 containing a detected contact → contact line; short lines that `categorize()` recognizes (trailing `:` stripped, any case) or that are ALL CAPS and ≤ 4 words → `## `; lines starting with `• ▪ ● ○ ■ – - * ·` → `- `; everything else → paragraphs. The editor then shows a banner: "Imported — check entry lines (### title | org | date | location)".

## 7. Storage (`src/io/storage.js`, `src/io/files.js`)

- localStorage: `recto:index` → `[{ id, name, updatedAt }]`; `recto:doc:<id>` → container without `fonts`. Autosave debounced 500 ms.
- IndexedDB `recto`, store `fonts` (uploaded font blobs).
- Photo uploads: downscaled via canvas to ≤ 400 px on the long side, JPEG q 0.85; rejected if still > 150 KB.
- `navigator.storage.persist()` on first edit.
- Quota error → persistent banner offering **Export now**; nothing is silently lost.
- A `storage` event for the open document → banner "Changed in another tab: Reload / Keep mine".
- File System Access handle kept in memory per open document; save status shown in the top bar.

## 8. Security and privacy

- CSP meta: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`. No request ever leaves the origin; custom CSS `url(https://…)` is blocked.
- Markdown never produces raw HTML; link schemes allow-listed; imported files normalized.
- A test feeds hostile Markdown (`<script>`, `javascript:` links, `<img onerror>`) and asserts only allowed tags/attributes appear; a DOM-free check asserts `src/render` and `src/ui` never assign `innerHTML` from non-literal values.
- `serve.js` blocks path traversal, serves no directory listings, and sets correct MIME types.

## 9. i18n

UI strings in `locales/en.json` (flat keys), `t(key, vars)` in `src/ui/i18n.js`, fallback `en`. A test asserts every locale has exactly the keys of `en.json`. The UI-language picker appears only when a second locale exists. CV language (`layout.lang`) drives the `lang` attribute, month names, present-words and the heading dictionary.

## 10. CLI (`cli/recto.js`, `cli/chrome.js`)

- `node cli/recto.js export <in.cv.json|in.md|in.json> -o <out.pdf|out.txt|out.json> [--template <id>]`
- `node cli/recto.js check <in> [--template <id>]` → prints issues; exit 1 on errors. Uses the browser for full rules; without a browser it runs content rules and says so.
- `.md` input is wrapped as `{ format: 'recto', version: 1, name, content, layout: defaultLayout() }`; JSON Resume input goes through `fromJsonResume`.
- `.txt` / `.json` outputs are pure Node (`parse`, `extractText`, `toJsonResume`).
- PDF: `serve.js` exports `createServer({ root, extra })`; the CLI serves the doc at `/__cli/doc.json`, launches Chromium with `--headless=new --remote-debugging-pipe` (stdlib `child_process`, fds 3/4, NUL-delimited JSON), `Target.createTarget` → `attachToTarget({ flatten: true })` → navigate to `/?print=/__cli/doc.json[&template=]` → `Runtime.evaluate('window.rectoReady', { awaitPromise: true, returnByValue: true })` → `Page.printToPDF({ preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false })`. Browser discovery: `CHROME_PATH`, then standard Chrome/Chromium/Edge/Brave paths on macOS, Linux and Windows.
- Page count check: `/\/Type\s*\/Page(?![A-Za-z])/g`; exit 1 if it differs from `report.pageCount`.

## 11. Code layout

```
index.html  serve.js  package.json  Dockerfile  LICENSE  README.md  CONTRIBUTING.md
cli/recto.js  cli/chrome.js
src/main.js                 boot, wiring, ?print mode, rectoReady
src/store.js                state, actions, history, autosave wiring
src/model/markdown.js       parse, parseInline, inlineText, slugify, parseDateRange, formatDate, detectContact
src/model/categories.js     categorize, dictionaries, PRESENT_WORDS, RANGE_WORDS
src/model/layout.js         defaultLayout, PAGE_SIZES, SECTION_DEFAULTS, normalizeLayout, migrateFile, applyLayoutOps, sectionConfig, placeSections, renameSectionIds, columnGeometry
src/model/templates.js      applyTemplate (pure); loadTemplates (fetch)
src/model/remix.js          remix(layout, rand) → ops
src/model/edits.js          applyContentEdits, moveSectionSource
src/render/theme.js         FONT_STACKS, themeToCss(theme) → CSS text
src/render/render.js        renderAtoms
src/render/paginate.js      paginate (pure)
src/render/pages.js         layoutPages (measure, build, verify → report, placement)
src/render/decor.js         decor + column-bg SVG
src/render/fit.js           fitToPages
src/preflight/rules.js      runPreflight
src/preflight/contrast.js   parseColor, composite, contrastRatio
src/preflight/ats.js        extractText, extractFields, separators helper
src/io/jsonresume.js        toJsonResume, fromJsonResume
src/io/plaintext.js         fromPlainText
src/io/files.js             open/save/download, File System Access
src/io/storage.js           localStorage docs, IndexedDB fonts, photo downscale
src/ui/dom.js  src/ui/i18n.js  src/ui/editor.js  src/ui/canvas.js  src/ui/handles.js  src/ui/decor-tools.js
src/ui/inspector.js  src/ui/panels.js  src/ui/gallery.js  src/ui/topbar.js
styles/app.css  styles/cv.css
locales/en.json
templates/index.json  templates/<id>.json (8)
samples/sample.cv.json
docs/syntax.md  docs/templates.md  docs/self-hosting.md  docs/cli.md  docs/architecture.md
test/*.test.js              node --test
scripts/smoke.js            headless Chromium end-to-end (uses cli/chrome.js)
.github/workflows/ci.yml    tests + smoke (installs fonts-liberation)
.github/workflows/pages.yml deploy to GitHub Pages
```
`src/model`, `src/preflight`, `src/io/jsonresume.js`, `src/io/plaintext.js`, `src/render/theme.js`, `src/render/paginate.js` are pure (no DOM), so Node tests and the CLI import them directly.

## 12. Testing

- `node --test`: every grammar row and edge case in 3.2 (including hostile input and the contact-detection cases `Node.js`, `Email: x@y.z`, trailing punctuation), dates, categories, layout normalize/migrate/ops/rename/sectionConfig/placeSections, applyTemplate, content edits and section moves, `paginate` (keepWithNext, groups, forced split, overflow, breakBefore, independent columns, header capacity, capacityOverride, hStart/hEnd accounting), themeToCss, contrast, every preflight rule (positive, negative, and fix applied → expected content), ATS extraction order with and without placement, JSON Resume round trip and foreign import, plaintext import, remix, locale key parity, no-`innerHTML` check.
- `node scripts/smoke.js`: for each template: `?print=/samples/sample.cv.json&template=<id>&report=1` via CDP → assert 0 preflight errors, `pageCount ≤ targetPages`, `lastPageFill ≤ 0.92` when `pageCount == targetPages`, no overflow flags, and no text-bearing element inside a page with a forbidden computed style (4.2); print to PDF → page count via regex equals `pageCount`; if `pdftotext` exists: `-raw` text contains name, email and section titles in `placement` order, and each form-feed-separated page starts/ends with `pages[i].firstText/lastText`.
- CI (`ubuntu-latest`, Chrome preinstalled, `fonts-liberation` installed): `npm test` + `npm run smoke`.
- Manual QA checklist in `docs/architecture.md`: every handle, decor draw/move/delete, section drag across columns, print from Chrome/Firefox/Safari.

## 13. Budgets and accessibility

- JS + CSS ≤ 300 KB uncompressed (templates, locales, samples excluded). No runtime or dev dependencies.
- Keystroke → updated pages ≤ 50 ms for a 2-page CV (excluding the 120 ms debounce).
- Every drag interaction has a numeric input equivalent; all controls keyboard reachable and labelled; visible focus; `prefers-reduced-motion` respected; app UI meets WCAG AA in light and dark (the CV page itself is always paper-coloured).

## 14. Later (explicitly out of v1)

Template gallery website, more UI locales, docs site, single-file offline build, PWA/offline install, share-by-link, auto-hyphenation, AI suggestions, keyword matching against a pasted job description, snapshots with diff.
