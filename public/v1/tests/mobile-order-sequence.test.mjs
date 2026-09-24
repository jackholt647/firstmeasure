import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const request = await readFile(new URL('../../libraries/apps/project-request/app.js', import.meta.url), 'utf8');
const source = request.slice(request.indexOf('  function mobileOrderReadyForDetails(){'), request.indexOf('  function shakeMobileOrderTarget('));

test('mobile location requires a selected address, type, scope and confirmed pin', () => {
  const state = {
    addressSelected: false, selectedType: null, mobileTypeTransitioning: false,
    mobileRoofOnlyChosen: false, locationConfirmed: false,
    window: { Portal: { ExteriorOrder: {
      offersChoice: type => type === 'residential',
      selectedScope: () => state.scope,
    } } },
    pinCount: () => state.pins,
    pins: 1, scope: null,
  };
  vm.createContext(state);
  vm.runInContext(source, state);
  assert.equal(state.mobileOrderReadyForDetails(), false);
  state.addressSelected = true;
  state.selectedType = 'residential';
  state.locationConfirmed = true;
  assert.equal(state.mobileOrderReadyForDetails(), false);
  state.scope = 'roof';
  state.mobileTypeTransitioning = true;
  assert.equal(state.mobileOrderReadyForDetails(), false);
  state.mobileTypeTransitioning = false;
  assert.equal(state.mobileOrderReadyForDetails(), true);
  state.locationConfirmed = false;
  assert.equal(state.mobileOrderReadyForDetails(), false);
  state.locationConfirmed = true;
  state.selectedType = 'commercial';
  assert.equal(state.mobileOrderReadyForDetails(), false);
  state.mobileRoofOnlyChosen = true;
  assert.equal(state.mobileOrderReadyForDetails(), true);
  state.pins = 0;
  assert.equal(state.mobileOrderReadyForDetails(), false);
});
