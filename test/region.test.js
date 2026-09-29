import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countryOf, regionOf, mentionsCountry, inArea, countriesIn, authorizedFor, detectCountry, DEFAULT_COUNTRY } from '../src/jobs/region.js'

test('countryOf accepts codes, names and aliases', () => {
  assert.equal(countryOf('Australia'), 'AU')
  assert.equal(countryOf('aus'), 'AU')
  assert.equal(countryOf('uk'), 'GB')
  assert.equal(countryOf('CA'), 'CA')
  assert.equal(countryOf('Narnia'), '')
  assert.equal(regionOf('AU').currency, 'AUD')
  assert.equal(DEFAULT_COUNTRY, 'AU')
})

test('mentionsCountry: places, states in capitals, no US-state false positives', () => {
  assert.ok(mentionsCountry('Sydney, NSW', 'AU'))
  assert.ok(mentionsCountry('Melbourne', 'Australia'))
  assert.ok(mentionsCountry('Remote - Australia', 'AU'))
  assert.ok(!mentionsCountry('Seattle, WA', 'AU'))
  assert.ok(!mentionsCountry('Tell us about yourself', 'US'))
  assert.ok(mentionsCountry('Austin, US', 'US'))
  assert.ok(!mentionsCountry('San Francisco, CA', 'Canada'))
  assert.ok(!mentionsCountry('Sydney, New South Wales', 'GB'))
  assert.ok(mentionsCountry('Lagos', 'Nigeria') === false && mentionsCountry('Lagos, Nigeria', 'Nigeria'))
})

test('areas, lists, authorization and detection', () => {
  assert.ok(inArea('Remote (APAC)', 'AU'))
  assert.ok(!inArea('Remote (EMEA)', 'AU'))
  assert.deepEqual(countriesIn('London or Sydney'), ['AU', 'GB'])
  assert.ok(authorizedFor(['Australia'], 'Do you have the right to work in Australia?'))
  assert.ok(!authorizedFor(['Australia'], 'Are you authorized to work in the US?'))
  assert.equal(detectCountry({ timeZone: 'Australia/Sydney' }), 'AU')
  assert.equal(detectCountry({ timeZone: 'UTC', language: 'en-NZ' }), 'NZ')
  assert.equal(detectCountry({ timeZone: 'UTC', language: 'en' }), '')
})

test('namesPlace tells a pinned remote role from an anywhere one', async () => {
  const { namesPlace } = await import('../src/jobs/region.js')
  for (const s of ['Spain (Remote)', 'The Netherlands', 'Asia', 'Remote - EMEA', 'Sydney']) assert.ok(namesPlace(s), s)
  for (const s of ['Remote', 'Anywhere', 'Remote, Global', 'Worldwide']) assert.ok(!namesPlace(s), s)
})

test('searchLinks and placeSuggestions follow the country', async () => {
  const { searchLinks, placeSuggestions } = await import('../src/jobs/region.js')
  const au = searchLinks('AU', { role: 'Platform Engineer', location: 'Sydney' })
  assert.deepEqual(au.map(s => s.name), ['LinkedIn', 'SEEK', 'Indeed', 'Jora'])
  assert.ok(au[1].url.startsWith('https://www.seek.com.au/jobs?keywords=Platform%20Engineer&where=Sydney'))
  assert.deepEqual(searchLinks('GB', { role: 'x' }).map(s => s.name), ['LinkedIn', 'Indeed'])
  assert.ok(searchLinks('GB').at(-1).url.includes('uk.indeed.com') && searchLinks('GB').at(-1).url.includes('United%20Kingdom'))
  assert.ok(placeSuggestions('AU').includes('Sydney') && placeSuggestions('AU').includes('Gold Coast') && placeSuggestions('AU').includes('NSW'))
})
