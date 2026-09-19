const test=require('node:test'),assert=require('node:assert/strict'),F=require('../public/measure/internal/editor_scripts/wall_features.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js');const p=(x,y,z=0)=>({x,y,z});
test('catalog and dimensions use feet and support new definitions',()=>{assert.equal(F.defs.get('garage').sizes[0].w,16);const points=[p(0,0),p(4*F.FT,0),p(4*F.FT,6*F.FT),p(0,6*F.FT)];assert.equal(F.label(points),'4 × 6 ft');F.register({id:'test',name:'Test',sizes:[{w:1,h:1,shape:'rectangle'}]});assert.ok(F.defs.has('test'));});
test('resizing preserves free center, bottom center, edge, and corner anchors',()=>{const points=F.shape({left:1,right:2,bottom:2,top:3}),size={w:4,h:6};for(const anchor of [{},{bottom:true},{right:true},{left:true,bottom:true}]){const b=F.bounds(F.resized(points,size,anchor));assert.ok(Math.abs((b.right-b.left)-4*F.FT)<1e-8);if(anchor.bottom)assert.equal(b.bottom,2);else assert.equal((b.bottom+b.top)/2,2.5);if(anchor.right)assert.equal(b.right,2);else if(anchor.left)assert.equal(b.left,1);else assert.equal((b.left+b.right)/2,1.5);}});
test('nearby floor snaps but elevated placements remain elevated',()=>{const boundary=[F.shape({left:0,right:10,bottom:0,top:5})],size={w:3,h:6+8/12},screen=p=>({x:p.x*100,y:p.y*100});const low=F.place(p(4,size.h*F.FT/2+.05),size,boundary,screen),high=F.place(p(4,size.h*F.FT/2+.5),size,boundary,screen);assert.equal(F.bounds(low).bottom,0);assert.ok(Math.abs(F.bounds(high).bottom-.5)<1e-9);assert.equal(F.anchors(low,boundary).bottom,true);});
test('placement validation rejects crossing concavities and overlapping features',()=>{const outline=[p(0,0),p(4,0),p(4,4),p(3,4),p(3,1),p(1,1),p(1,4),p(0,4)];assert.throws(()=>F.validate(F.shape({left:.5,right:3.5,bottom:.5,top:2}),[outline]));const host=F.shape({left:0,right:5,bottom:0,top:5}),a=F.shape({left:1,right:2,bottom:1,top:2});assert.throws(()=>F.validate(a,[host],[{points:a}]));});
test('upright frame gives true dimensions on a rotated wall and round vents stay planar',()=>{const source=[p(0,0,0),p(3,4,0),p(3,4,3),p(0,0,3)],frame=F.frame(source),points=F.shape({left:0,right:2,bottom:0,top:2},'circle').map(p=>W.fromFrame(frame,p));assert.equal(points.length,48);for(const p of points)assert.ok(Math.abs(p.x*4-p.y*3)<1e-8);assert.ok(Math.abs(F.dimensions(points).width-2/F.FT)<1e-8);});
test('rotated custom feature dimensions and resize axes keep their orientation',()=>{const s=Math.SQRT1_2,points=[p(0,0),p(2*s,2*s),p(-s,5*s),p(-3*s,3*s)],f=F.orientedFrame(points),metadata={axis:f.u},local=points.map(p=>W.inFrame(f,p)),next=F.resized(local,{w:4,h:6}).map(p=>W.fromFrame(f,p)),d=F.dimensions(next,metadata);assert.ok(Math.abs(d.width-4)<1e-8);assert.ok(Math.abs(d.height-6)<1e-8);assert.ok(Math.abs(f.u.x)>0&&Math.abs(f.u.y)>0);});

test('view frame is camera-relative for either winding and oblique upright walls',()=>{
 for(const angle of [0,.4,1.5,2.9])for(const side of [-1,1])for(const reverse of [false,true]){const u={x:Math.cos(angle),y:Math.sin(angle),z:0},points=[p(0,0,0),p(u.x*4,u.y*4,0),p(u.x*4,u.y*4,3),p(0,0,3)];if(reverse)points.reverse();const screen=p=>({x:side*(p.x*u.x+p.y*u.y)*80,y:-p.z*90+(p.x*u.x+p.y*u.y)*20}),f=F.viewFrame(points,screen),a=screen(f.origin),right=screen({x:f.origin.x+f.u.x,y:f.origin.y+f.u.y,z:f.origin.z+f.u.z}),up=screen({x:f.origin.x+f.v.x,y:f.origin.y+f.v.y,z:f.origin.z+f.v.z});assert.ok(right.x>a.x);assert.ok(up.y<a.y);assert.ok(Math.abs(f.u.z)<1e-7);assert.ok(Math.abs(Math.hypot(f.u.x,f.u.y,f.u.z)-1)<1e-7);}
});


test('sticker placement aligns height across a gap and width to host boundaries',()=>{
 const size={w:1/F.FT,h:1/F.FT},host=F.shape({left:0,right:8,bottom:0,top:6}),neighbor=F.shape({left:1,right:2,bottom:2,top:3}),screen=p=>({x:p.x*100,y:p.y*100});
 const b=F.bounds(F.place(p(4.5,2.56),size,[host,neighbor],screen));assert.equal(b.bottom,2);assert.equal(b.top,3);assert.equal(b.left,4);
 const edge=F.bounds(F.place(p(.55,4.5),size,[host,neighbor],screen));assert.ok(Math.abs(edge.left)<1e-9);
 const free=F.bounds(F.place(p(4.5,2.56),size,[host,neighbor],screen,0));assert.ok(Math.abs(free.bottom-2.06)<1e-9);
});


test('full-height garage fits from low and high pointers without changing its size',()=>{
 const size=F.defs.get('garage').sizes[0],wall=F.shape({left:0,right:20*F.FT,bottom:0,top:7*F.FT}),screen=p=>({x:p.x*100,y:p.y*100});assert.equal(F.defs.get('garage').key,'g');
 for(const y of [.01,1,7*F.FT-.01])for(const radius of [0,12]){const points=F.place(p(10*F.FT,y),size,[wall],screen,radius),b=F.bounds(points);assert.ok(Math.abs(b.bottom)<1e-8);assert.ok(Math.abs(b.top-7*F.FT)<1e-8);assert.ok(Math.abs(b.right-b.left-16*F.FT)<1e-8);F.validate(points,[wall]);}
 assert.throws(()=>F.place(p(3,.1),{w:16,h:8},[wall],screen),/does not fit/);
});

test('feature fitting respects sloped ceilings and excludes existing openings',()=>{
 const wall=[p(0,0),p(8,0),p(8,4),p(0,2)],size={w:2/F.FT,h:2/F.FT},screen=p=>({x:p.x*100,y:p.y*100}),hole=F.shape({left:3,right:5,bottom:0,top:3});
 const points=F.place(p(1,1.9),size,[wall],screen,0);F.validate(points,[wall]);assert.ok(F.bounds(points).top<=2+1e-7);
 const fitted=F.place(p(4,.1),size,[wall],screen,0,[{points:wall,holes:[hole]}]);F.validate(fitted,[wall],[{points:hole}]);
});


test('expanded size catalog preserves saved presets and defaults garage placement to eight by seven',()=>{
 const garage=F.defs.get('garage');assert.deepEqual(garage.sizes[garage.defaultPreset],{w:8,h:7,shape:'rectangle'});assert.deepEqual(garage.sizes.slice(0,3).map(s=>[s.w,s.h]),[[16,7],[9,7],[8,7]]);
 const windows=F.defs.get('window').sizes;for(const h of [1,2,3,4,5,6])assert.ok(windows.some(s=>s.w===1&&s.h===h));assert.deepEqual(windows[0],{w:3,h:4,shape:'rectangle'});
 for(const def of F.defs.values())assert.equal(new Set(def.sizes.map(s=>[s.w,s.h,s.shape].join(':'))).size,def.sizes.length);
});

test('full-height garage aligns its side to an inserted base-edge point without resizing',()=>{
 const size={w:8,h:7,shape:'rectangle'},host=F.shape({left:0,right:8,bottom:0,top:7*F.FT}),anchor=p(1.2,0),center=p(1.2+4*F.FT+.06,.2),screen=p=>({x:p.x*100,y:p.y*100});
 const placed=F.bounds(F.place(center,size,[host,[anchor]],screen,12,[{points:host}]));assert.ok(Math.abs(placed.left-1.2)<1e-8);assert.ok(Math.abs(placed.bottom)<1e-8);assert.ok(Math.abs(placed.right-placed.left-8*F.FT)<1e-8);
 const free=F.bounds(F.place(center,size,[host,[anchor]],screen,0,[{points:host}]));assert.ok(Math.abs(free.left-1.26)<1e-8);
});


test('competing door floor and header snaps follow the pointer instead of boundary order',()=>{
 const height=7*F.FT,size={w:3,h:6+8/12},screen=p=>({x:p.x*100,y:p.y*100}),wall=F.shape({left:0,right:4,bottom:0,top:height});
 for(const outline of [wall,[...wall].reverse()])for(const y of [.05,height/2-.01,height/2+.01,height-.05]){
  const b=F.bounds(F.place(p(2,y),size,[outline],screen));
  if(y<height/2)assert.ok(Math.abs(b.bottom)<1e-8,'lower pointer chooses floor');
  else assert.ok(Math.abs(b.top-height)<1e-8,'upper pointer chooses header');
  assert.ok(Math.abs(b.top-b.bottom-size.h*F.FT)<1e-8);
 }
});


test('sticker snaps minimize translation from the unsnapped fitted footprint',()=>{
 const size={w:3,h:80/12},host=F.shape({left:0,right:5,bottom:0,top:4}),screen=p=>({x:p.x*100,y:p.y*100});
 const center=p(2,.3+size.h*F.FT/2),lower=[p(0,.25)],upper=[p(0,.3+size.h*F.FT-.102)];
 for(const targets of [[lower,upper],[upper,lower]]){
  const free=F.bounds(F.place(center,size,[host,...targets],screen,0,[{points:host}]));
  const snapped=F.bounds(F.place(center,size,[host,...targets],screen,12,[{points:host}]));
  assert.ok(Math.abs(free.bottom-.3)<1e-8);
  assert.ok(Math.abs(snapped.bottom-.25)<1e-8,'choose 0.05m translation, not the target closest to the cursor');
 }
});


test('low and high cursors clamp continuously on an irregular wall with a sloped floor',()=>{
 const wall=[p(0,0),p(6,.6),p(6,3),p(3,3),p(3,4),p(0,4)],size={w:1/F.FT,h:2/F.FT},screen=p=>({x:p.x*100,y:p.y*100});
 for(const outline of [wall,[...wall].reverse()])for(const centerY of [-4,0,1,1.25,1.5,1.75,2,3,8]){
  const expected=Math.max(.5,Math.min(1,centerY-1));
  const b=F.bounds(F.place(p(4.5,centerY),size,[outline],screen,0));
  assert.ok(Math.abs(b.bottom-expected)<1e-8,`cursor ${centerY}: expected bottom ${expected}, got ${b.bottom}`);
  assert.ok(Math.abs(b.left-4)<1e-8);assert.ok(Math.abs(b.top-b.bottom-2)<1e-8);
 }
});

test('different sized windows snap center to center independently of trim',()=>{
 const source={feature:{type:'window',trim:{width:.5}},points:[p(1,1),p(3,1),p(3,3),p(1,3)]},frame=W.faceFrame(source),targets=W.stickerAlignmentTargets([source],frame),center=targets.find(p=>p.alignmentCenter),local=W.inFrame(frame,center),boundary=F.shape({left:-10,right:10,bottom:-10,top:10});
 const points=F.place(p(local.x+.04,local.y+.06),{w:3,h:4},[boundary,[{...local,alignmentCenter:true,alignmentAxes:['x','y']}]],p=>({x:p.x*100,y:p.y*100}),12,[{points:boundary}]),b=F.bounds(points);
 assert.ok(Math.abs((b.left+b.right)/2-local.x)<1e-8);assert.ok(Math.abs((b.bottom+b.top)/2-local.y)<1e-8);
});
