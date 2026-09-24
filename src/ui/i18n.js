// UI strings. English is always loaded as the fallback; a missing key renders as the key itself.

let strings = {}

async function fetchLocale(base, lang) {
  try {
    const res = await fetch(`${base}${lang}.json`)
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/** Load English plus the primary subtag of `lang` (e.g. 'de-AT' → 'de'). Returns the language actually used. */
export async function loadLocale(lang = 'en', base = 'locales/') {
  const primary = String(lang).toLowerCase().split('-')[0] || 'en'
  const en = (await fetchLocale(base, 'en')) ?? {}
  const extra = primary !== 'en' ? await fetchLocale(base, primary) : null
  strings = { ...en, ...(extra ?? {}) }
  return extra ? primary : 'en'
}

/** Replace the string table (print mode, tests). */
export function setStrings(table) {
  strings = { ...table }
}

/** t('preflight.pages-over-target', { pages: 2, target: 1 }) → localized text with {var} placeholders filled. */
export function t(key, vars) {
  const s = strings[key] ?? key
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
}

export const hasString = key => key in strings
