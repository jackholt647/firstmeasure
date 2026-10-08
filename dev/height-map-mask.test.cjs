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
for(const rotation of [.3,-.71,Math.PI/2])test(`rectangle preview and painted area follow view rotation ${rotation}`,()=>{
 const a={x:12,y:10},b={x:32,y:33},c=Math.cos(rotation),s=Math.sin(rotation),screen=p=>({x:p.x*c-p.y*s,y:p.x*s+p.y*c}),corners=M.rectangleCorners(a,b,rotation).map(screen);
 assert.ok(Math.abs(corners[0].y-corners[1].y)<1e-8);assert.ok(Math.abs(corners[1].x-corners[2].x)<1e-8);
 const m=M.create(45,45),reverse=M.create(45,45);m.paint(a,b,0,false,true,rotation);reverse.paint(b,a,0,false,true,rotation);assert.deepEqual(m.data,reverse.data);
 const lo=screen(a),hi=screen(b);
 for(let y=0;y<45;y++)for(let x=0;x<45;x++){const p=screen({x,y}),inside=p.x>=Math.min(lo.x,hi.x)-1e-8&&p.x<=Math.max(lo.x,hi.x)+1e-8&&p.y>=Math.min(lo.y,hi.y)-1e-8&&p.y<=Math.max(lo.y,hi.y)+1e-8;assert.equal(m.data[y*45+x],Number(inside));}
 m.paint(b,a,0,true,true,rotation);assert.ok(m.data.every(v=>v===0));
});
