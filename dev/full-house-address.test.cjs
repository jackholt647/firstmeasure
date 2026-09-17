const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function page() {
  const elements = Object.fromEntries(['submit', 'address', 'create', 'status'].map(id => [id, {
    value: '', disabled: true, textContent: '', dataset: { csrf: 'test-csrf' }, listeners: {},
    addEventListener(name, listener) { this.listeners[name] = listener; }
  }]));
  let choose, place;
  const requests = [];
  const context = { document: { getElementById: id => elements[id] }, location: {},
    google: { maps: { places: { Autocomplete: class {
      addListener(name, handler) { assert.equal(name, 'place_changed'); choose = handler; }
      getPlace() { return place; }
    } } } },
    fetch: async (url, options) => { requests.push({ url, ...options }); return { ok: true, json: async () => ({ folder: 'fullhouse_' + 'a'.repeat(32) }) }; }
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync('public/measure/internal/portal_scripts/full_house_address.js', 'utf8'), context);
  context.initFullHouseAddress();
  return { elements, context, requests,
    select(value = { formatted_address: '123 Selected Street, Test City, CA, USA', place_id: 'google-place', geometry: { location: { lat: () => 37.42, lng: () => -122.08 } } }) { place = value; choose(); },
    submit() { return elements.submit.listeners.submit({ preventDefault() {} }); },
    type(value) { elements.address.value = value; elements.address.listeners.input(); }
  };
}

test('full-house creation uses Google formatted address and exact coordinates', async () => {
  const p = page();
  assert.equal(p.elements.create.disabled, true);
  p.type('123');
  await p.submit();
  assert.equal(p.requests.length, 0, 'free text cannot create a project');
  p.select();
  assert.equal(p.elements.create.disabled, false);
  await p.submit();
  assert.deepEqual(JSON.parse(p.requests[0].body), {
    address: '123 Selected Street, Test City, CA, USA', lat: 37.42, lng: -122.08, measurement_scope: 'full_house'
  });
  assert.equal(p.requests[0].headers['X-Full-House-CSRF'], 'test-csrf');
  assert.match(p.context.location.href, /^editor.php\?folder=fullhouse_/);
  await p.submit();
  assert.equal(p.requests.length, 1, 'double submit cannot create duplicate jobs');
});

test('editing a selected address discards stale coordinates; invalid places stay blocked', async () => {
  const p = page();
  p.select();
  p.type('999 A different address');
  assert.equal(p.elements.create.disabled, true);
  await p.submit();
  assert.equal(p.requests.length, 0);
  p.select({ name: 'Unresolved search' });
  assert.equal(p.elements.create.disabled, true);
  p.select();
  p.context.gm_authFailure();
  assert.equal(p.elements.create.disabled, true);
  assert.equal(p.elements.address.disabled, true);
});

test('reference uploads finish before editor entry and retry the same created project', async () => {
 const p=page();let attempts=0;const folders=[];p.context.FullHouseReferences={lock(){},async upload(folder){folders.push(folder);if(++attempts===1)throw Error('Connection interrupted');}};
 p.select();await p.submit();assert.equal(p.context.location.href,undefined);assert.equal(p.requests.length,1);assert.equal(p.elements.address.disabled,true);assert.equal(p.elements.create.textContent,'Retry reference uploads');await p.submit();assert.equal(p.requests.length,1);assert.equal(folders[0],folders[1]);assert.match(p.context.location.href,/editor.php/);
});
