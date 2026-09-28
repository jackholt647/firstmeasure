import test from 'node:test';
import assert from 'node:assert/strict';
import { argumentsOf, hash, localeCode, makeEntries, validateTranslation, validateResponse } from '../scripts/translation-kit.mjs';

test('context notes are tied to source revision and translator context has placeholder meanings', () => {
  const source = { format: 'icu', message: 'Hello {name}' };
  const notes = { messages: { 'shared/greeting': { source_hash: hash(source), meaning: 'Greeting to document recipient', placeholders: { name: 'Recipient display name; do not translate' } } } };
  const entries = makeEntries({ shared: { greeting: source } }, notes);
  assert.equal(entries[0].context.status, 'reviewed');
  assert.match(entries[0].context.placeholders.name.meaning, /Recipient/);
  assert.equal(makeEntries({ shared: { greeting: { ...source, message: 'Dear {name}' } } }, notes)[0].context.status, 'needs_context_review');
});
test('import validates ICU syntax and placeholder types without imposing English plural categories', () => {
  const source = { format: 'icu', message: '{count, plural, one {# item} other {# items}} for {name}' };
  assert.deepEqual(argumentsOf(source), { count: 'plural', name: 'text' });
  assert.equal(validateTranslation(source, '{count, plural, other {# 件}}：{name}', 'ja-JP').format, 'icu');
  assert.throws(() => validateTranslation(source, '{count} pour {name}', 'fr-FR'), /types/);
  assert.throws(() => validateTranslation(source, '{count, plural, other {oops}', 'fr-FR'));
  assert.throws(() => validateTranslation('Go &amp; save', 'Aller et enregistrer', 'fr-FR'), /tokens/);
});
test('packet import rejects wrong language, missing or unknown keys and stale sources; null retains fallback', () => {
  const catalog = { shared: { save: 'Save', cancel: 'Cancel' } };
  const packet = { packet_id: 'abc', locale: 'fr-FR', entries: makeEntries(catalog, {}) };
  const response = { packet_id: 'abc', locale: 'fr-FR', translations: { 'shared/save': 'Enregistrer', 'shared/cancel': null } };
  assert.deepEqual(validateResponse(packet, response, catalog), { shared: { save: 'Enregistrer' } });
  assert.throws(() => validateResponse(packet, { ...response, locale: 'es-ES' }, catalog), /locale/);
  assert.throws(() => validateResponse(packet, { ...response, translations: { 'shared/save': 'a' } }, catalog), /Missing/);
  assert.throws(() => validateResponse(packet, { ...response, translations: { ...response.translations, 'shared/no': 'a' } }, catalog), /Unknown/);
  assert.throws(() => validateResponse(packet, response, { shared: { save: 'Save now', cancel: 'Cancel' } }), /Stale/);
  assert.throws(() => localeCode('../fr'));
  assert.equal(localeCode('fr-fr'), 'fr-FR');
});
