const test=require('node:test'),assert=require('node:assert/strict');
const T=require('../public/measure/internal/editor_scripts/wall_trim.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),F=require('../public/measure/internal/editor_scripts/wall_features.js');
const p=(x,z,y=0)=>({x,y,z}),w=.1524;
const local=f=>{const fr=W.faceFrame(f);return {fr,points:f.points.map(q=>W.inFrame(fr,q)),holes:(f.holes||[]).map(r=>r.map(q=>W.inFrame(fr,q)))};};
const area=f=>K.area(local(f));
const inRing=(r,q)=>{let yes=false;for(let i=0,j=r.length-1;i<r.length;j=i++){const a=r[i],b=r[j];if((a.z>q.z)!==(b.z>q.z)&&q.x<(b.x-a.x)*(q.z-a.z)/(b.z-a.z)+a.x)yes=!yes;}return yes;};
const inFace=(f,q)=>inRing(f.points,q)&&!(f.holes||[]).some(r=>inRing(r,q));
const wall={id:'wall',points:[p(0,0),p(4,0),p(4,3),p(0,3)],holes:[[p(.5,1),p(1,1),p(1,2),p(.5,2)]],material:'siding',finishColor:'#112233'};
const neighbour={id:'next',points:[p(4,0),p(8,0),p(8,3),p(4,3)],material:'siding'};
const corner={id:'side',points:[p(0,0),p(0,0,3),p(0,3,3),p(0,3)],material:'siding'};
const faceTrim=(faces,hosts,width=w,color)=>T.partition(faces,hosts.flatMap(h=>T.faceEdges(faces,h)),0,width,hosts.flatMap(h=>T.faceEdges(faces,h)),color,{inside:hosts});

test('face trim lies inside the face on every edge, holes included, and leaves neighbours untouched',()=>{
 const faces=[wall,neighbour,corner],before=JSON.stringify(faces),result=faceTrim(faces,['wall'],w,'#ffffff');
 assert.equal(JSON.stringify(faces),before);assert.deepEqual(result.replacements.map(r=>r.face.id),['wall'],'only the selected face is divided');
 const pieces=result.replacements[0].pieces,trim=pieces.filter(f=>f.trim);
 assert.ok(Math.abs(pieces.reduce((s,f)=>s+area(f),0)-11.5)<1e-6,'the face keeps its full area');
 const band=12-(4-2*w)*(3-2*w),ring=(.5+2*w)*(1+2*w)-.5;
 assert.ok(Math.abs(trim.reduce((s,f)=>s+area(f),0)-band-ring)<1e-6,'a one-sided band of the width along the outline and around the hole');
 for(const f of trim){assert.equal(f.finishColor,'#ffffff');assert.ok(f.points.every(q=>q.y===0&&q.x>=-1e-9&&q.x<=4+1e-9&&q.z>=-1e-9&&q.z<=3+1e-9));}
 // Every edge, holes included, has trim just inside it and none just outside it.
 const covered=q=>trim.some(f=>inFace(f,q));
 for(const ring of [wall.points,...wall.holes])for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length],m={x:(a.x+b.x)/2,y:0,z:(a.z+b.z)/2},n={x:-(b.z-a.z),z:b.x-a.x},l=Math.hypot(n.x,n.z);
  const s1={x:m.x+n.x/l*w/2,y:0,z:m.z+n.z/l*w/2},s2={x:m.x-n.x/l*w/2,y:0,z:m.z-n.z/l*w/2},[inner,outer]=inFace(wall,s1)?[s1,s2]:[s2,s1];
  assert.ok(covered(inner),'trim inside edge '+i);assert.ok(!covered(outer),'nothing outside edge '+i);}
 // Concave hole corners are filled, not notched.
 assert.ok(covered(p(.5-w/2,1-w/2))&&covered(p(1+w/2,2+w/2)));
 const layers=T.insideLayers(pieces,['wall']);assert.equal(layers.length,8);assert.ok(layers.every(l=>l.side==='inside'&&l.host==='wall'&&Math.abs(l.width-w)<1e-12&&l.finishColor==='#ffffff'));
});

test('arched edges are followed by the inside strip',()=>{
 const arc=[];for(let i=0;i<=16;i++){const t=Math.PI*i/16;arc.push(p(2+Math.cos(t)*1.5,3+Math.sin(t)*1.5));}
 const arch={id:'arch',points:[p(.5,0),p(3.5,0),...arc],material:'siding'};
 const pieces=faceTrim([arch],['arch'],.1).replacements[0].pieces,trim=pieces.filter(f=>f.trim);
 for(let i=1;i<arc.length-2;i++){const a=arc[i],b=arc[i+1],m={x:(a.x+b.x)/2,z:(a.z+b.z)/2},c={x:2-m.x,z:3-m.z},l=Math.hypot(c.x,c.z),q=p(m.x+c.x/l*.05,m.z+c.z/l*.05),out=p(m.x+c.x/l*.15,m.z+c.z/l*.15);
  assert.ok(trim.some(f=>inFace(f,q)),'curve facet '+i+' has trim inside it');assert.ok(!trim.some(f=>inFace(f,out)),'and the strip keeps its width');}
});

test('width and colour change by removing the face layers and partitioning again; removal restores the face',()=>{
 const first=faceTrim([wall,neighbour],['wall']).replacements[0].pieces,scene=[...first,neighbour];
 const ids=T.insideLayers(scene,['wall']).map(l=>l.id),removed=T.removeLayers(scene,ids);
 const restored=scene.flatMap(f=>removed.replacements.find(r=>r.face===f)?.pieces||[f]);
 assert.equal(restored.filter(f=>T.hostOf(f)==='wall').length,1,'the face merges back into one piece');assert.ok(!restored.some(f=>f.trim));
 assert.ok(Math.abs(restored.filter(f=>T.hostOf(f)==='wall').reduce((s,f)=>s+area(f),0)-11.5)<1e-6);
 assert.equal(T.faceEdges(scene,'wall').length,8,'the original outline and hole are recovered from the pieces');
 const wider=faceTrim(restored,['wall'],.2,'#aa0000').replacements[0].pieces;
 assert.ok(T.insideLayers(wider,['wall']).every(l=>Math.abs(l.width-.2)<1e-12&&l.finishColor==='#aa0000'));
});

test('line trim stays two-sided at corners and sticker trim stays outside the opening',()=>{
 const result=T.partition([wall,corner],[[p(0,0),p(0,3)]],0);assert.equal(result.replacements.length,2,'a corner line trims both walls');
 for(const r of result.replacements)assert.ok(r.pieces.filter(f=>f.trim).every(f=>!f.trimData.layers.some(l=>l.side)));
 const pts=[p(1,1),p(2,1),p(2,2),p(1,2)],ring=F.trimFaces(pts,F.setTrim({type:'window'},2));assert.ok(ring.length);
 assert.ok(ring.every(f=>f.points.every(q=>!(q.x>1+1e-6&&q.x<2-1e-6&&q.z>1+1e-6&&q.z<2-1e-6))),'opening trim sits outside the opening');
});
