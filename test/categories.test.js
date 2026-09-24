import test from 'node:test'
import assert from 'node:assert/strict'
import { categorize, isStandardHeading, presentWords, rangeWords, normalizeHeading, CATEGORIES } from '../src/model/categories.js'

test('categorize matches synonyms across languages, case and diacritics', () => {
  assert.equal(categorize('Work Experience'), 'experience')
  assert.equal(categorize('TECHNICAL SKILLS:'), 'skills')
  assert.equal(categorize('Berufserfahrung', 'de'), 'experience')
  assert.equal(categorize('Experiencia Laboral', 'es'), 'experience')
  assert.equal(categorize('Compétences', 'fr'), 'skills')
  assert.equal(categorize('Competences', 'fr'), 'skills')
  assert.equal(categorize('Awards & Honors'), 'awards')
  assert.equal(categorize('Contact'), 'contact')
  assert.equal(categorize('Things I Like'), null)
  assert.equal(categorize(''), null)
})

test('isStandardHeading checks CV language plus English', () => {
  assert.equal(isStandardHeading('Sprachen', 'de'), true)
  assert.equal(isStandardHeading('Languages', 'de'), true)
  assert.equal(isStandardHeading('Sprachen', 'en'), false)
  assert.equal(isStandardHeading('My Journey', 'en'), false)
})

test('present words are longest-first and include English', () => {
  const de = presentWords('de')
  assert.ok(de.indexOf('bis heute') < de.indexOf('heute'))
  assert.ok(de.includes('present'))
  assert.deepEqual(rangeWords('de'), ['bis', 'to'])
})

test('normalizeHeading', () => {
  assert.equal(normalizeHeading('  Über  Mich: '), 'uber mich')
  assert.ok(CATEGORIES.includes('volunteering'))
})
