// FM-457: on a new project request with no type chosen yet, the map takes up to
// 10 pins (the most any type allows) and the "Maximum of N pins" notice names the
// same limit the map enforced. Picking Residential lowers it to 5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../public/libraries/apps/${path}`, import.meta.url), 'utf8');
const mapSource = read('project-map/app.js');
const requestSource = read('project-request/app.js');

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
  test(`${label}: no project type allows 10 pins, residential 5, commercial and multi-family 10`, () => {
    const { maxPinsForType } = pinLimitHelpers(source);
    for (const none of [null, undefined, '', '  ']) assert.equal(maxPinsForType(none), 10);
    assert.equal(maxPinsForType('residential'), 5);
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

test('project-map: residential still stops at 5 and says 5', () => {
  const fifth = mapAddPin({ hostType: 'residential', projectType: '', existing: 4 });
  assert.equal(fifth.added, true);
  const sixth = mapAddPin({ hostType: 'residential', projectType: '', existing: 5 });
  assert.equal(sixth.added, false);
  assert.deepEqual(sixth.notices, [5]);
  const saved = mapAddPin({ hostType: undefined, projectType: 'residential', existing: 5 });
  assert.deepEqual(saved.notices, [5], 'a host without a type choice uses the project\'s type');
  const untyped = mapAddPin({ hostType: undefined, projectType: '', existing: 9 });
  assert.equal(untyped.added, true, 'an untyped project takes a 10th pin');
});

test('project-request: more pins than the chosen type allows always shows the limit in the pin info', () => {
  const render = functionSource(requestSource, 'renderPinInfo');
  assert.match(render, /count > maxPins/);
});
