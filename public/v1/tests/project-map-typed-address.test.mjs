import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

// A new project started from a typed address (a My Projects search) looks it up with
// Google at once: a full match is taken as if picked, anything else opens the suggestions.
const source = readFileSync(new URL('../../libraries/apps/project-map/app.js', import.meta.url), 'utf8');
const request = readFileSync(new URL('../../libraries/apps/project-request/app.js', import.meta.url), 'utf8');
const lookup = source.slice(source.indexOf('  // A new project started from a typed address'), source.indexOf('  function latLngLiteral('));

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
    window:{ google:{ maps:{ places:{ Autocomplete(){} } } } },
    google:{ maps:{ Geocoder:class { geocode(request, done){ ctx.requests.push(request); done(...geocodeAnswer); } }, event:{ trigger(el, type){ events.push('maps:' + type); } } } },
    requests:[]
  });
  vm.runInContext(lookup, ctx);
  return { ctx, input, loaded, events };
}

test('a full Google match is taken as if picked from the suggestions', () => {
  const location = { lat:() => 39.7, lng:() => -104.9 };
  const { ctx, input, loaded, events } = context([[{ geometry:{ location }, address_components:[{ long_name:'12' }], formatted_address:'12 Oak Ln, Denver, CO 80202, USA' }], 'OK']);
  vm.runInContext("lookupTypedAddress('12 Oak Ln, Denver')", ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.requests)), [{ address:'12 Oak Ln, Denver' }]);
  assert.equal(input.value, '12 Oak Ln, Denver');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0][0], location);
  assert.equal(loaded[0][2], '12 Oak Ln, Denver, CO 80202, USA');
  assert.deepEqual(events, [], 'the suggestions stay closed');
});

test('a partial match or none leaves the text typed with the suggestions open', () => {
  for (const answer of [[[{ geometry:{ location:{} }, partial_match:true }], 'OK'], [[], 'ZERO_RESULTS']]) {
    const { ctx, input, loaded, events } = context(answer);
    vm.runInContext("lookupTypedAddress('12 Oak')", ctx);
    assert.equal(loaded.length, 0);
    assert.equal(input.value, '12 Oak');
    assert.equal(input.focused, true);
    assert.deepEqual(events, ['input', 'maps:focus']);
  }
});

test('text the person changed meanwhile is left alone', () => {
  const { ctx, input, loaded, events } = context([[{ geometry:{ location:{} } }], 'OK']);
  input.value = 'Something else';
  vm.runInContext("lookupTypedAddress('12 Oak')", ctx);
  assert.equal(input.value, 'Something else');
  assert.equal(loaded.length + events.length + ctx.requests.length, 0);
});

test('the new-project window passes a typed address to the lookup', () => {
  assert.match(request, /const typedAddress = baseProject \? '' : String\(options\.address \|\| ''\)\.trim\(\);[\s\S]{0,260}projectMapInvoke\('lookupTypedAddress', \[typedAddress\]\)/);
  assert.match(source, /    lookupTypedAddress,\n/);
});
