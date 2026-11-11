// FM-396: report type names ("Roof", "Roof & Gutters", "Full Exterior") stayed in English for a German company,
// because their hand-named language keys were never added to the catalog source or the language packs, so every
// locale fell back to the English text in the call. A report-type key must ship with a catalog entry and a
// translation in every installed language pack.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const localization = 'public/v1/platform/localization';
const source = JSON.parse(read(`${localization}/catalog-source.json`));
const packs = Object.fromEntries(JSON.parse(read(`${localization}/languages.json`)).packs
  .map((pack) => pack.code).filter((code) => !['en-US', 'en-GB'].includes(code))
  .map((code) => [code, JSON.parse(read(`${localization}/packs/${code}.json`))]));
const catalogs = 'public/libraries/platform-language/catalogs';
const manifest = JSON.parse(read(`${catalogs}/manifest.json`));
const compiled = (namespace) => JSON.parse(read(`${catalogs}/${manifest.namespaces[namespace]}`)).namespaces[namespace];

// Where report types are named: the order flow's scope chooser, the My projects tags, the Measurements tab's
// "Ordered" line, the order summary in Billing and the order form.
const callSites = [
  'public/libraries/apps/firstmeasure/order/exteriors.js',
  'public/libraries/apps/projects/viewer.js',
  'public/libraries/apps/measurements/project.js',
  'public/libraries/apps/billing/app.js',
  'public/libraries/apps/project-request/app.js',
];
const reportTypeKey = /^(?:report_kind_\w+|ext_scope_\w+|ext_full_exterior(?:_info)?|full_exterior|roof_gutters|roof_only|full_exterior_report(?:_ordered)?|roof_report_title|order_full_exterior|order_roof_report|this_full_exterior_report)$/;
const call = /PlatformLanguage\??\.(?:htmlText|text)\(\s*(["'])([\w-]+)\1\s*,\s*(["'])(\w+)\3\s*,\s*(["'`])((?:\\.|(?!\5).)*)\5/g;

function keysIn(relative, wanted) {
  const found = [];
  for (const match of read(relative).matchAll(call)) {
    const [, , namespace, , key, quote, fallback] = match;
    if (wanted(key)) found.push({relative, namespace, key, fallback: quote === '`' ? null : fallback});
  }
  return found;
}

function assertCatalogued({relative, namespace, key, fallback}) {
  const id = `${namespace}.${key}`;
  assert.ok(Object.hasOwn(source[namespace] || {}, key), `${id} (${relative}) is missing from catalog-source.json`);
  const english = source[namespace][key];
  // A template fallback (`${n} structures`) is an ICU message in the catalog; a literal must match it exactly.
  if (fallback !== null) assert.equal(english, fallback, `${id}: catalog English differs from the call's fallback`);
  for (const [locale, pack] of Object.entries(packs)) {
    const translated = pack[namespace]?.[key];
    assert.ok(translated, `${id} (${relative}) has no ${locale} translation in packs/${locale}.json`);
    assert.equal(typeof translated, typeof english, `${locale}.${id}: plain/ICU form differs from the source`);
  }
}

test('every report type label in the order flow and project views is catalogued and translated', () => {
  const found = callSites.flatMap((relative) => keysIn(relative, (key) => reportTypeKey.test(key)));
  for (const [file, key] of [
    ['exteriors.js', 'ext_scope_roof'], ['exteriors.js', 'ext_full_exterior'],
    ['viewer.js', 'report_kind_roof'], ['viewer.js', 'report_kind_roof_and_gutters'], ['viewer.js', 'report_kind_full_exterior'],
    ['measurements/project.js', 'report_kind_full_exterior'], ['billing/app.js', 'full_exterior'],
  ]) assert.ok(found.some((entry) => entry.relative.endsWith(file) && entry.key === key), `${file} no longer names ${key}`);
  for (const entry of found) assertCatalogued(entry);
});

test('any report_kind_ or ext_scope_ key anywhere in the browser libraries is catalogued and translated', () => {
  const files = (dir) => readdirSync(path.join(root, dir)).flatMap((name) => {
    const relative = `${dir}/${name}`;
    if (['vendor', 'node_modules', 'dist', 'platform-language'].includes(name)) return [];
    return statSync(path.join(root, relative)).isDirectory() ? files(relative) : name.endsWith('.js') ? [relative] : [];
  });
  const found = files('public/libraries').flatMap((relative) => keysIn(relative, (key) => /^(?:report_kind_|ext_scope_)/.test(key)));
  assert.ok(found.length >= 9);
  for (const entry of found) assertCatalogued(entry);
});

test('the generated catalogs carry the German report type names', () => {
  assert.equal(compiled('projects')['de-DE'].report_kind_roof, 'Dach');
  assert.equal(compiled('projects')['de-DE'].report_kind_roof_and_gutters, 'Dach und Dachrinnen');
  assert.equal(compiled('projects')['de-DE'].report_kind_full_exterior, 'Gebäudehülle');
  assert.equal(compiled('firstmeasure')['de-DE'].ext_scope_roof, 'Dach');
  assert.equal(compiled('firstmeasure')['de-DE'].ext_full_exterior, 'Gebäudehülle');
  assert.equal(compiled('projects')['en-US'].report_kind_roof, 'Roof');
});

test('the My projects tag reads German from the generated catalog', () => {
  const viewer = read('public/libraries/apps/projects/viewer.js');
  const fn = (name) => {
    const start = viewer.indexOf(`function ${name}(`);
    let depth = 0;
    for (let i = viewer.indexOf('{', start); i < viewer.length; i++) {
      if (viewer[i] === '{') depth++;
      else if (viewer[i] === '}' && --depth === 0) return viewer.slice(start, i + 1);
    }
    throw new Error(name);
  };
  const german = compiled('projects')['de-DE'];
  const previous = globalThis.PlatformLanguage;
  globalThis.PlatformLanguage = {text: (namespace, key, fallback) => (namespace === 'projects' && german[key]) || fallback};
  try {
    const reportKindMeta = new Function('projectStatusGroup', `${fn('projectIncludesGutters')}\n${fn('reportKindMeta')}\nreturn reportKindMeta;`)(() => 'ready');
    assert.equal(reportKindMeta({}).label, 'Dach');
    assert.equal(reportKindMeta({include_gutter_measurements: true}).label, 'Dach und Dachrinnen');
    assert.equal(reportKindMeta({measurement_scope: 'full_house'}).label, 'Gebäudehülle');
  } finally {
    globalThis.PlatformLanguage = previous;
  }
});
