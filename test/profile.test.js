import test from 'node:test'
import assert from 'node:assert/strict'
import { PROFILE_KEY, normalizeProfile, loadProfile, saveProfile, hasWorkAuth, prefillProfile, workCountries, activeCountry, APPLICANT_FIELDS, EEO_FIELDS } from '../src/profile.js'
import { toProfile, formValues } from '../src/ui/profile-dialog.js'
import { parse } from '../src/model/markdown.js'

function memStorage(init = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), map: m }
}

const EMPTY = {
  authorizedIn: [], needsSponsorship: false, locations: [], remote: 'any', targetRoles: [], dealBreakers: [],
  firstName: '', lastName: '', email: '', phone: '', linkedin: '', github: '', website: '', city: '', country: '',
  salaryExpectation: '', noticePeriod: '', willingToRelocate: null,
  eeo: { gender: 'decline', race: 'decline', veteran: 'decline', disability: 'decline' }
}

test('normalizeProfile fills the spec shape and drops junk', () => {
  assert.deepEqual(normalizeProfile(null), EMPTY)
  assert.deepEqual(normalizeProfile({
    authorizedIn: [' DE ', '', 5, 'DE', 'France'], needsSponsorship: 'yes', remote: 'moon', dealBreakers: ['on-call'],
    salaryMin: '90000', currency: 'EUR', extra: 1
  }), { ...EMPTY, authorizedIn: ['DE', 'France'], dealBreakers: ['on-call'], salaryMin: 90000, currency: 'EUR' })
  assert.equal(normalizeProfile({ needsSponsorship: true, remote: 'hybrid' }).remote, 'hybrid')
  assert.equal(normalizeProfile({ salaryMin: 'lots' }).salaryMin, undefined)
})

test('save → load round-trips through recto:profile; bad data reads as empty', () => {
  const s = memStorage()
  const saved = saveProfile({ authorizedIn: ['US'], needsSponsorship: true, targetRoles: ['Staff Engineer'] }, s)
  assert.deepEqual(JSON.parse(s.map.get(PROFILE_KEY)), saved)
  assert.deepEqual(loadProfile(s), saved)
  assert.equal(PROFILE_KEY, 'recto:profile')
  assert.deepEqual(loadProfile(memStorage({ [PROFILE_KEY]: '{nope' })), EMPTY)
  assert.deepEqual(loadProfile({ getItem() { throw new Error('denied') } }), EMPTY)
})

test('hasWorkAuth only when the profile says something about authorization', () => {
  assert.equal(hasWorkAuth(EMPTY), false)
  assert.equal(hasWorkAuth({ authorizedIn: ['US'] }), true)
  assert.equal(hasWorkAuth({ needsSponsorship: true }), true)
})

test('applicant fields: trimmed strings, tri-state relocation, optional pronouns, EEO defaults to decline', () => {
  const p = normalizeProfile({
    firstName: ' Ada ', email: 'ada@x.dev', phone: 42, willingToRelocate: true, pronouns: ' she/her ',
    eeo: { gender: 'Female', race: '', veteran: 7 }
  })
  assert.equal(p.firstName, 'Ada')
  assert.equal(p.email, 'ada@x.dev')
  assert.equal(p.phone, '')
  assert.equal(p.willingToRelocate, true)
  assert.equal(normalizeProfile({ willingToRelocate: false }).willingToRelocate, false)
  assert.equal(normalizeProfile({ willingToRelocate: 'yes' }).willingToRelocate, null)
  assert.equal(p.pronouns, 'she/her')
  assert.equal('pronouns' in normalizeProfile({ pronouns: ' ' }), false)
  assert.deepEqual(p.eeo, { gender: 'Female', race: 'decline', veteran: 'decline', disability: 'decline' })
  assert.deepEqual(normalizeProfile({ eeo: 'nope' }).eeo, EMPTY.eeo)
})

const CV = parse('# Ada King Lovelace\nLondon, UK · ada@x.dev · +44 20 1234 5678 · [LinkedIn](https://linkedin.com/in/ada) · github.com/ada · https://ada.dev\n\n## Experience\n- Built the engine')

test('prefillProfile fills empty name, email, phone and links from the CV header', () => {
  const p = prefillProfile(normalizeProfile(null), CV)
  assert.equal(p.firstName, 'Ada King')
  assert.equal(p.lastName, 'Lovelace')
  assert.equal(p.email, 'ada@x.dev')
  assert.equal(p.phone, '+44 20 1234 5678')
  assert.equal(p.linkedin, 'https://linkedin.com/in/ada')
  assert.equal(p.github, 'https://github.com/ada')
  assert.equal(p.website, 'https://ada.dev')
  assert.equal(p.city, '')
})

test('prefillProfile never overwrites what the profile already says; no CV → unchanged', () => {
  const own = normalizeProfile({ firstName: 'Augusta', email: 'me@y.dev', website: 'https://me.dev' })
  const p = prefillProfile(own, CV)
  assert.equal(p.firstName, 'Augusta')
  assert.equal(p.lastName, 'Lovelace')
  assert.equal(p.email, 'me@y.dev')
  assert.equal(p.website, 'https://me.dev')
  assert.deepEqual(prefillProfile(own, null), own)
  assert.deepEqual(prefillProfile(own, parse('')), own)
})

// ---------- v2 (career-suite spec §3) ----------

const OLD = {
  authorizedIn: ['US', 'DE'], needsSponsorship: true, locations: ['Berlin'], remote: 'hybrid', targetRoles: ['Staff Engineer'], dealBreakers: ['crypto'],
  firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.dev', phone: '+1 555', linkedin: 'https://linkedin.com/in/ada', github: 'https://github.com/ada',
  website: 'https://ada.dev', city: 'New York', country: 'United States', salaryExpectation: '150000 USD', noticePeriod: '4 weeks',
  willingToRelocate: false, pronouns: 'she/her', salaryMin: 120000, currency: 'USD',
  eeo: { gender: 'Female', race: 'decline', veteran: 'decline', disability: 'decline' }
}

test('old profiles load unchanged; the old field lists are still exported', () => {
  assert.deepEqual(normalizeProfile(OLD), OLD)
  assert.deepEqual(normalizeProfile(normalizeProfile(OLD)), OLD)
  assert.ok(APPLICANT_FIELDS.includes('noticePeriod'))
  assert.deepEqual(EEO_FIELDS, ['gender', 'race', 'veteran', 'disability'])
})

const V2 = {
  preferredName: 'Ada', portfolio: 'https://ada.dev/work', street: '1 George St', state: 'NSW', postcode: '2000', country: 'au',
  workRights: 'permanent-resident', visaType: 'Subclass 189', visaExpiry: '2030-01-31', earliestStart: '2026-11-01',
  employmentTypes: ['contract', 'full-time', 'gig', 'contract'], willingToTravel: 'occasional', salaryBasis: 'base-plus-retirement', dayRate: '900 AUD',
  clearance: 'NV1', policeCheck: 'current', workingWithChildren: 'willing', backgroundCheck: 'no', driversLicence: true, ownVehicle: false,
  highestEducation: 'Bachelor of Science', yearsExperience: '8', languages: ['English', ' Tamil ', ''], referees: 'Two, on request',
  eeo: { gender: 'Female', indigenous: 'No', lgbtq: 'decline' },
  answers: [{ id: 'a1', question: 'Why us?', answer: 'Product', updatedAt: '2026-09-28T10:00:00.000Z', uses: 2, options: [] }],
  stories: [{ id: 's1', title: 'Billing rewrite', situation: 'Legacy', task: 'Rewrite', action: 'Led', result: '-30% cost', reflection: 'Ship smaller', tags: ['leadership'], sourceLines: [12, 'Built the billing service'] }]
}

test('v2 fields: kept when valid, country stored as the preset name', () => {
  const p = normalizeProfile(V2)
  assert.equal(p.country, 'Australia')
  assert.deepEqual(p.employmentTypes, ['full-time', 'contract'])
  assert.deepEqual(p.languages, ['English', 'Tamil'])
  assert.equal(p.yearsExperience, 8)
  assert.deepEqual(p.eeo, { gender: 'Female', race: 'decline', veteran: 'decline', disability: 'decline', indigenous: 'No' })
  for (const k of ['preferredName', 'portfolio', 'street', 'state', 'postcode', 'workRights', 'visaType', 'visaExpiry', 'earliestStart', 'willingToTravel',
    'salaryBasis', 'dayRate', 'clearance', 'policeCheck', 'workingWithChildren', 'backgroundCheck', 'driversLicence', 'ownVehicle', 'highestEducation', 'referees']) {
    assert.equal(p[k], V2[k], k)
  }
  assert.deepEqual(p.answers, [{ id: 'a1', question: 'Why us?', answer: 'Product', updatedAt: '2026-09-28T10:00:00.000Z', uses: 2 }])
  assert.deepEqual(p.stories, V2.stories)
  assert.deepEqual(normalizeProfile(p), p)
  assert.equal(normalizeProfile({ country: 'Narnia' }).country, 'Narnia')
})

test('v2 fields: junk dropped, enums and dates validated, blanks omitted', () => {
  const p = normalizeProfile({
    workRights: 'alien', visaExpiry: '2026-02-30', earliestStart: '9999-99-99', willingToTravel: 'always', salaryBasis: 'lots',
    policeCheck: 'yes', driversLicence: 'yes', yearsExperience: 200, employmentTypes: 'full-time', preferredName: '  ', languages: 'English'
  })
  assert.deepEqual(p, normalizeProfile(null))
  assert.equal(normalizeProfile({ yearsExperience: -1 }).yearsExperience, undefined)
  assert.equal(normalizeProfile({ yearsExperience: 0 }).yearsExperience, 0)
  assert.equal(normalizeProfile({ driversLicence: false }).driversLicence, false)
})

test('v2 caps: text lengths, answers (500, question 500, answer 5000), stories (50)', () => {
  assert.equal(normalizeProfile({ visaType: 'x'.repeat(900) }).visaType.length, 200)
  const answers = Array.from({ length: 520 }, (_, i) => ({ id: 'dup', question: `Q${i} ${'q'.repeat(600)}`, answer: 'a'.repeat(6000) }))
  const p = normalizeProfile({ answers: [{ question: 'no answer' }, 'junk', ...answers] })
  assert.equal(p.answers.length, 500)
  assert.equal(p.answers[0].question.length, 500)
  assert.equal(p.answers[0].answer.length, 5000)
  assert.equal(new Set(p.answers.map(a => a.id)).size, 500)
  assert.equal(p.answers[0].uses, 0)
  const stories = Array.from({ length: 60 }, (_, i) => ({ title: `S${i}` }))
  const s = normalizeProfile({ stories: [{}, { tags: ['x'] }, ...stories] }).stories
  assert.equal(s.length, 50)
  assert.deepEqual(s[0], { id: 'story-0', title: 'S0', situation: '', task: '', action: '', result: '', reflection: '', tags: [], sourceLines: [] })
})

test('work rights: hasWorkAuth and workCountries include the own country when rights grant it', () => {
  assert.equal(hasWorkAuth({ workRights: 'citizen' }), true)
  assert.deepEqual(workCountries({ authorizedIn: ['US'], country: 'Australia', workRights: 'permanent-resident' }), ['US', 'Australia'])
  assert.deepEqual(workCountries({ country: 'Australia', workRights: 'nz-citizen' }), ['Australia', 'NZ'])
  assert.deepEqual(workCountries({ country: 'Australia', workRights: 'needs-visa' }), [])
  assert.deepEqual(workCountries({ workRights: 'citizen' }), [])
})

test('activeCountry: profile country, else the browser, else the default', () => {
  assert.equal(activeCountry({ country: 'United Kingdom' }), 'GB')
  assert.equal(activeCountry({}, { timeZone: 'America/Toronto' }), 'CA')
  assert.equal(activeCountry({ country: 'Narnia' }, { language: 'en-NZ' }), 'NZ')
  assert.equal(activeCountry(null), 'AU')
})

test('profile form: v2 values map onto the profile; fields not on the form keep their saved values', () => {
  const base = normalizeProfile(V2)
  const p = toProfile({
    firstName: 'Ada', languages: 'English, French', employmentTypes: ['part-time', 'casual'], driversLicence: 'no', ownVehicle: '',
    yearsExperience: '9', 'eeo.indigenous': 'decline', 'eeo.gender': 'decline', workRights: 'citizen'
  }, base)
  assert.deepEqual(p.languages, ['English', 'French'])
  assert.deepEqual(p.employmentTypes, ['part-time', 'casual'])
  assert.equal(p.driversLicence, false)
  assert.equal(p.ownVehicle, undefined)
  assert.equal(p.yearsExperience, 9)
  assert.equal(p.workRights, 'citizen')
  assert.equal(p.eeo.indigenous, undefined)
  assert.equal(p.eeo.gender, 'decline')
  // not on the form: kept
  assert.equal(p.clearance, 'NV1')
  assert.deepEqual(p.answers, base.answers)
  assert.deepEqual(p.stories, base.stories)
  assert.deepEqual(p.targetRoles, [])
})

test('profile form: named controls → raw values; checkbox groups collect arrays, unnamed controls are skipped', () => {
  const el = (name, value, o = {}) => ({ name, value, type: 'text', dataset: {}, ...o })
  assert.deepEqual(formValues([
    el('firstName', 'Ada'), el('', 'search text'), el('needsSponsorship', 'on', { type: 'checkbox', checked: true }),
    el('employmentTypes', 'contract', { type: 'checkbox', checked: true, dataset: { group: '1' } }),
    el('employmentTypes', 'casual', { type: 'checkbox', checked: false, dataset: { group: '1' } }),
    el('languages', 'English')
  ]), { firstName: 'Ada', needsSponsorship: true, employmentTypes: ['contract'], languages: 'English' })
  assert.deepEqual(formValues([el('employmentTypes', 'casual', { type: 'checkbox', checked: false, dataset: { group: '1' } })]), { employmentTypes: [] })
})

test('stories: duplicate ids are made unique', () => {
  const s = normalizeProfile({ stories: [{ id: 's', title: 'A' }, { id: 's', title: 'B' }] }).stories
  assert.deepEqual(s.map(x => x.id), ['s', 'sx'])
})
