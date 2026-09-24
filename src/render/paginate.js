// Pure pagination (spec 4.3 step 3): distribute measured atoms (CSS px) over pages,
// greedily per column, keeping keepWithNext / group chunks together when they fit.

export function usedHeight(atoms, indices) {
  if (!indices.length) return 0
  const last = indices[indices.length - 1]
  let sum = atoms[indices[0]].hStart + atoms[last].hEnd
  for (let k = 0; k < indices.length - 1; k++) sum += atoms[indices[k]].h
  return sum
}

// atom k joins k+1 when it is keepWithNext or both share a non-null group,
// never across a breakBefore (a forced break can't honour keep-with-next)
function chunksOf(atoms) {
  const chunks = []
  atoms.forEach((a, i) => {
    const prev = atoms[i - 1]
    const joined = prev && !a.breakBefore && (prev.keepWithNext || (prev.group != null && prev.group === a.group))
    if (joined) chunks[chunks.length - 1].push(i)
    else chunks.push([i])
  })
  return chunks
}

function paginateColumn(input, colId, flags) {
  const atoms = input.columns[colId]
  const epsilon = input.epsilon ?? 0.5
  const colPages = [[]]
  let placed = colPages[0]
  const page = () => colPages.length - 1
  const cap = p => input.capacityOverride?.[p]?.[colId] ?? (p === 0 ? input.capacityFirst[colId] : input.capacityRest)
  const fits = ix => usedHeight(atoms, ix) <= cap(page()) + epsilon
  const newPage = () => colPages.push(placed = [])

  for (const chunk of chunksOf(atoms)) {
    if (atoms[chunk[0]].breakBefore && placed.length) newPage()
    if (fits([...placed, ...chunk])) { placed.push(...chunk); continue }
    if (placed.length) newPage()
    if (fits(chunk)) { placed.push(...chunk); continue }
    // chunk taller than a page: place atom by atom
    const firstPage = page()
    for (const i of chunk) {
      if (placed.length && !fits([...placed, i])) newPage()
      placed.push(i)
      if (placed.length === 1 && !fits([i])) flags.push({ kind: 'overflow', page: page() + 1, colId, atom: i })
    }
    if (chunk.length > 1) flags.push({ kind: 'forced-split', page: firstPage + 1, colId, atom: chunk[0] })
  }
  return colPages
}

export function paginate(input) {
  const flags = []
  const colIds = Object.keys(input.columns)
  const byCol = Object.fromEntries(colIds.map(id => [id, paginateColumn(input, id, flags)]))
  const count = Math.max(1, ...colIds.map(id => byCol[id].length))
  const pages = Array.from({ length: count }, (_, p) => Object.fromEntries(colIds.map(id => [id, byCol[id][p] ?? []])))
  return { pages, flags }
}
