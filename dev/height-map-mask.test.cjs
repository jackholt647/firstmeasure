const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../public/measure/internal/editor_scripts/height_map_mask');
test('brush paints continuous strokes and erase only restores the selected pixels',()=>{
 const m=M.create(40,30);m.paint({x:3,y:10},{x:36,y:10},3);
 for(let x=3;x<=36;x++)assert.equal(m.data[10*40+x],1);
 assert.equal(m.data[5*40+20],0);m.paint({x:20,y:10},{x:20,y:10},2,true);
 assert.equal(m.data[10*40+20],0);assert.equal(m.data[10*40+10],1);
});
test('rectangles clip to the image, work in either direction, and round trip compactly',()=>{
 const m=M.create(10,10);m.paint({x:15,y:15},{x:7,y:7},0,false,true);
 assert.equal(m.data.reduce((a,b)=>a+b,0),9);const saved=m.serialize();assert.deepEqual(M.create(10,10,saved).data,m.data);
 m.paint({x:7,y:7},{x:8,y:8},0,true,true);assert.equal(m.data.reduce((a,b)=>a+b,0),5);m.load(saved);assert.equal(m.data.reduce((a,b)=>a+b,0),9);
});
test('masked triangles are absent from drawing and picking without changing source geometry',()=>{
 const indices=new Uint32Array([0,1,2,1,3,2,4,5,6]),mask=new Uint8Array(7);mask[0]=1;
 assert.deepEqual(Array.from(M.visibleIndices(indices,mask)),[1,3,2,4,5,6]);assert.equal(indices.length,9);
 mask.fill(0);assert.deepEqual(M.visibleIndices(indices,mask),indices);
});
