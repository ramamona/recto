// Section-heading dictionary, present-words and range-words per CV language.
// Pure module: used by the parser (dates, contact sections), layout (section defaults),
// preflight (nonstandard-heading) and ATS/JSON Resume mapping.

export const LANGS = ['en', 'de', 'fr', 'es']

const DICT = {
  summary: {
    en: ['summary', 'profile', 'professional summary', 'about', 'about me', 'objective', 'career objective', 'overview', 'executive summary', 'personal statement'],
    de: ['zusammenfassung', 'profil', 'über mich', 'kurzprofil', 'berufsziel'],
    fr: ['résumé', 'profil', 'à propos', 'objectif', 'synthèse'],
    es: ['resumen', 'perfil', 'sobre mí', 'objetivo', 'extracto'],
  },
  experience: {
    en: ['experience', 'work experience', 'professional experience', 'employment', 'employment history', 'work history', 'career history', 'relevant experience'],
    de: ['berufserfahrung', 'erfahrung', 'beruflicher werdegang', 'werdegang', 'praxiserfahrung'],
    fr: ['expérience', 'expériences', 'expérience professionnelle', 'expériences professionnelles', 'parcours professionnel'],
    es: ['experiencia', 'experiencia laboral', 'experiencia profesional', 'historial laboral'],
  },
  education: {
    en: ['education', 'academic background', 'qualifications', 'education and training', 'academic history'],
    de: ['ausbildung', 'bildung', 'studium', 'bildungsweg', 'schulbildung'],
    fr: ['formation', 'formations', 'éducation', 'études', 'diplômes'],
    es: ['educación', 'formación', 'formación académica', 'estudios'],
  },
  skills: {
    en: ['skills', 'technical skills', 'core skills', 'key skills', 'competencies', 'core competencies', 'expertise', 'technologies', 'tools', 'skills and tools'],
    de: ['kenntnisse', 'fähigkeiten', 'kompetenzen', 'fachkenntnisse', 'it-kenntnisse', 'technische kenntnisse'],
    fr: ['compétences', 'compétences techniques', 'savoir-faire', 'outils'],
    es: ['habilidades', 'competencias', 'aptitudes', 'conocimientos', 'habilidades técnicas'],
  },
  projects: {
    en: ['projects', 'personal projects', 'selected projects', 'key projects', 'side projects', 'open source'],
    de: ['projekte', 'ausgewählte projekte'],
    fr: ['projets', 'projets personnels', 'réalisations'],
    es: ['proyectos', 'proyectos personales'],
  },
  certifications: {
    en: ['certifications', 'certificates', 'licenses', 'licenses and certifications', 'certifications and licenses', 'courses'],
    de: ['zertifikate', 'zertifizierungen', 'weiterbildung', 'kurse'],
    fr: ['certifications', 'certificats', 'formations complémentaires'],
    es: ['certificaciones', 'certificados', 'cursos'],
  },
  awards: {
    en: ['awards', 'honors', 'honours', 'achievements', 'awards and honors', 'recognition'],
    de: ['auszeichnungen', 'preise', 'erfolge'],
    fr: ['prix', 'distinctions', 'récompenses'],
    es: ['premios', 'reconocimientos', 'logros'],
  },
  publications: {
    en: ['publications', 'papers', 'research', 'talks', 'talks and publications', 'presentations'],
    de: ['publikationen', 'veröffentlichungen', 'vorträge'],
    fr: ['publications', 'conférences'],
    es: ['publicaciones', 'conferencias'],
  },
  languages: {
    en: ['languages', 'language skills'],
    de: ['sprachen', 'sprachkenntnisse'],
    fr: ['langues', 'compétences linguistiques'],
    es: ['idiomas', 'lenguas'],
  },
  volunteering: {
    en: ['volunteering', 'volunteer experience', 'volunteer work', 'community', 'community involvement'],
    de: ['ehrenamt', 'ehrenamtliches engagement', 'engagement'],
    fr: ['bénévolat', 'engagement associatif'],
    es: ['voluntariado'],
  },
  interests: {
    en: ['interests', 'hobbies', 'hobbies and interests', 'personal interests'],
    de: ['interessen', 'hobbys', 'hobbies', 'freizeit'],
    fr: ["centres d'intérêt", 'loisirs', 'intérêts'],
    es: ['intereses', 'aficiones', 'pasatiempos'],
  },
  references: {
    en: ['references', 'referees'],
    de: ['referenzen'],
    fr: ['références'],
    es: ['referencias'],
  },
  contact: {
    en: ['contact', 'contact information', 'contact details', 'personal details', 'details', 'personal information'],
    de: ['kontakt', 'kontaktdaten', 'persönliche daten'],
    fr: ['contact', 'coordonnées', 'informations personnelles'],
    es: ['contacto', 'datos personales', 'datos de contacto'],
  },
}

export const CATEGORIES = Object.keys(DICT)

export const PRESENT_WORDS = {
  en: ['present', 'current', 'now', 'today', 'ongoing'],
  de: ['bis heute', 'heute', 'aktuell', 'jetzt'],
  fr: ["aujourd'hui", 'présent', 'actuel', 'en cours'],
  es: ['actualidad', 'presente', 'actual', 'hoy'],
}

export const RANGE_WORDS = { en: ['to'], de: ['bis'], fr: ['à'], es: ['a'] }

/** Case-, diacritic- and punctuation-insensitive form used for dictionary lookups. */
export function normalizeHeading(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/[:.\s]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const INDEX = new Map() // normalized phrase -> category (first language wins; phrases never conflict across categories)
for (const [cat, byLang] of Object.entries(DICT)) {
  for (const phrases of Object.values(byLang)) {
    for (const p of phrases) {
      const k = normalizeHeading(p)
      if (!INDEX.has(k)) INDEX.set(k, cat)
    }
  }
}

/** Map a section title to a category, or null. Matches any supported language (a German CV may use English headings). */
export function categorize(title, _lang = 'en') {
  return INDEX.get(normalizeHeading(title)) ?? null
}

/** True if the title is a dictionary heading in the CV language or English (used by nonstandard-heading). */
export function isStandardHeading(title, lang = 'en') {
  const k = normalizeHeading(title)
  for (const l of new Set([lang, 'en'])) {
    for (const byLang of Object.values(DICT)) {
      if ((byLang[l] ?? []).some(p => normalizeHeading(p) === k)) return true
    }
  }
  return false
}

const uniq = a => [...new Set(a)]
/** Present-words for the CV language plus English, longest first (so 'bis heute' wins over 'heute'). */
export function presentWords(lang = 'en') {
  return uniq([...(PRESENT_WORDS[lang] ?? []), ...PRESENT_WORDS.en]).sort((a, b) => b.length - a.length)
}
export function rangeWords(lang = 'en') {
  return uniq([...(RANGE_WORDS[lang] ?? []), ...RANGE_WORDS.en])
}
