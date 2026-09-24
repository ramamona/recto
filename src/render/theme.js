// Theme tokens (spec 3.5) → --cv-* custom properties (spec 4.1). Pure.

// CC0 "modern font stacks", each ending in metric-compatible fallbacks for stable pagination.
const SANS = "Arial, 'Liberation Sans', Arimo, sans-serif"
const SERIF = "'Times New Roman', 'Liberation Serif', Tinos, serif"
const MONO = "'Courier New', 'Liberation Mono', Cousine, monospace"

export const FONT_STACKS = {
  'system-ui': `system-ui, -apple-system, 'Segoe UI', Roboto, ${SANS}`,
  'neo-grotesque': `Inter, Roboto, 'Helvetica Neue', 'Arial Nova', 'Nimbus Sans', ${SANS}`,
  humanist: `Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', source-sans-pro, ${SANS}`,
  geometric: `Avenir, Montserrat, Corbel, 'URW Gothic', source-sans-pro, ${SANS}`,
  transitional: `Charter, 'Bitstream Charter', 'Sitka Text', Cambria, ${SERIF}`,
  'old-style': `'Iowan Old Style', 'Palatino Linotype', 'URW Palladio L', P052, ${SERIF}`,
  didone: `Didot, 'Bodoni MT', 'Noto Serif Display', 'URW Palladio L', P052, Sylfaen, ${SERIF}`,
  slab: `Rockwell, 'Rockwell Nova', 'Roboto Slab', 'DejaVu Serif', 'Sitka Small', ${SERIF}`,
  mono: `ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', ${MONO}`
}

// Quoted CSS string; control chars and '<' as hex escapes so the value can't end a string or a <style>.
const cssString = s => '"' + s.replace(/[\\"]/g, '\\$&')
  .replace(/[\0-\x1f\x7f<]/g, c => '\\' + c.charCodeAt(0).toString(16) + ' ') + '"'

export function resolveFont (value) {
  const fallback = FONT_STACKS['neo-grotesque']
  if (typeof value !== 'string') return fallback
  if (Object.hasOwn(FONT_STACKS, value)) return FONT_STACKS[value]
  const family = value.startsWith('font:') ? value.slice(5).trim() : ''
  return family ? `${cssString(family)}, ${fallback}` : fallback
}

// + 1e-9 so float noise (1 + 0.35 × 0.7 = 1.2449…) rounds half up like the decimal value.
const round2 = x => Math.round(x * 100 + 1e-9) / 100
const SIZES = ['sizeName', 'sizeSection', 'sizeEntry', 'sizeBody', 'sizeSmall']
const GAPS = ['gapParagraph', 'gapEntry', 'gapSection']

export function scaledTheme (theme) {
  const d = theme.density
  const t = { ...theme, lineHeight: round2(1 + (theme.lineHeight - 1) * d) }
  for (const k of GAPS) t[k] = round2(theme[k] * d)
  for (const k of SIZES) t[k] = round2(theme[k] * (1 + (d - 1) * 0.35))
  return t
}

export function themeToCss (theme) {
  const t = scaledTheme(theme)
  const heading = t.colorHeading === 'accent' ? t.colorAccent : t.colorHeading === 'text' ? t.colorText : t.colorHeading
  const props = {
    'font-body': resolveFont(t.fontBody),
    'font-heading': resolveFont(t.fontHeading),
    'font-mono': resolveFont(t.fontMono),
    'size-name': t.sizeName + 'pt',
    'size-section': t.sizeSection + 'pt',
    'size-entry': t.sizeEntry + 'pt',
    'size-body': t.sizeBody + 'pt',
    'size-small': t.sizeSmall + 'pt',
    'line-height': t.lineHeight,
    'gap-paragraph': t.gapParagraph + 'mm',
    'gap-entry': t.gapEntry + 'mm',
    'gap-section': t.gapSection + 'mm',
    'color-text': t.colorText,
    'color-muted': t.colorMuted,
    'color-accent': t.colorAccent,
    'color-heading': heading,
    'color-rule': t.colorRule,
    'color-page': t.colorPage,
    // small-caps is faux (uppercase at 0.82em): real smcp glyphs extract as garbage in some parsers
    'heading-transform': t.headingCase === 'none' ? 'none' : 'uppercase',
    'heading-size-factor': t.headingCase === 'small-caps' ? 0.82 : 1,
    'heading-letter-spacing': t.headingLetterSpacing + 'em',
    'heading-weight': t.headingWeight,
    'name-weight': t.nameWeight,
    'name-transform': t.nameCase === 'upper' ? 'uppercase' : 'none',
    'bullet-char': cssString(t.bulletChar),
    'link-decoration': t.linkStyle === 'underline' ? 'underline' : 'none',
    'link-color': t.linkStyle === 'accent' ? t.colorAccent : 'inherit'
  }
  return Object.entries(props).map(([k, v]) => `--cv-${k}: ${v};`).join('\n')
}

export const themeAttrs = theme => ({
  'data-heading-rule': theme.headingRule,
  'data-date-style': theme.dateStyle,
  'data-link-style': theme.linkStyle,
  'data-heading-case': theme.headingCase
})

export function columnCss (column) {
  const map = { text: column.textColor, muted: column.mutedColor, accent: column.accentColor }
  return Object.entries(map).filter(([, v]) => v).map(([k, v]) => `--cv-col-${k}: ${v};`).join('\n')
}
