import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const request = await readFile(new URL('../../libraries/apps/project-request/app.js', import.meta.url), 'utf8');
const source = request.slice(request.indexOf('  function mobileOrderReadyForDetails(){'), request.indexOf('  function shakeMobileOrderTarget('));

test('full structure goes map, guided photos and summary, details, then review; roof keeps its existing sequence',()=>{
 const navigation=request.slice(request.indexOf('  function mobileOrderGoBack(){'),request.indexOf('  function handleMobileOrderSwipeStart'));
 let full=true,summary=false,photos=false,details=true,feedback=0;
 const state={mobileOrderPage:'location',shouldUseMobileOrderPagination:()=>true,mobileOrderReadyForDetails:()=>true,mobileOrderReadyForFinal:()=>!full||(photos&&details),shakeMissingMobileOrderRequirement(){},setMobileOrderPage:p=>state.mobileOrderPage=p,window:{Portal:{ExteriorOrder:{active:()=>full,mobilePhotoSummary:()=>summary,mobilePhotosReady:()=>photos,mobileDetailsReady:()=>details,explainMissingPhotos:()=>feedback++,mobilePhotoBack:()=>false}}}};
 vm.createContext(state);vm.runInContext(navigation,state);
 state.mobileOrderGoNext();assert.equal(state.mobileOrderPage,'photos');
 state.mobileOrderGoNext();assert.equal(state.mobileOrderPage,'photos');
 summary=true;state.mobileOrderGoNext();assert.equal(feedback,1);assert.equal(state.mobileOrderPage,'photos');photos=true;state.mobileOrderGoNext();assert.equal(state.mobileOrderPage,'details');
 details=false;state.mobileOrderGoNext();assert.equal(state.mobileOrderPage,'details');
 details=true;state.mobileOrderGoNext();assert.equal(state.mobileOrderPage,'final');
 state.mobileOrderGoBack();assert.equal(state.mobileOrderPage,'details');
 state.mobileOrderGoBack();assert.equal(state.mobileOrderPage,'photos');
 state.mobileOrderGoBack();assert.equal(state.mobileOrderPage,'location');
 full=false;state.mobileOrderGoNext();assert.equal(state.mobileOrderPage,'details');
 state.mobileOrderGoNext();assert.equal(state.mobileOrderPage,'final');
});

test('mobile location requires scope only where two report scopes are available', () => {
  const state = {
    addressSelected: false, selectedType: null, mobileTypeTransitioning: false,
    locationConfirmed: false,
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
  assert.equal(state.mobileOrderReadyForDetails(), true);
  state.window.Portal.ExteriorOrder.offersChoice = () => true;
  assert.equal(state.mobileOrderReadyForDetails(), true, 'commercial skips Full Structure even if a capability is enabled');
  state.selectedType = 'residential';
  state.window.Portal.ExteriorOrder.offersChoice = () => false;
  state.scope = null;
  assert.equal(state.mobileOrderReadyForDetails(), true, 'a disabled Full Structure flag skips the scope step');
  state.pins = 0;
  assert.equal(state.mobileOrderReadyForDetails(), false);
});
