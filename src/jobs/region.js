// Country presets and location matching (career-suite spec §2). Pure: no DOM, storage or network.
// A preset feeds the profile form (states, currency, retirement wording, clearances, checks), the scan sources'
// country filters and the work-rights answers. Unknown countries still work: only the generic fields show.

export const DEFAULT_COUNTRY = 'AU'

// ponytail: aliases + major places per country; a geocoder would be exact. Short codes (2–3 letters) match only in capitals.
export const REGIONS = {
  AU: {
    name: 'Australia', aliases: ['australia', 'AU', 'AUS'], currency: 'AUD', retirement: 'super',
    places: ['sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'canberra', 'hobart', 'darwin', 'gold coast', 'newcastle',
      'wollongong', 'geelong', 'sunshine coast', 'townsville', 'cairns', 'parramatta', 'new south wales', 'queensland',
      'western australia', 'south australia', 'tasmania', 'australian capital territory', 'northern territory', 'NSW', 'VIC', 'QLD', 'TAS'],
    states: ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'],
    clearances: ['Baseline', 'NV1', 'NV2', 'PV'],
    checks: ['policeCheck', 'workingWithChildren'],
    diversity: ['indigenous'],
    workRights: ['citizen', 'permanent-resident', 'nz-citizen', 'visa', 'needs-visa'],
    feeds: { smartrecruiters: 'au', jobicy: 'australia' },
    timeZone: /^Australia\//, locales: ['en-AU']
  },
  NZ: {
    name: 'New Zealand', aliases: ['new zealand', 'NZ', 'aotearoa'], currency: 'NZD', retirement: 'KiwiSaver',
    places: ['auckland', 'wellington', 'christchurch', 'hamilton', 'dunedin', 'tauranga'],
    states: [], clearances: ['Confidential', 'Secret', 'Top Secret'], checks: ['policeCheck'], diversity: [],
    workRights: ['citizen', 'permanent-resident', 'visa', 'needs-visa'],
    feeds: { smartrecruiters: 'nz', jobicy: 'new-zealand' }, timeZone: /^Pacific\/Auckland$/, locales: ['en-NZ']
  },
  GB: {
    name: 'United Kingdom', aliases: ['united kingdom', 'great britain', 'britain', 'england', 'scotland', 'UK', 'GB'],
    currency: 'GBP', retirement: 'pension', places: ['london', 'manchester', 'edinburgh', 'glasgow', 'bristol', 'leeds', 'birmingham', 'cambridge', 'oxford', 'belfast'],
    states: [], clearances: ['BPSS', 'CTC', 'SC', 'DV'], checks: ['backgroundCheck'], diversity: [],
    workRights: ['citizen', 'settled-status', 'visa', 'needs-visa'],
    feeds: { smartrecruiters: 'gb', jobicy: 'uk' }, timeZone: /^Europe\/London$/, locales: ['en-GB']
  },
  US: {
    name: 'United States', aliases: ['united states', 'united states of america', 'america', 'US', 'USA'], currency: 'USD', retirement: '401(k)',
    places: ['new york', 'san francisco', 'seattle', 'austin', 'boston', 'chicago', 'los angeles', 'denver', 'atlanta', 'washington dc'],
    states: [], clearances: ['Public Trust', 'Secret', 'Top Secret', 'TS/SCI'], checks: ['backgroundCheck'], diversity: ['veteran'],
    workRights: ['citizen', 'permanent-resident', 'visa', 'needs-visa'],
    feeds: { smartrecruiters: 'us', jobicy: 'usa' }, timeZone: /^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage)$/, locales: ['en-US']
  },
  CA: {
    name: 'Canada', aliases: ['canada'], currency: 'CAD', retirement: 'RRSP',
    places: ['toronto', 'vancouver', 'montreal', 'ottawa', 'calgary', 'edmonton', 'waterloo'],
    states: [], clearances: ['Reliability', 'Secret', 'Top Secret'], checks: ['backgroundCheck'], diversity: [],
    workRights: ['citizen', 'permanent-resident', 'visa', 'needs-visa'],
    feeds: { smartrecruiters: 'ca', jobicy: 'canada' }, timeZone: /^America\/(Toronto|Vancouver|Edmonton|Winnipeg|Halifax)$/, locales: ['en-CA', 'fr-CA']
  },
  IE: {
    name: 'Ireland', aliases: ['ireland', 'IE'], currency: 'EUR', retirement: 'pension', places: ['dublin', 'cork', 'galway', 'limerick'],
    states: [], clearances: [], checks: ['backgroundCheck'], diversity: [], workRights: ['citizen', 'visa', 'needs-visa'],
    feeds: { smartrecruiters: 'ie', jobicy: 'ireland' }, timeZone: /^Europe\/Dublin$/, locales: ['en-IE']
  },
  DE: {
    name: 'Germany', aliases: ['germany', 'deutschland'], currency: 'EUR', retirement: 'pension',
    places: ['berlin', 'munich', 'münchen', 'hamburg', 'frankfurt', 'cologne', 'köln', 'stuttgart'],
    states: [], clearances: [], checks: ['backgroundCheck'], diversity: [], workRights: ['citizen', 'visa', 'needs-visa'],
    feeds: { smartrecruiters: 'de', jobicy: 'germany' }, timeZone: /^Europe\/Berlin$/, locales: ['de-DE']
  },
  FR: {
    name: 'France', aliases: ['france', 'FR'], currency: 'EUR', retirement: 'pension', places: ['paris', 'lyon', 'marseille', 'toulouse', 'nantes'],
    states: [], clearances: [], checks: ['backgroundCheck'], diversity: [], workRights: ['citizen', 'visa', 'needs-visa'],
    feeds: { smartrecruiters: 'fr', jobicy: 'france' }, timeZone: /^Europe\/Paris$/, locales: ['fr-FR']
  },
  SG: {
    name: 'Singapore', aliases: ['singapore', 'SG'], currency: 'SGD', retirement: 'CPF', places: [],
    states: [], clearances: [], checks: ['backgroundCheck'], diversity: [], workRights: ['citizen', 'permanent-resident', 'visa', 'needs-visa'],
    feeds: { smartrecruiters: 'sg', jobicy: 'singapore' }, timeZone: /^Asia\/Singapore$/, locales: ['en-SG']
  },
  IN: {
    name: 'India', aliases: ['india'], currency: 'INR', retirement: 'PF',
    places: ['bangalore', 'bengaluru', 'mumbai', 'delhi', 'new delhi', 'hyderabad', 'pune', 'chennai', 'gurgaon', 'gurugram', 'noida'],
    states: [], clearances: [], checks: ['backgroundCheck'], diversity: [], workRights: ['citizen', 'visa', 'needs-visa'],
    feeds: { smartrecruiters: 'in', jobicy: 'india' }, timeZone: /^Asia\/(Kolkata|Calcutta)$/, locales: ['en-IN', 'hi-IN']
  }
}

// Regions that count as "includes this country" for remote roles (Remote – APAC covers Australia)
const AREAS = { AU: ['APAC', 'ANZ', 'Asia Pacific', 'Oceania'], NZ: ['APAC', 'ANZ', 'Asia Pacific', 'Oceania'], SG: ['APAC', 'Asia Pacific', 'SEA'],
  IN: ['APAC', 'Asia Pacific'], GB: ['EMEA', 'Europe'], IE: ['EMEA', 'Europe'], DE: ['EMEA', 'Europe', 'DACH'], FR: ['EMEA', 'Europe'],
  US: ['North America', 'Americas'], CA: ['North America', 'Americas'] }

const str = v => typeof v === 'string' ? v : ''
const lower = s => str(s).trim().toLowerCase()
const escape = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const isCode = a => a.length <= 3 && a === a.toUpperCase()
const termRe = a => new RegExp(`(?<![\\p{L}\\p{N}])${escape(a)}(?![\\p{L}\\p{N}])`, isCode(a) ? 'u' : 'iu')

/** 'Australia' | 'au' | 'AUS' | 'AU' → 'AU'; unknown → ''. */
export function countryOf(name) {
  const n = lower(name)
  if (!n) return ''
  if (REGIONS[n.toUpperCase()]) return n.toUpperCase()
  return Object.keys(REGIONS).find(c => REGIONS[c].name.toLowerCase() === n || REGIONS[c].aliases.some(a => a.toLowerCase() === n)) ?? ''
}

/** The preset for a code or country name, or null. */
export const regionOf = name => REGIONS[countryOf(name)] ?? null

/** Whether `text` (a location, question or posting) names the country: its name, aliases or major places. */
export function mentionsCountry(text, country) {
  const r = regionOf(country)
  const s = str(text)
  if (!s) return false
  if (!r) return termRe(str(country).trim()).test(s)
  return [...r.aliases, r.name, ...r.places].some(a => termRe(a).test(s))
}

/** Whether a remote posting's area (APAC, EMEA, …) includes the country. */
export const inArea = (text, country) => (AREAS[countryOf(country)] ?? []).some(a => termRe(a).test(str(text)))

/** Codes of every preset country `text` mentions. */
export const countriesIn = text => Object.keys(REGIONS).filter(c => mentionsCountry(text, c))

/** Whether any entry of `authorizedIn` (names or codes) is a country `text` mentions. */
export const authorizedFor = (authorizedIn, text) => (Array.isArray(authorizedIn) ? authorizedIn : []).some(c => mentionsCountry(text, c))

/** Best guess from the browser: time zone first, then language tag ('en-AU'). '' when nothing matches. */
export function detectCountry({ timeZone = '', language = '' } = {}) {
  const tz = Object.keys(REGIONS).find(c => REGIONS[c].timeZone.test(str(timeZone)))
  if (tz) return tz
  const region = str(language).split(/[-_]/)[1]?.toUpperCase() ?? ''
  return REGIONS[region] ? region : ''
}

// Countries and areas without a preset: enough to tell "Remote – Spain" from "Remote" (anywhere)
const ELSEWHERE = ['argentina', 'austria', 'belgium', 'brazil', 'bulgaria', 'chile', 'china', 'colombia', 'costa rica', 'croatia',
  'cyprus', 'czech republic', 'czechia', 'denmark', 'egypt', 'estonia', 'finland', 'greece', 'hong kong', 'hungary', 'indonesia',
  'israel', 'italy', 'japan', 'kenya', 'korea', 'latvia', 'lithuania', 'luxembourg', 'malaysia', 'malta', 'mexico', 'morocco',
  'netherlands', 'nigeria', 'norway', 'pakistan', 'peru', 'philippines', 'poland', 'portugal', 'romania', 'saudi arabia', 'serbia',
  'slovakia', 'slovenia', 'south africa', 'spain', 'sweden', 'switzerland', 'taiwan', 'thailand', 'turkey', 'türkiye', 'ukraine',
  'united arab emirates', 'UAE', 'uruguay', 'vietnam', 'amsterdam', 'barcelona', 'madrid', 'lisbon', 'warsaw', 'stockholm', 'zurich',
  'tokyo', 'seoul', 'dubai', 'tel aviv', 'são paulo', 'sao paulo', 'mexico city', 'bogotá', 'buenos aires',
  'asia', 'europe', 'africa', 'latam', 'latin america', 'south america', 'middle east', 'EMEA', 'EU', 'americas', 'north america', 'CET']

/** Whether `text` names any country, city or area at all (a bare "Remote" or "Anywhere" names none). */
export const namesPlace = text => countriesIn(text).length > 0 || Object.keys(AREAS).some(c => inArea(text, c)) ||
  ELSEWHERE.some(a => termRe(a).test(str(text)))
