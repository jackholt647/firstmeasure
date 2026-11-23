// Every setup is drawn the same way (docs/architecture/guided-experiences.md, "Editing a setup live"): one ES module
// per setup, loaded through the player's one loader (FLOW_MODULES, or a step's `module` path), saying where it is
// through ctx.place. No setup is drawn by inline code in the player, its own loader or a per-setup import line.
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const dir = new URL('../public/libraries/guided-experiences/', import.meta.url);
const stepsDir = new URL('../public/libraries/setup-steps/', import.meta.url);
const player = readFileSync(new URL('guided-setup.js', dir), 'utf8');
// Libraries a setup module uses, not setups themselves.
const HELPERS = new Set(['guided-experiences.js', 'guided-setup.js', 'guided-announcement.js', 'texting-setup.js', 'supplier-columns.js']);
const flowModules = () => {
  const block = player.slice(player.indexOf('const FLOW_MODULES = {'), player.indexOf('};', player.indexOf('const FLOW_MODULES = {')));
  return [...block.matchAll(/'([a-z-]+)': \{ path: '\.\/([a-z-]+\.js)\?v=[^']+'([^}]*)\}/g)].map(([, id, file, rest]) => ({ id, file, pages: !/pages: false/.test(rest) }));
};

test('the player draws no setup itself: one loader, one list', () => {
  const widgets = [...player.matchAll(/registerWidget\('([a-z-]+)'/g)].map((match) => match[1]);
  assert.deepEqual(widgets, ['module'], 'only the generic module widget is registered by name; every other setup is a FLOW_MODULES entry');
  assert.doesNotMatch(player, /import\(new URL\('\.\/[a-z-]+-setup\.js/, 'no per-setup import line');
  assert.ok(flowModules().length >= 14, 'FLOW_MODULES lists the setups');
});

test('every setup module says where it is through ctx.place', () => {
  const modules = [
    ...readdirSync(dir).filter((file) => file.endsWith('.js') && !HELPERS.has(file)).map((file) => [file, readFileSync(new URL(file, dir), 'utf8')]),
    ...readdirSync(stepsDir).filter((file) => file.endsWith('.js')).map((file) => [`setup-steps/${file}`, readFileSync(new URL(file, stepsDir), 'utf8')])
  ];
  assert.ok(modules.length >= 12);
  for (const [file, source] of modules) {
    assert.match(source, /export (function mount(Widget)?|default)/, `${file} is a step module`);
    assert.match(source, /ctx\.place\?\.keep\?\.\(/, `${file} keeps its place (ctx.place.keep)`);
  }
  // A module with pages of its own also restores them after a live redraw.
  for (const { id, file, pages } of flowModules()) {
    if (!pages || file === 'operations-setup.js') continue; // Operations' workflow keeps its step on the server.
    assert.match(readFileSync(new URL(file, dir), 'utf8'), /ctx\.place\?\.restored/, `${id} (${file}) reopens where it was`);
  }
});

test('nested steps go through the same loader, never their own import of a step module', () => {
  for (const file of readdirSync(dir).filter((name) => name.endsWith('-setup.js'))) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    for (const match of source.matchAll(/new URL\('\.\.\/setup-steps\/[^']+'/g)) {
      assert.match(source, /ctx\.mountStep\(/, `${file} mounts ${match[0]} through ctx.mountStep`);
    }
  }
});
