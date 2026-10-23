// Login, signup and onboarding must render in every language pack: every key the
// pages use exists in every locale, and every message formats without raw placeholders.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { IntlMessageFormat } from 'intl-messageformat';

const root = path.resolve(import.meta.dirname, '../../..');
const catalogs = path.join(root, 'public/libraries/platform-language/catalogs');
const manifest = JSON.parse(fs.readFileSync(path.join(catalogs, 'manifest.json'), 'utf8'));
const languages = JSON.parse(fs.readFileSync(path.join(root, 'public/v1/platform/localization/languages.json'), 'utf8'));
const locales = languages.packs.map(pack => pack.code);
const NAMESPACES = ['signup', 'signup-region', 'phone-input', 'onboarding', 'platform-commerce'];
const namespace = name => JSON.parse(fs.readFileSync(path.join(catalogs, manifest.namespaces[name]), 'utf8')).namespaces[name];
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const message = entry => (typeof entry === 'string' ? entry : entry.message);

function argumentNames(entry) {
  if (typeof entry === 'string') return [];
  const names = new Set();
  const visit = nodes => nodes.forEach(node => {
    if (node.value && node.type !== 0) names.add(node.value);
    if (node.options) Object.values(node.options).forEach(option => visit(option.value));
    if (node.children) visit(node.children);
  });
  visit(new IntlMessageFormat(entry.message, 'en-US', undefined, { ignoreTag: true }).getAst());
  return [...names].sort();
}

test('every language pack is compiled for the login, signup and onboarding namespaces', () => {
  assert.deepEqual(manifest.supported_locales, locales);
  for (const name of NAMESPACES) {
    const compiled = namespace(name);
    const english = compiled['en-US'];
    for (const locale of locales.filter(code => !code.startsWith('en-'))) {
      const missing = Object.keys(english).filter(key => !Object.hasOwn(compiled[locale] || {}, key));
      assert.deepEqual(missing, [], `${locale}.${name} is missing keys`);
    }
  }
});

test('every translation formats with its English placeholders and leaves none raw', () => {
  for (const name of NAMESPACES) {
    const compiled = namespace(name);
    for (const [key, source] of Object.entries(compiled['en-US'])) {
      const names = argumentNames(source);
      const values = Object.fromEntries(names.map(arg => [arg, arg === 'count' ? 2 : `<${arg}>`]));
      for (const locale of locales) {
        const entry = compiled[locale]?.[key] ?? source;
        assert.equal(typeof entry === 'string', typeof source === 'string', `${locale}.${name}.${key} format`);
        assert.deepEqual(argumentNames(entry), names, `${locale}.${name}.${key} placeholders`);
        const text = typeof entry === 'string' ? entry : new IntlMessageFormat(entry.message, locale, undefined, { ignoreTag: true }).format(values);
        assert.doesNotMatch(String(text), /\{[a-z_]\w*\}/i, `${locale}.${name}.${key} renders a raw placeholder`);
      }
    }
  }
});

test('every key the login page, landing widget and onboarding use exists in the catalog', () => {
  const signup = namespace('signup')['en-US'];
  const pages = ['public/portal/login.php', 'public/portal/landing/shared/signup-widget.js'];
  for (const file of pages) {
    const code = read(file);
    const keys = new Set([
      ...[...code.matchAll(/data-i18n(?:-placeholder|-aria-label|-title)?="([a-z_]+)"/g)].map(m => m[1]),
      ...[...code.matchAll(/\bT\('([a-z_]+)'/g)].map(m => m[1]),
    ]);
    assert.ok(keys.size > 40, `${file} uses catalog keys`);
    for (const key of keys) assert.ok(Object.hasOwn(signup, key), `${file}: signup.${key} is not in the catalog`);
  }
  const libraries = ['public/libraries/signup-region/signup-region.js', 'public/libraries/apps/onboarding/wizard.js', 'public/libraries/phone-input/phone-input.js'];
  for (const file of libraries.filter(file => fs.existsSync(path.join(root, file)))) {
    const code = read(file);
    for (const [, name, key] of code.matchAll(/PlatformLanguage\??\.(?:text|htmlText)\(\s*["']([\w-]+)["']\s*,\s*["']([\w]+)["']/g)) {
      assert.ok(manifest.namespaces[name], `${file}: namespace ${name} is not compiled`);
      assert.ok(Object.hasOwn(namespace(name)['en-US'], key), `${file}: ${name}.${key} is not in the catalog`);
    }
  }
});

test('the signup form has no country or language dropdowns', () => {
  for (const file of ['public/portal/login.php', 'public/portal/landing/shared/signup-widget.js', 'public/libraries/signup-region/signup-region.js']) {
    const code = read(file);
    assert.doesNotMatch(code, /name\s*=\s*["']signup_country["']|\.name\s*=\s*['"]signup_country['"]/, `${file} renders a country field`);
    assert.doesNotMatch(code, /\.name\s*=\s*['"]signup_language['"][^;]*select|<select[^>]*signup_language/, `${file} renders a language select`);
    assert.doesNotMatch(code, /signup_country_unavailable/, `${file} still refuses a country`);
  }
});
