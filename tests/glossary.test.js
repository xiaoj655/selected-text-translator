import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_GLOSSARY_ENTRIES,
  buildGlossaryInstruction,
  normalizeTerm,
  sanitizeGlossary,
} from '../src/glossary.js'

test('normalizeTerm trims without altering case', () => {
  assert.equal(normalizeTerm('  Hello  '), 'Hello')
  assert.equal(normalizeTerm(null), '')
  assert.equal(normalizeTerm(undefined), '')
  assert.equal(normalizeTerm(123), '123')
})

test('sanitizeGlossary drops empty and malformed entries', () => {
  assert.deepEqual(sanitizeGlossary(null), [])
  assert.deepEqual(sanitizeGlossary('not an array'), [])
  const result = sanitizeGlossary([
    { source: 'Apple', target: '苹果公司' },
    { source: '  ', target: 'ignored' },
    { source: 'ignored', target: '  ' },
    null,
    'nope',
    { source: 'May', target: '五月' },
  ])
  assert.deepEqual(result, [
    { source: 'Apple', target: '苹果公司' },
    { source: 'May', target: '五月' },
  ])
})

test('sanitizeGlossary deduplicates sources case-insensitively, keeping the first', () => {
  const result = sanitizeGlossary([
    { source: 'Turkey', target: '土耳其' },
    { source: 'turkey', target: '火鸡' },
    { source: 'TURKEY', target: 'another' },
  ])
  assert.equal(result.length, 1)
  assert.deepEqual(result[0], { source: 'Turkey', target: '土耳其' })
})

test('sanitizeGlossary caps entries at the maximum', () => {
  const entries = Array.from({ length: MAX_GLOSSARY_ENTRIES + 10 }, (_, index) => ({
    source: `term-${index}`,
    target: `译-${index}`,
  }))
  const result = sanitizeGlossary(entries)
  assert.equal(result.length, MAX_GLOSSARY_ENTRIES)
  assert.deepEqual(result[0], { source: 'term-0', target: '译-0' })
})

test('buildGlossaryInstruction produces terminology rules', () => {
  const instruction = buildGlossaryInstruction([
    { source: 'Apple', target: '苹果公司' },
    { source: 'May', target: '五月' },
  ])
  assert.equal(
    instruction,
    'Apply these terminology rules exactly: '
    + '"Apple" must always be translated as "苹果公司"; '
    + '"May" must always be translated as "五月".',
  )
})

test('buildGlossaryInstruction is empty for no usable terms', () => {
  assert.equal(buildGlossaryInstruction([]), '')
  assert.equal(buildGlossaryInstruction(null), '')
  assert.equal(buildGlossaryInstruction([{ source: ' ', target: 'x' }]), '')
})
