import test from 'node:test';
import assert from 'node:assert/strict';
import {reportEdgeTypes} from '../platform/widgets/roof-classifications.js';
test('saved classifications retain chimney, skylight and transition identity with XML point deduplication',()=>{
 const a={x:0,y:0},b={x:10,y:0},c={x:10,y:10},d={x:0,y:10};
 const state={geometry:{points:[a,{x:.1,y:.1},b,c,d]},report:{lines:[{points:[a,b],type:'chimney_edge'},{points:[b,c],type:'chimney_back'},{points:[c,d],type:'skylight'},{points:[d,a],type:'trans'},{points:[a,{x:99,y:99}],type:'eave'}]}};
 const before=JSON.stringify(state);assert.deepEqual(reportEdgeTypes(state),[{path:'C1,C2',type:'CHIMNEY_EDGE'},{path:'C2,C3',type:'CHIMNEY_BACK'},{path:'C3,C4',type:'SKYLIGHT'},{path:'C1,C4',type:'TRANS'}]);assert.equal(JSON.stringify(state),before);
 assert.deepEqual(reportEdgeTypes({geometry:{points:[a,b],connections:[{start:b,end:a,type:'stepflash'}]}}),[{path:'C1,C2',type:'SIDE_WALL'}]);
 assert.deepEqual(reportEdgeTypes({geometry:{points:[a,b],connections:[{start:a,end:b,type:'arbitrary'}]}}),[]);assert.deepEqual(reportEdgeTypes({}),[]);
});
// FM-455: model_data.xml written since FM-405 keeps two points at one plan position apart when their heights differ
// (a lower roof's corner under an upper roof's), so every later point id moves by one. With the stored XML, the ids
// are numbered as that generator numbered them, and an older plan-only XML keeps plan-only ids.
test('saved classifications follow the point ids of the XML they are drawn on',()=>{
 const upper={x:0,y:0,z:6},lower={x:0,y:0,z:3},b={x:10,y:0,z:6},c={x:10,y:10,z:3},d={x:0,y:10,z:3};
 const state={geometry:{points:[upper,lower,b,c,d]},report:{lines:[{points:[upper,b],type:'ridge'},{points:[b,c],type:'protrusion'},{points:[c,d],type:'eave'},{points:[d,lower],type:'chimney_back'}]}};
 // Since FM-405: upper C1, lower C2, b C3, c C4, d C5.
 const split='<ROOF><LINES><LINE id="L1" path="C1,C3" type="RIDGE"/><LINE id="L2" path="C3,C4" type="EAVE"/><LINE id="L3" path="C4,C5" type="EAVE"/><LINE id="L4" path="C5,C2" type="FLASHING"/></LINES></ROOF>';
 assert.deepEqual(reportEdgeTypes(state,split),[{path:'C1,C3',type:'RIDGE'},{path:'C3,C4',type:'PROTRUSION'},{path:'C4,C5',type:'EAVE'},{path:'C2,C5',type:'CHIMNEY_BACK'}]);
 // Before FM-405: one corner C1, b C2, c C3, d C4.
 const plan='<ROOF><LINES><LINE id="L1" path="C1,C2" type="RIDGE"/><LINE id="L2" path="C2,C3" type="EAVE"/><LINE id="L3" path="C3,C4" type="EAVE"/><LINE id="L4" path="C4,C1" type="FLASHING"/></LINES></ROOF>';
 const planTypes=[{path:'C1,C2',type:'RIDGE'},{path:'C2,C3',type:'PROTRUSION'},{path:'C3,C4',type:'EAVE'},{path:'C1,C4',type:'CHIMNEY_BACK'}];
 assert.deepEqual(reportEdgeTypes(state,plan),planTypes);
 assert.deepEqual(reportEdgeTypes(state),planTypes,'without the XML, plan position alone as before');
});
