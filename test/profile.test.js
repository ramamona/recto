import test from 'node:test'
import assert from 'node:assert/strict'
import { PROFILE_KEY, normalizeProfile, loadProfile, saveProfile, hasWorkAuth, prefillProfile } from '../src/profile.js'
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
