import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contentSource = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');

test('content success handler consumes lexicalDetails from background payload', () => {
  assert.match(contentSource, /const lexicalDetails = normalizeLexicalDetails\(payload\.lexicalDetails\);/);
  assert.match(contentSource, /renderSuccessCard\(state\.activeSelection\.text,\s*translatedText,\s*lexicalDetails\)/);
  assert.match(contentSource, /lexicalFields:\s*summarizeLexicalDetails\(lexicalDetails\)/);
});

test('single-word guard keeps sentence and phrase rendering translation-only', () => {
  assert.match(contentSource, /function buildLexicalBlock\(sourceText,\s*lexicalDetails\)/);
  assert.match(contentSource, /if \(!isSingleWordInput\(sourceText\)\)\s*\{\s*return null;\s*\}/s);
  assert.match(contentSource, /return Object\.keys\(normalized\)\.length > 0 \? normalized : null;/);
});

test('lexical section renders phonetic, definitions, and contextual analysis fields when valid', () => {
  assert.match(contentSource, /stt-card-block--lexical/);
  assert.match(contentSource, /createLexicalRow\('Phonetic',\s*normalized\.phonetic\)/);
  assert.match(contentSource, /createDefinitionsSection\(normalized\.definitions\)/);
  assert.match(contentSource, /createLexicalRow\('Context',\s*normalized\.contextual_analysis\)/);
});
