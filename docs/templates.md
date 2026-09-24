# Templates and the styling contract

A template is a JSON file of layout settings: grid, theme, margins, decor and per-category section defaults. It never contains content, CSS or code. On top of templates, anyone can restyle a CV with **custom CSS** (Inspector → **CSS**) written against the public styling contract below.

## Template files

Templates live in `templates/<id>.json`, and `templates/index.json` lists them in gallery order:

```json
{ "templates": ["classic", "modern", "minimal", "compact", "timeline", "executive", "academic", "bold"] }
```

A template file (`templates/sidebar.json`):

```json
{
  "id": "sidebar",
  "name": "Sidebar",
  "description": "Tinted left sidebar for skills, main column for experience.",
  "targetPages": 1,
  "layout": {
    "page": { "margins": { "top": 14, "right": 14, "bottom": 14, "left": 14 } },
    "grid": {
      "columns": [
        { "id": "side", "width": 1, "bg": "#eef4f3", "bleed": true, "accentColor": "#0f5f58" },
        { "id": "main", "width": 2.3 }
      ],
      "gutter": 10, "headerSpan": "main", "readingOrder": ["main", "side"]
    },
    "header": { "align": "left" },
    "theme": { "fontBody": "humanist", "fontHeading": "geometric", "colorAccent": "#0f5f58" },
    "decor": []
  },
  "sectionDefaults": {
    "*": { "column": "main" },
    "skills": { "column": "side", "variant": "tags" }
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | `[a-z0-9-]+` | Must match the file name. |
| `name`, `description` | string | Shown in the gallery. |
| `targetPages` | integer 1–10 | The page count the template is designed for. The smoke test renders the sample CV with the template and requires at most this many pages. |
| `layout.page.margins` | `{ top, right, bottom, left }` in mm, 0–60 | Only the margins. A template never sets the page size or the target pages of the user's document. |
| `layout.grid` | see [Grid](#grid) | |
| `layout.header.align` | `left`, `center`, `right` | Only the alignment. The photo belongs to the user. |
| `layout.theme` | [theme tokens](#theme-tokens) | Missing tokens take their defaults. |
| `layout.decor` | [decor items](#decor) | Lines, panels and ellipses. |
| `sectionDefaults` | `{ [category or "*"]: SectionConfig }` | Section settings by [category](#section-categories). |

### What applying a template does

`applyTemplate(layout, template)` in `src/model/templates.js` starts from the default layout and merges the template's grid, theme, header alignment, margins and decor. It sets `sectionDefaults` to the template's, and it keeps the user's language, custom CSS, photo, page size and target pages. Per-section overrides are reset, except for `hidden: true`. It is one undo step.

Any value that fails validation (out of range, unknown enum, bad colour) is silently replaced by its default when a layout is normalized. That is why `npm run smoke` checks every value in a template file survives `normalizeLayout` unchanged, and reports the ones that don't.

### Grid

```js
grid: {
  columns: [{ id, width, bg?, bleed?, textColor?, mutedColor?, accentColor? }],  // 1–3, left to right
  gutter: 8,              // mm, 0–40
  headerSpan: 'full',     // 'full' or a column id: the header sits over that column only
  readingOrder: ['main']  // PDF text order of the columns; default: widest first
}
```

- `id` is `[a-z0-9-]+` (not `full`). `width` is a fraction, 0.2–5.
- `bg` paints the column background on every page. It follows margins, gutter and page size. With `bleed: true` it reaches the page edges, otherwise it extends 4 mm around the column.
- `textColor`, `mutedColor` and `accentColor` override the theme colours inside that column (a dark sidebar needs light text).
- `readingOrder` is the order an ATS reads the columns in. Put the main column first.

### Theme tokens

| Token | Default | Range or values |
|---|---|---|
| `fontBody`, `fontHeading` | `neo-grotesque` | a preset or `font:<family>` (an uploaded font) |
| `fontMono` | `mono` | same |
| `sizeName` / `sizeSection` / `sizeEntry` / `sizeBody` / `sizeSmall` | 24 / 11 / 10.5 / 9.75 / 8.75 pt | 6–48 |
| `lineHeight` | 1.35 | 1.0–2.0 |
| `gapParagraph` / `gapEntry` / `gapSection` | 1.2 / 3 / 5 mm | 0–20 |
| `density` | 1 | 0.7–1.2. Scales gaps and line spacing fully, and font sizes by 35 %. |
| `colorText` / `colorMuted` / `colorAccent` / `colorRule` / `colorPage` | `#111827` / `#4b5563` / `#1d4ed8` / `#d1d5db` / `#ffffff` | hex (`#rgb`, `#rrggbb`, `#rrggbbaa`) |
| `colorHeading` | `accent` | `accent`, `text` or hex |
| `headingCase` | `upper` | `none`, `upper`, `small-caps` (faux: uppercase at 0.82 em) |
| `headingLetterSpacing` | 0.06 em | 0–0.08. Wider spacing breaks text extraction. |
| `headingWeight`, `nameWeight` | 700 | 300–900 |
| `headingRule` | `below` | `none`, `below`, `above`, `bar` |
| `nameCase` | `none` | `none`, `upper` |
| `bulletChar` | `•` | `•`, `◦`, `▪`, `–`, `-`, `·`, or `""` for none |
| `dateStyle` | `right` | `right`, `inline`, `below`, `left` |
| `linkStyle` | `plain` | `plain`, `underline`, `accent` |

**Font presets** are system font stacks, so nothing is downloaded: `system-ui`, `neo-grotesque`, `humanist`, `geometric`, `transitional`, `old-style`, `didone`, `slab`, `mono`. Each stack ends in metric-compatible fallbacks (Arial/Liberation Sans/Arimo, Times New Roman/Liberation Serif/Tinos, Courier New/Liberation Mono/Cousine), so page breaks stay close across operating systems.

### Section categories

Section headings are matched to a category through a dictionary in English, German, French and Spanish (`src/model/categories.js`). The categories are:

`summary` `experience` `education` `skills` `projects` `certifications` `awards` `publications` `languages` `volunteering` `interests` `references` `contact`

`sectionDefaults["*"]` applies to every section, then the category's entry, then the user's own settings for that section id. So `"*": { "column": "main" }` plus `"skills": { "column": "side" }` sends Skills to the sidebar and everything else to the main column.

### SectionConfig

| Key | Default | Values |
|---|---|---|
| `column` | first column | a column id; an unknown id falls back to the first column in `readingOrder` |
| `hidden` | `false` | boolean |
| `variant` | `list` | `list`, `compact`, `timeline`, `tags`, `grid` |
| `showTitle` | `true` | boolean |
| `ruleAbove`, `ruleBelow` | `false` | boolean |
| `breakBefore` | `false` | boolean: start the section on a new page |
| `keepTogether` | `true` | boolean: keep each entry on one page when possible |
| `panel` | `null` | `{ bg, border: 'none'\|'solid'\|'dashed', borderColor, borderWidth, radius, padding }` (mm) |

Variants:

- `list`: entry head (title, org, date, location per `dateStyle`), then paragraphs and bullets.
- `compact`: the entry head on one line, `Title, Org — Date`.
- `timeline`: entries hang off an accent line with dots.
- `tags`: each bullet splits on `,` into chips. A leading `**Label:**` becomes a group label.
- `grid`: bullets in two columns. `**Label:** value` aligns the labels.

Variants never change the text order.

### Decor

```js
{ id, kind: 'rect'|'line'|'ellipse', pages: 'all'|'first'|'rest'|[1, 3],
  x, y, w, h,              // mm from the page's top-left corner; a line runs (x, y) → (x + w, y + h)
  fill: '#hex'|null, stroke: '#hex'|null, strokeWidth: 0.5, radius: 0, opacity: 1, z: 'back'|'front' }
```

Decor is drawn in an `aria-hidden` SVG per page. It is vector in the PDF and never contains text. For a sidebar background use a column `bg`, which follows the geometry, instead of a rectangle.

## The public styling contract

The class names, attributes and `--cv-*` variables below are stable within a major version. `styles/cv.css`, the renderer, the canvas and your custom CSS all use them.

```
.cv-pages[lang]                                   all pages (inside a shadow root)
  .cv-page[data-page=N]                           one sheet; position: relative; isolation: isolate
    svg.cv-decor.cv-back / svg.cv-decor.cv-front  decor and .cv-col-bg rects (aria-hidden)
    .cv-page-grid
      .cv-header                                  page 1 only
        img.cv-photo  h1.cv-name  p.cv-tagline  .cv-contacts > .cv-contact[data-kind] (+ separator text)
      .cv-col[data-col=ID]
        .cv-section[data-section][data-category][data-variant]  (+ .cv-panel when a panel is set)
          h2.cv-section-title
          .cv-entry > .cv-entry-head > .cv-entry-title .cv-org .cv-date .cv-location
                    > p.cv-p  ul.cv-list > li.cv-li
          p.cv-p  ul.cv-list > li.cv-li  hr.cv-rule
          .cv-tags > .cv-tag-group > .cv-tag-label .cv-tag      (tags variant)
          .cv-grid > .cv-grid-item > .cv-label                  (grid variant)
```

- `.cv-contact[data-kind]` is `email`, `phone`, `url` or `text`. `.cv-section[data-category]` is one of the [categories](#section-categories), or empty.
- Every atom (the unit pagination moves between pages) has `data-atom=<kind>` and `data-line=<source line>`.
- A section or entry that crosses a page is split into fragments, and each fragment is a complete box with its own padding, border and radius. `.cv-first` marks the first atom in a page column and every wrapper re-opened there (its `margin-top` is 0). `.cv-cont-prev` and `.cv-cont-next` mark a fragment that continues from or onto another page. They are styling hooks only: don't change geometry with them.
- The theme is exposed as custom properties on `.cv-pages`, named `--cv-<kebab-token>`, for example:

| Variable | Example |
|---|---|
| `--cv-font-body`, `--cv-font-heading`, `--cv-font-mono` | a font stack |
| `--cv-size-name`, `--cv-size-section`, `--cv-size-entry`, `--cv-size-body`, `--cv-size-small` | `9.75pt` (after density) |
| `--cv-line-height` | `1.35` |
| `--cv-gap-paragraph`, `--cv-gap-entry`, `--cv-gap-section` | `3mm` (after density) |
| `--cv-color-text`, `--cv-color-muted`, `--cv-color-accent`, `--cv-color-heading`, `--cv-color-rule`, `--cv-color-page` | `#1d4ed8` |
| `--cv-heading-letter-spacing`, `--cv-heading-weight`, `--cv-name-weight` | `0.06em`, `700` |
| `--cv-bullet-char` | `"•"` |

- Columns with their own colours also set `--cv-col-text`, `--cv-col-muted` and `--cv-col-accent` on `.cv-col`.

## Custom CSS

Custom CSS goes into the same shadow root as the pages, after `cv.css` and the theme, so a selector with the same specificity wins. It applies to the canvas, the gallery thumbnails and the PDF alike. Preflight shows an info note when custom CSS is present, because Recto can't check everything it does.

```css
.cv-section-title { border-bottom: 0.6pt solid var(--cv-color-accent); }
.cv-col[data-col="side"] .cv-section-title { color: var(--cv-col-accent); }
.cv-contact[data-kind="url"] { font-style: italic; }
```

### Units

Use only `pt`, `mm`, `em` or unitless values. Never use `px`, `rem`, `vh`, `vw` or percentage heights. The page is a physical sheet: `rem` and viewport units follow the app, not the paper, and they make the canvas and the PDF disagree.

### Vertical spacing

Use `margin-top` only. Pagination measures each block and adds the heights up, and wrappers are `display: flow-root`, so `margin-top` never collapses. A `margin-bottom` or a changed `display` on a wrapper can make the measured and the printed page differ. The page verifies itself after rendering and moves content to the next page if a column overflows, but it can't fix everything.

### ATS paint invariant

Chromium writes text into the PDF in **paint order**, not DOM order, and an ATS reads it in that order. Inside `.cv-page`, never give an element that contains text:

- `float`, or any `position` other than `static`
- `transform`, `filter`, `z-index`, `order`, or `opacity` below 1

Arrange things with flex or grid, keeping the DOM order equal to the visual order (for example, push a date right with `margin-left: auto`). Pseudo-elements may be positioned only if their `content` has no letters or digits. The smoke test fails on a template that breaks this rule, and a text-bearing element with a forbidden computed style scrambles the ATS text for your CV too.

Other things that hurt text extraction: `letter-spacing` above 0.08 em, `font-variant: small-caps` (real small-caps glyphs extract as garbage in some parsers; use `text-transform: uppercase` and a smaller size), and text drawn with `content:` in pseudo-elements (it isn't in the ATS text).

### What the Content-Security-Policy blocks

The app can't make requests to other origins, so `url(https://…)` and `@import` of remote stylesheets or fonts are blocked. To use a font, upload it in Inspector → **Theme**. Saved `.cv.json` files embed it.
