import test from 'node:test';
import assert from 'node:assert/strict';
import {measurementPayloadFromSavedReport} from '../platform/publication/firstmeasure-datasets.js';
test('saved editor classifications and exact pitch areas survive publication without recalculation',()=>{
 const saved={report:{materials:{linear:{ridge:147.4793386749316,chimney_edge:12.3,chimney_front:8.2,chimney_back:5,skylight:16,parapet:9,trans:4,protrusion:3},squares:{'3/12':9.96,'7/12':32.64,'10/12':2.58},totalSquares:45.18,ventilationSquares:45.18}}};const before=structuredClone(saved),m=measurementPayloadFromSavedReport(saved);
 assert.equal(m.ridgesLf?.value,147.4793386749316);assert.equal(m.chimneyStepLf?.value,12.3);assert.equal(m.skylightLf?.value,16);assert.equal(m.parapetLf?.value,9);assert.equal(m.pitch7Squares?.value,32.64);assert.equal(m.roofArea?.value,4518);assert.equal(m.roofSquares?.unit,'roofing_square');assert.equal(m.chimneysEa,undefined);assert.deepEqual(saved,before);
 assert.deepEqual(measurementPayloadFromSavedReport({report:{lines:[{type:'chimney_edge',length:4},{type:'chimney_edge',length:5},{type:'skylight',length:NaN},{type:'hip',length:-1}]}}),{chimneyStepLf:{value:9,unit:'ft',source:'firstmeasure'}});
});
