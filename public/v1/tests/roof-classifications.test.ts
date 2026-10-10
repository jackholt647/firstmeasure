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
