import test from 'node:test'
import assert from 'node:assert/strict'
import { PROFILE_KEY, normalizeProfile, loadProfile, saveProfile, hasWorkAuth } from '../src/profile.js'

function memStorage(init = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), map: m }
}

const EMPTY = { authorizedIn: [], needsSponsorship: false, locations: [], remote: 'any', targetRoles: [], dealBreakers: [] }

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
