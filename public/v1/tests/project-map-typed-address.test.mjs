import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// A new project started from a typed address (a search with no match) looks it up with Google at
// once: an answer that is the typed address completed (address-match.js) is filled in unsaved,
// anything else opens the suggestions. A caller may pass an answer it checked, or ask for the suggestions.
const source = readFileSync(new URL('../../libraries/apps/project-map/app.js', import.meta.url), 'utf8');
const request = readFileSync(new URL('../../libraries/apps/project-request/app.js', import.meta.url), 'utf8');
const lookup = source.slice(source.indexOf('  // A new project started from a typed address'), source.indexOf('  function latLngLiteral('));
const loadPlace = source.slice(source.indexOf('  // options.preload: an address filled in'), source.indexOf('  function forwardGeocode('));
const addressMatch = createRequire(import.meta.url)('../../libraries/address-match/address-match.js');
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));

function context(geocodeAnswer){
  const events = [];
  const input = {
    value:'', focused:false, classList:{ add(){}, remove(){} },
    focus(){ this.focused = true; }, setSelectionRange(){},
    dispatchEvent(event){ events.push(event.type); }
  };
  const loaded = [];
  const ctx = vm.createContext({
    setTimeout:(fn) => fn(), Event:class { constructor(type){ this.type = type; } },
    $:(selector) => (selector === '#rAddress' ? input : null),
    googleMapsReady:() => true,
    loadPlaceResult:(...args) => loaded.push(args),
    state:{ placeLoadGen:0, addressAutocompleteInput:input, geocoder:null },
    window:{ FirstMateAddressMatch:addressMatch, google:{ maps:{ places:{ Autocomplete(){} } } } },
    google:{ maps:{
      LatLng:class { constructor(lat, lng){ this.latValue = lat; this.lngValue = lng; } },
      Geocoder:class { geocode(request, done){ ctx.requests.push(request); done(...geocodeAnswer); } },
      event:{ trigger(el, type){ events.push('maps:' + type); } }
    } },
    requests:[]
  });
  vm.runInContext(lookup, ctx);
  return { ctx, input, loaded, events };
}

const location = { lat:() => 39.7, lng:() => -104.9 };

test('an answer that only completes the typed address is filled in, unsaved, as if picked', async () => {
  const { ctx, input, loaded, events } = context([[{ geometry:{ location }, address_components:[{ long_name:'12' }], formatted_address:'12 Oak Ln, Denver, CO 80202, USA' }], 'OK']);
  vm.runInContext("lookupTypedAddress('12 Oak Lane, Denver')", ctx);
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.requests)), [{ address:'12 Oak Lane, Denver' }]);
  assert.equal(input.value, '12 Oak Lane, Denver');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0][0], location);
  assert.equal(loaded[0][2], '12 Oak Ln, Denver, CO 80202, USA');
  assert.deepEqual(plain(loaded[0][3]), { preload:true }, 'shown, not saved');
  assert.deepEqual(events, [], 'the suggestions stay closed');
});

test('an answer that changes the street, a partial match or none leaves the text typed with the suggestions open', async () => {
  for (const answer of [
    [[{ geometry:{ location }, formatted_address:'12 Oak St, Denver, CO 80202, USA' }], 'OK'],
    [[{ geometry:{ location }, formatted_address:'12 Oak Ave, Denver, CO 80202, USA', partial_match:true }], 'OK'],
    [[], 'ZERO_RESULTS']
  ]) {
    const { ctx, input, loaded, events } = context(answer);
    vm.runInContext("lookupTypedAddress('12 Oak Ave')", ctx);
    await settle();
    assert.equal(loaded.length, 0);
    assert.equal(input.value, '12 Oak Ave');
    assert.equal(input.focused, true);
    assert.deepEqual(events, ['input', 'maps:focus']);
  }
});

test('an answer the caller already checked is filled in without asking Google again', async () => {
  const { ctx, loaded, events } = context([[], 'ZERO_RESULTS']);
  vm.runInContext("lookupTypedAddress('12 Oak Ln, Denver, CO 80202, USA', { resolved:{ formatted_address:'12 Oak Ln, Denver, CO 80202, USA', lat:39.7, lng:-104.9, address_components:[] } })", ctx);
  await settle();
  assert.equal(ctx.requests.length, 0);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0][0].latValue, 39.7);
  assert.deepEqual(plain(loaded[0][3]), { preload:true });
  assert.deepEqual(events, []);
});

test('asked for the suggestions, it opens them without asking Google', async () => {
  const { ctx, input, loaded, events } = context([[{ geometry:{ location } }], 'OK']);
  vm.runInContext("lookupTypedAddress('12 Oak', { suggest:true })", ctx);
  await settle();
  assert.equal(ctx.requests.length + loaded.length, 0);
  assert.equal(input.value, '12 Oak');
  assert.deepEqual(events, ['input', 'maps:focus']);
});

test('text the person changed meanwhile is left alone', async () => {
  const { ctx, input, loaded, events } = context([[{ geometry:{ location:{} } }], 'OK']);
  input.value = 'Something else';
  vm.runInContext("lookupTypedAddress('12 Oak')", ctx);
  await settle();
  assert.equal(input.value, 'Something else');
  assert.equal(loaded.length + events.length + ctx.requests.length, 0);
});

test('a preloaded address is pinned and shown but never saved', () => {
  const calls = [];
  const fields = {};
  const ctx = vm.createContext({
    state:{ placeLoadGen:0 }, clearTimeout(){}, clearAllPins(){},
    $:(selector) => (fields[selector] ||= { value:'' }),
    parseAddressComponents:() => ({}), setAddressSelected:(value) => calls.push(['addressSelected', value]),
    setLocationConfirmed(){}, setCoords(){}, focusMapOnLocation(){}, viewingExistingProject:() => false,
    addPin:(point, draggable, options) => { calls.push(['addPin', options || {}]); return {}; },
    notifyPinsChanged:(options) => calls.push(['notify', options]),
    callHost:(name) => calls.push([name])
  });
  vm.runInContext(loadPlace, ctx);
  vm.runInContext("loadPlaceResult({ lat:() => 1, lng:() => 2 }, [], '12 Oak Ln', { preload:true })", ctx);
  const names = calls.map((call) => call[0]);
  assert.equal(names.includes('persistProject'), false);
  assert.equal(names.includes('autosaveSoon'), false);
  assert.deepEqual(plain(calls.find((call) => call[0] === 'addPin')[1]), { silent:true });
  assert.deepEqual(plain(calls.find((call) => call[0] === 'notify')[1]), { persist:false });
  assert.equal(fields['#rAddress'].value, '12 Oak Ln');
  calls.length = 0;
  vm.runInContext("loadPlaceResult({ lat:() => 1, lng:() => 2 }, [], '12 Oak Ln')", ctx);
  assert.ok(calls.some((call) => call[0] === 'persistProject'), 'an address the person picked is saved as before');
});

test('the new-project window passes a typed address, a checked answer or a suggestions request to the lookup', () => {
  assert.match(request, /const typedAddress = baseProject \? '' : String\(options\.address \|\| ''\)\.trim\(\);[\s\S]{0,260}const lookup = \{ resolved: options\.resolvedAddress \|\| null, suggest: options\.addressSuggest === true \};\s+setTimeout\(\(\) => projectMapInvoke\('lookupTypedAddress', \[typedAddress, lookup\]\), 60\);/);
  assert.match(request, /options\.reportProject === 'new'\) reportProjectChoice = 'new';/);
  assert.match(source, /    lookupTypedAddress,\n/);
});
