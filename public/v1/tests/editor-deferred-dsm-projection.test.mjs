import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const mainPath = path.resolve('..', 'measure', 'internal', 'editor_scripts', 'main.js');
const source = fs.readFileSync(mainPath, 'utf8');
const start = source.indexOf('function getContextMetersPerPx');
const end = source.indexOf('function clampVisualChannel', start);
assert.ok(start >= 0 && end > start, 'deferred projection helpers are present');

let scheduledTask = null;
let metersPerPx = 0.15;
const context = {
  console,
  setTimeout,
  document: { getElementById: () => null },
  imageWidth: 1792,
  imageHeight: 1792,
  mapCenterLat: 26.6376099,
  mapCenterLng: -80.1906372,
  activeGeometry: {
    points: [{ x: 996, y: 896, z: 4 }],
    vents: [{ x: 896, y: 796, z: 3 }]
  },
  viewCanvases: {
    solar: {}, height: {}, google: {}, azure: {}, apple: {}, ai_geo: { keep: true }
  },
  adjustedViewCanvases: {
    google: {}, apple: {}, ai_geo: { keep: true }
  },
  maskedViewCanvases: { google: {} },
  layerData: { rgb: [new Uint8Array(1792 * 1792)], dsm: null, mask: null, google: {} },
  roofMaskData: null,
  deferredProjectTiffLoadRun: 0,
  window: {
    RADIUS_METERS: 60,
    getRadiusMeters: () => 60,
    getMetersPerPx: () => metersPerPx,
    setImageMetersPerPx: (value) => { metersPerPx = value; },
    refreshStructureMode: () => {}
  },
  runAfterInitialEditorPaint: (task) => { scheduledTask = Promise.resolve().then(task); },
  fetchProjectTiffRasters: async (url) => {
    if (url !== 'dsm-url') throw new Error(`unexpected TIFF URL: ${url}`);
    return {
      image: { getWidth: () => 1194, getHeight: () => 1197 },
      rasters: [new Float32Array(1194 * 1197)],
      metersPerPx: 0.1
    };
  },
  ensureViewCanvas: () => ({
    width: context.imageWidth,
    height: context.imageHeight,
    getContext: () => ({
      getImageData: () => ({ data: new Uint8ClampedArray(context.imageWidth * context.imageHeight * 4) })
    })
  }),
  refreshAfterDeferredProjectTiffs: () => {}
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

context.scheduleDeferredProjectTiffLoad('project-without-rgb', { dsm: 'dsm-url' });
assert.ok(scheduledTask, 'deferred TIFF task was scheduled');
await scheduledTask;

assert.equal(context.imageWidth, 1194);
assert.equal(context.imageHeight, 1197);
assert.equal(metersPerPx, 0.1);
assert.ok(
  Math.abs(context.activeGeometry.points[0].x - 747) < 1e-7,
  `expected projected point x=747, received ${context.activeGeometry.points[0].x}`
);
assert.ok(Math.abs(context.activeGeometry.points[0].y - 598.5) < 1e-7);
assert.ok(Math.abs(context.activeGeometry.vents[0].x - 597) < 1e-7);
assert.ok(Math.abs(context.activeGeometry.vents[0].y - 448.5) < 1e-7);
assert.equal(context.viewCanvases.google, undefined);
assert.equal(context.viewCanvases.height, undefined);
assert.equal(context.viewCanvases.ai_geo.keep, true);
assert.equal(context.adjustedViewCanvases.google, undefined);
assert.equal(context.adjustedViewCanvases.ai_geo.keep, true);
assert.equal(Object.keys(context.maskedViewCanvases).length, 0);
assert.equal(context.layerData.rgb.length, 3);
assert.equal(context.layerData.rgb[0].length, 1194 * 1197);
assert.equal(context.viewCanvases.solar.width, 1194);
assert.equal(context.viewCanvases.solar.height, 1197);

console.log('PASS: DSM-only projects adopt the height-map projection and reproject saved geometry.');
