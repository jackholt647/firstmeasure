import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const request = await readFile(new URL('../../libraries/apps/project-request/app.js', import.meta.url), 'utf8');
const source = request.slice(request.indexOf('  function mobileOrderReadyForDetails(){'), request.indexOf('  function shakeMobileOrderTarget('));

test('entering final review recomputes submit readiness and preserves in-flight lock', () => {
  let exteriorPage = 'details', uploading = false, busy = false;
  const submit = { disabled: true, querySelector: () => busy ? {} : null };
  const order = { style: {}, disabled: true };
  const elements = { '#rOverlay': { classList: { toggle() {} } }, '#rMobileOrder': order };
  const state = {
    $: selector => elements[selector], mobileOrderPage: 'final', orderSubmissionPending: false, activePreviewTab: 'map',
    placeOverviewDetails() {}, renderAfterHoursNotice() {}, instantDevelopmentReport: () => false, setSubmitBusyLabel() {},
    shouldUseMobileOrderPagination: () => true, mobileOrderReadyForDetails: () => true,
    mobileOrderUsesFinalPage: () => true, mobileOrderReadyForFinal: () => true,
    activeSubmitButton: () => submit,
    canSubmit: () => exteriorPage === 'final' && !uploading,
    selectedReportExpeditePricingPending: () => false, isScheduleChoice: () => false,
    syncMobileProjectInfoNavigation() {}, syncMobileLeftTray() {},
    syncMobileDefaultInfoTray() {}, syncMobileProjectNotes() {},
    window: { Portal: { ExteriorOrder: { active: () => true, setMobilePage: page => { exteriorPage = page; } } } },
  };
  vm.createContext(state);
  vm.runInContext(request.slice(request.indexOf('  function orderSubmitBlocked(){'), request.indexOf('  function setSubmitBusyLabel(')), state);
  vm.runInContext(request.slice(request.indexOf('  function syncMobileOrderPagination(){'), request.indexOf('  function normalizedProjectType(')), state);
  state.syncMobileOrderPagination();
  assert.equal(order.disabled, false, 'valid review must not inherit the previous page disabled state');
  assert.equal(submit.disabled, false, 'the forwarded click target must also be enabled');
  uploading = true; state.syncMobileOrderPagination();
  assert.equal(order.disabled, true);
  uploading = false; busy = true; state.syncMobileOrderPagination();
  assert.equal(order.disabled, true, 'do not unlock an order already submitting');
  busy = false; state.syncMobileOrderPagination();
  assert.equal(order.disabled, false);
});

test('full structure goes map, guided photos and summary, details, then review; roof keeps its existing sequence',()=>{
 const navigation=request.slice(request.indexOf('  function mobileOrderGoBack(){'),request.indexOf('  function handleMobileOrderSwipeStart'));
 let full=true,summary=false,photos=false,details=true,feedback=0;
 const state={mobileOrderPage:'location',orderSubmissionPending:false,shouldUseMobileOrderPagination:()=>true,mobileOrderReadyForDetails:()=>true,mobileOrderReadyForFinal:()=>!full||(photos&&details),shakeMissingMobileOrderRequirement(){},setMobileOrderPage:p=>state.mobileOrderPage=p,window:{Portal:{ExteriorOrder:{active:()=>full,mobilePhotoSummary:()=>summary,mobilePhotosReady:()=>photos,mobileDetailsReady:()=>details,explainMissingPhotos:()=>feedback++,mobilePhotoBack:()=>false}}}};
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

test('an invalid hidden contact field never stops the phone Order button (FM-517)', () => {
  // A name typed into a contact's Email made form.requestSubmit() fail browser validation on a field
  // the phone order page hides: no submit event, no request, no message.
  const binding = request.slice(request.indexOf("    const requestForm = $('#rForm');"), request.indexOf("    $('#rAddress')?.addEventListener('focus'"));
  assert.match(binding, /requestForm\.noValidate = true;[\s\S]*addEventListener\('submit', onSubmit/);
  const mobileOrder = request.slice(request.indexOf("    $('#rMobileOrder')?.addEventListener('click'"), request.indexOf("    $('#rContactContextBar')?.addEventListener('click'"));
  assert.match(mobileOrder, /onSubmit\(\{ preventDefault\(\)\{\} \}\)/);
  assert.doesNotMatch(mobileOrder, /requestSubmit|\.click\(\)/);
});

test('an order that fails unexpectedly shows a toast and unlocks the button (FM-517)', async () => {
  const toasts = [], locks = [];
  const state = {
    $: () => null, activeSubmitButton: () => null, setSubmitBusyLabel() {},
    hasReportOrdered: () => false, isScheduleChoice: () => false, hasSelectedAddons: () => true,
    submitReport: async () => { throw new Error('boom'); },
    showToast: (...args) => toasts.push(args), updateSubmitLabel() {}, syncMobileOrderPagination() {},
    console: { error() {} }, window: { Portal: {} }, globalThis: {}, Promise,
  };
  vm.createContext(state);
  vm.runInContext(request.slice(request.indexOf('  let orderSubmissionPending=false'), request.indexOf('  async function submitReport(')) + '\nthis.pending = () => orderSubmissionPending;', state);
  const lock = state.lockOrderSubmission;
  state.lockOrderSubmission = value => { locks.push(value); lock(value); };
  const pending = state.onSubmit({ preventDefault() {} });
  assert.equal(state.pending(), true, 'the button locks on the tap, before any request');
  await pending;
  assert.equal(state.pending(), false);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0][1], 'boom');
  assert.equal(toasts[0][2], false);
});
