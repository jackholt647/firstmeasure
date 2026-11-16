// FM-457: on a new project request the map takes up to 10 pins whichever type is
// chosen (or none yet), the "Maximum of N pins" notice names the same limit, and
// the server accepts what the map allowed. Picking a type never changes the limit.
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
    constant(source, 'MAX_PINS_PER_REPORT'),
    functionSource(source, 'normalizedProjectType'),
    functionSource(source, 'isPerStructureType'),
    functionSource(source, 'maxPinsForType'),
    'return { maxPinsForType };',
  ].join('\n');
  return new Function(body)();
}

for (const [label, source] of [['project-map', mapSource], ['project-request', requestSource]]) {
  test(`${label}: every project type, and none, allows 10 pins`, () => {
    const { maxPinsForType } = pinLimitHelpers(source);
    for (const none of [null, undefined, '', '  ']) assert.equal(maxPinsForType(none), 10);
    assert.equal(maxPinsForType('residential'), 10);
    assert.equal(maxPinsForType('Residential'), 10);
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

test('project-map: with no type chosen the 6th to 10th pins are placed and the 11th is refused with "10"', () => {
  // The new request's draft is autosaved as residential before a type is picked.
  for (let existing = 5; existing < 10; existing += 1) {
    const outcome = mapAddPin({ hostType: null, projectType: 'residential', existing });
    assert.equal(outcome.added, true, `pin ${existing + 1} placed`);
    assert.deepEqual(outcome.notices, []);
  }
  const eleventh = mapAddPin({ hostType: null, projectType: 'residential', existing: 10 });
  assert.equal(eleventh.added, false);
  assert.deepEqual(eleventh.notices, [10]);
});

test('project-map: residential and the other types take a 10th pin and refuse the 11th with "10"', () => {
  for (const hostType of ['residential', 'commercial', 'multifamily']) {
    for (let existing = 5; existing < 10; existing += 1) {
      const outcome = mapAddPin({ hostType, projectType: '', existing });
      assert.equal(outcome.added, true, `${hostType}: pin ${existing + 1} placed`);
    }
    const eleventh = mapAddPin({ hostType, projectType: '', existing: 10 });
    assert.equal(eleventh.added, false);
    assert.deepEqual(eleventh.notices, [10], hostType);
  }
  const saved = mapAddPin({ hostType: undefined, projectType: 'residential', existing: 9 });
  assert.equal(saved.added, true, 'a saved residential project takes a 10th pin');
  const untyped = mapAddPin({ hostType: undefined, projectType: '', existing: 9 });
  assert.equal(untyped.added, true, 'an untyped project takes a 10th pin');
});

test('server: the portal accepts the pins the map allows for every type', () => {
  const max = apiSource.match(/const MAX_PORTAL_PINS_PER_REPORT = (\d+);/);
  assert.ok(max, 'MAX_PORTAL_PINS_PER_REPORT found');
  const fn = (name) => {
    const start = apiSource.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} found`);
    return apiSource.slice(start, apiSource.indexOf('\n}\n', start) + 2).replace(/\(projectType: string\)/, '(projectType)');
  };
  const { portalPinLimitForType } = new Function('cleanText', [
    `const MAX_PORTAL_PINS_PER_REPORT = ${max[1]};`,
    fn('isPortalStructurePinLimitedType'),
    fn('portalPinLimitForType'),
    'return { portalPinLimitForType };',
  ].join('\n'))((value) => String(value ?? '').trim());
  const { maxPinsForType } = pinLimitHelpers(requestSource);
  for (const type of ['residential', 'commercial', 'multifamily', 'Multi-Family']) {
    assert.equal(portalPinLimitForType(type), 10, type);
    assert.equal(portalPinLimitForType(type), maxPinsForType(type), `${type}: server and request agree`);
  }
});

test('project-request: more pins than the chosen type allows always shows the limit in the pin info', () => {
  const render = functionSource(requestSource, 'renderPinInfo');
  assert.match(render, /count > maxPins/);
});
