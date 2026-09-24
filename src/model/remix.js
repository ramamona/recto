// Remix (spec 3.5): a random but tasteful theme variation, returned as layout ops. Pure.
import { ENUMS } from './layout.js'

// Each ≥ 4.5:1 on white (checked in test/remix.test.js).
export const ACCENTS = [
  '#1d4ed8', '#b91c1c', '#047857', '#7c3aed', '#c2410c', '#0f766e',
  '#be185d', '#4338ca', '#0369a1', '#a16207', '#334155', '#9f1239',
]

// [heading, body]
const FONT_PAIRS = [
  ['neo-grotesque', 'neo-grotesque'], ['system-ui', 'system-ui'], ['humanist', 'humanist'],
  ['geometric', 'humanist'], ['geometric', 'neo-grotesque'], ['transitional', 'transitional'],
  ['old-style', 'old-style'], ['didone', 'transitional'], ['slab', 'humanist'], ['didone', 'neo-grotesque'],
]

/** Theme-only ops; keeps content, page and grid. Always picks a different accent. */
export function remix(layout, rand = Math.random) {
  const pick = a => a[Math.floor(rand() * a.length) % a.length]
  const [fontHeading, fontBody] = pick(FONT_PAIRS)
  const theme = {
    fontHeading,
    fontBody,
    colorAccent: pick(ACCENTS.filter(c => c !== layout?.theme?.colorAccent)),
    headingCase: pick(ENUMS.headingCase),
    headingRule: pick(ENUMS.headingRule),
    bulletChar: pick(ENUMS.bulletChar),
    nameCase: pick(ENUMS.nameCase),
  }
  return Object.entries(theme).map(([k, value]) => ({ path: ['theme', k], value }))
}
