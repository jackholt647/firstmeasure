// FM-457: on a new project request with no type chosen yet or Residential, the map
// takes up to 5 pins and refuses the 6th with "Maximum of 5 pins"; Commercial and
// Multi-family take 10 and refuse the 11th with "Maximum of 10". The notice names the
// limit the map enforced, and the server's portal check agrees with the browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../public/libraries/apps/${path}`, import.meta.url), 'utf8');
const mapSource = read('project-map/app.js');
const requestSource = read('project-request/app.js');
const apiSource = readFileSync(new URL('../public/v1/platform/api.ts', import.meta.url), 'utf8');

function functionSource(source, name){
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `${name} found`);
  const end = source.indexOf('\n  }\n', start);
  return source.slice(start, end + 4);
}

function constant(source, name){
  const match = source.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(match, `${name} found`);
  return `const ${name} = ${match[1]};`;
}

function pinLimitHelpers(source){
  const body = [
    constant(source, 'MAX_PINS_RESIDENTIAL'),
    constant(source, 'MAX_PINS_PER_STRUCTURE_REPORT'),
    functionSource(source, 'normalizedProjectType'),
    functionSource(source, 'isPerStructureType'),
    functionSource(source, 'maxPinsForType'),
    'return { maxPinsForType };',
  ].join('\n');
  return new Function(body)();
}

for (const [label, source] of [['project-map', mapSource], ['project-request', requestSource]]) {
  test(`${label}: no project type and residential allow 5 pins, commercial and multi-family 10`, () => {
    const { maxPinsForType } = pinLimitHelpers(source);
    for (const none of [null, undefined, '', '  ']) assert.equal(maxPinsForType(none), 5);
    assert.equal(maxPinsForType('residential'), 5);
    assert.equal(maxPinsForType('Residential'), 5);
    assert.equal(maxPinsForType('commercial'), 10);
    assert.equal(maxPinsForType('multifamily'), 10);
    assert.equal(maxPinsForType('Multi-Family'), 10);
  });
}

// Runs the map's real addPin against stubs: a pin is either refused with the
// limit notice or goes on to build its marker.
function mapAddPin({ hostType, projectType, existing }){
  const notices = [];
  const added = Symbol('added');
  const { maxPinsForType } = pinLimitHelpers(mapSource);
  const host = hostType === undefined ? {} : { getSelectedType: () => hostType };
  const ctx = {
    state: { map: {}, host, markers: Array.from({ length: existing }, () => ({})) },
    window: { google: { maps: {} } },
    google: { maps: { Marker: function(){ throw added; } } },
    // The first thing addPin builds once a pin is allowed.
    buildPinIcon: () => { throw added; },
    callHost: (name, ...args) => {
      if (name === 'getSelectedType') return hostType;
      if (name === 'showStructurePinLimitNotice') { notices.push(args[0]); return true; }
      return undefined;
    },
    project: () => ({ project_type: projectType }),
    // What the map shows for pins and icons; the limit must not fall back to it.
    selectedType: () => String(hostType || projectType || 'residential'),
    normalizedProjectType: (type) => String(type || '').trim().toLowerCase(),
    maxPinsForType,
    pinLimitType: null,
    pinLimitMessage: (max) => `Maximum of ${max} pins per report.`,
    showToast: () => {},
  };
  const compile = (name) => new Function('ctx', `with (ctx) { return (${functionSource(mapSource, name).trim()}); }`)(ctx);
  ctx.pinLimitType = compile('pinLimitType');
  const addPin = compile('addPin');
  try {
    const result = addPin({ lat: 1, lng: 2 }, true, {});
    return { added: false, result, notices };
  } catch (error) {
    if (error === added) return { added: true, notices };
    throw error;
  }
}

test('project-map: with no type chosen the 5th pin is placed and the 6th is refused with "5"', () => {
  // The new request's draft is autosaved as residential before a type is picked; the
  // host's answer (none) decides, and gives the same 5.
  for (let existing = 0; existing < 5; existing += 1) {
    const outcome = mapAddPin({ hostType: null, projectType: 'residential', existing });
    assert.equal(outcome.added, true, `pin ${existing + 1} placed`);
    assert.deepEqual(outcome.notices, []);
  }
  const sixth = mapAddPin({ hostType: null, projectType: 'residential', existing: 5 });
  assert.equal(sixth.added, false);
  assert.deepEqual(sixth.notices, [5]);
});

test('project-map: residential stops at 5 and says 5', () => {
  const fifth = mapAddPin({ hostType: 'residential', projectType: '', existing: 4 });
  assert.equal(fifth.added, true);
  const sixth = mapAddPin({ hostType: 'residential', projectType: '', existing: 5 });
  assert.equal(sixth.added, false);
  assert.deepEqual(sixth.notices, [5]);
  const saved = mapAddPin({ hostType: undefined, projectType: 'residential', existing: 5 });
  assert.deepEqual(saved.notices, [5], 'a host without a type choice uses the project\'s type');
  const untyped = mapAddPin({ hostType: undefined, projectType: '', existing: 5 });
  assert.deepEqual(untyped.notices, [5], 'an untyped project stops at 5');
});

test('project-map: commercial and multi-family take a 10th pin and refuse the 11th with "10"', () => {
  for (const hostType of ['commercial', 'multifamily']) {
    for (let existing = 5; existing < 10; existing += 1) {
      const outcome = mapAddPin({ hostType, projectType: 'residential', existing });
      assert.equal(outcome.added, true, `${hostType}: pin ${existing + 1} placed`);
      assert.deepEqual(outcome.notices, []);
    }
    const eleventh = mapAddPin({ hostType, projectType: 'residential', existing: 10 });
    assert.equal(eleventh.added, false);
    assert.deepEqual(eleventh.notices, [10], hostType);
  }
});

test('project-map: switching from commercial to residential with 10 pins refuses the next pin with "5"', () => {
  const outcome = mapAddPin({ hostType: 'residential', projectType: 'commercial', existing: 10 });
  assert.equal(outcome.added, false);
  assert.deepEqual(outcome.notices, [5]);
});

test('server: the portal pin limit matches the browser for every type, and none', () => {
  const constants = ['MAX_PORTAL_RESIDENTIAL_PINS', 'MAX_PORTAL_STRUCTURE_PINS'].map((name) => {
    const match = apiSource.match(new RegExp(`const ${name} = (\\d+);`));
    assert.ok(match, `${name} found`);
    return `const ${name} = ${match[1]};`;
  });
  const fn = (name) => {
    const start = apiSource.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} found`);
    return apiSource.slice(start, apiSource.indexOf('\n}\n', start) + 2).replace(/\(projectType: string\)/, '(projectType)');
  };
  const { portalPinLimitForType } = new Function('cleanText', [
    ...constants,
    fn('isPortalStructurePinLimitedType'),
    fn('portalPinLimitForType'),
    'return { portalPinLimitForType };',
  ].join('\n'))((value) => String(value ?? '').trim());
  const { maxPinsForType } = pinLimitHelpers(requestSource);
  const expected = { '': 5, residential: 5, Residential: 5, commercial: 10, multifamily: 10, 'Multi-Family': 10 };
  for (const [type, max] of Object.entries(expected)) {
    assert.equal(portalPinLimitForType(type), max, type || '(none)');
    assert.equal(portalPinLimitForType(type), maxPinsForType(type), `${type || '(none)'}: server and request agree`);
  }
});

test('project-request: more pins than the chosen type allows always shows the limit in the pin info and blocks submit', () => {
  const render = functionSource(requestSource, 'renderPinInfo');
  assert.match(render, /count > maxPins/);
  assert.match(render, /maxPinsForType\(selectedType\)/);
  const exceeded = functionSource(requestSource, 'pinLimitExceeded');
  assert.match(exceeded, /pins\.length > maxPins/);
});
