import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const source=await readFile(new URL('../../measure/internal/editor_scripts/maps.js',import.meta.url),'utf8');
const start=source.lastIndexOf('function setLayerScaleToMatchSolar(');
const end=source.indexOf('\n}',start)+2;
test('reopening and rescaling keep technician calibration, offsets and rotation',()=>{
 const cfg={scale:2,fineScale:1.25,x:17,y:-9,rot:.1,__zoom:20};
 const c=vm.createContext({ensureLayerCfg:()=>cfg,getSolarMetersPerPixel:()=>.1,webMercatorMetersPerPixel:()=>.2,mapCenterLat:40,imageWidth:1000});
 vm.runInContext(source.slice(start,end),c);
 for(let i=0;i<3;i++){
  vm.runInContext("setLayerScaleToMatchSolar('google',20,1000,1000)",c);
  assert.equal(cfg.scale*cfg.fineScale,2.5,'saved 25% adjustment must not disappear');
  assert.equal(cfg.x,17);assert.equal(cfg.y,-9);assert.equal(cfg.rot,.1);
 }
 vm.runInContext("setLayerScaleToMatchSolar('google',20,2000,1000)",c);
 assert.equal(cfg.scale*cfg.fineScale,5,'new provider size still preserves calibration');
});
