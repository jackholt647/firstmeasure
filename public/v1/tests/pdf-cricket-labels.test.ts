import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../measure/internal/editor_scripts/pdf.js',import.meta.url),'utf8');
const extract=(a:string,b:string)=>source.slice(source.indexOf(`function ${a}(`),source.indexOf(`function ${b}(`));
const corner={x:10,y:10,z:0};
const chimney=[corner,{x:20,y:10,z:0},{x:20,y:20,z:0},{x:10,y:20,z:0}];
const lines=chimney.map((p,i)=>({type:'chimney_edge',points:[p,chimney[(i+1)%4]]}));
function labels(faces:any[],autoExcludedFacetIndexes:number[]=[]){
 const context=vm.createContext({window:{},document:{createElement:()=>({getContext:()=>({measureText:()=>({width:10})})})},
  getReportAutoExcludedFaceIndexSet:({autoExcludedFacetIndexes=[]}:any)=>new Set(autoExcludedFacetIndexes),
  getSignedArea:()=>50,getPdfMetersPerPx:()=>1,localFitPlane:()=>({a:0.5,b:0}),
  isPolygonContained:()=>false,polygonsIntersectRough:()=>false,getPoleOfInaccessibility:()=>({x:30,y:30,dist:100}),
  getPolygonCentroid:()=>({x:30,y:30}),faces,lines,autoExcludedFacetIndexes});
 vm.runInContext(extract('isObstacleFace','ensurePdfGutterSettings'),context);
 vm.runInContext(extract('buildDefaultDiagramLabelsInternal','polygonsIntersectRough'),context);
 return vm.runInContext('buildDefaultDiagramLabelsInternal({report:{lines},facesData:faces,cropRegion:{minX:0,minY:0,width:100,height:100},dims:{w:100},autoExcludedFacetIndexes})',context);
}
test('cricket pitch remains when sharing chimney corners, independent of vertex order',()=>{
 const points=[corner,{x:15,y:0,z:5},{x:20,y:10,z:0}];
 for(let i=0;i<3;i++){
  const result=labels([{points:[...points.slice(i),...points.slice(0,i)]},{points:chimney}]);
  assert.equal(result.length,1);assert.equal(result[0].text,'6/12');
 }
});
test('unrelated same-X roof face stays labeled; actual obstacles and excluded duplicates stay hidden',()=>{
 const face={points:[{x:20,y:60,z:0},{x:30,y:60,z:0},{x:20,y:70,z:5}]};
 assert.equal(labels([face,{points:chimney}]).length,1);
 assert.equal(labels([face], [0]).length,0);
});
