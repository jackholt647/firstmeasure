const test=require('node:test'),assert=require('node:assert/strict');
const PDF=require('../public/measure/internal/editor_scripts/exterior_pdf.js');
test('browser and server agree on the PDF render recipe version',()=>{
 const fs=require('fs'),version=path=>fs.readFileSync(path,'utf8').match(/const PDF_RENDER_RECIPE_VERSION = ['"]([^'"]+)/)[1];
 assert.equal(version('public/measure/internal/editor_scripts/pdf_standalone.js'),version('public/v1/firstmeasure/api.ts'));
});
const face=(id,area)=>({id,gross:area});
test('house-relative views rotate together and left/right face the front entrance',()=>{
 const views=PDF.houseDirections({frontBearing:90});assert.equal(views.length,8);
 const front=views.find(v=>v.id==='front'),left=views.find(v=>v.id==='left'),right=views.find(v=>v.id==='right');
 assert.ok(Math.abs(front.x-1)<1e-10&&Math.abs(front.y)<1e-10);
 assert.ok(Math.abs(left.y-1)<1e-10);assert.ok(Math.abs(right.y+1)<1e-10);
 assert.equal(PDF.relativeSide({x:Math.SQRT1_2,y:-Math.SQRT1_2},{frontBearing:90}),'Front Right');
});
test('four main photo slots default on; customer assignments win and manual assignments survive',()=>{
 const s={};PDF.initializePhotoSlots(s,[{key:'tech',role:'tech',label:'Front'},{key:'customer',role:'customer',slot:'front',label:'Customer entrance'},{key:'corner',role:'customer',slot:'front-left',label:'Corner'}]);
 assert.equal(s.photoSlots.front.image.key,'customer');assert.equal(s.photoSlots['front-left'].image.key,'corner');assert.equal(PDF.selectedPhotos(s).length,5);assert.equal(PDF.photosComplete(s),false);
 s.photoSlots.front.image={key:'manual'};s.photoSlots.front.assignment='manual';PDF.initializePhotoSlots(s,[{key:'new',role:'customer',slot:'front'}]);assert.equal(s.photoSlots.front.image.key,'manual');
 for(const id of ['back','left','right'])s.photoSlots[id].image={key:id};assert.equal(PDF.photosComplete(s),true);
 const defaults={};PDF.initializePhotoSlots(defaults);assert.deepEqual(PDF.selectedPhotos(defaults).map(p=>p.direction),['Front','Back','Left','Right']);
 const auto={};PDF.initializePhotoSlots(auto,[{key:'fallback',role:'tech',slot:'front'}]);PDF.initializePhotoSlots(auto,[{key:'uploaded',role:'customer',slot:'front'}]);assert.equal(auto.photoSlots.front.image.key,'uploaded');
 auto.photoSlots.front.image=null;auto.photoSlots.front.assignment='manual';PDF.initializePhotoSlots(auto,[{key:'uploaded',role:'customer',slot:'front'}]);assert.equal(auto.photoSlots.front.image,null);
});
test('customer elevation references retain their explicit project slot',()=>{
 const {referenceCatalog}=require('../public/measure/internal/editor_scripts/project_resources.js');
 const images=referenceCatalog({manifest:{elevation_photos:{'front-right':{file_name:'entrance.jpg'},back:'back.jpg'}}},name=>'/artifacts/'+name);
 assert.equal(images.length,2);assert.equal(images[0].slot,'front-right');assert.ok(images.every(i=>i.role==='customer'));assert.equal(images[1].src,'/artifacts/back.jpg');
});
test('dimension pages fit major, medium, small and mixed faces without blank cells',()=>{
 for(const [areas,width,height]of [[[200,200],1,.5],[[50,50,50,50],.5,.5],[Array(9).fill(10),1/3,1/3]]){
  const pages=PDF.dimensionPages(areas.map((a,i)=>face('W'+i,a)));assert.equal(pages.length,1);for(const p of pages[0]){assert.equal(p.w,width);assert.equal(p.h,height);}
 }
 const [mixed]=PDF.dimensionPages([400,10,10,10].map((a,i)=>face('W'+i,a)));
 assert.equal(mixed[0].h,2/3);assert.equal(mixed[0].w,1);assert.equal(mixed[1].y,2/3);
});
test('every dimension face is packed once, without overlap, and each page is filled',()=>{
 for(let count=1;count<=40;count++){
  const faces=Array.from({length:count},(_,i)=>face('W'+i,10+(i*77)%400)),pages=PDF.dimensionPages(faces);
  assert.equal(new Set(pages.flat().map(p=>p.face.id)).size,count);
  for(const panels of pages){assert.ok(Math.abs(panels.reduce((s,p)=>s+p.w*p.h,0)-1)<1e-9);
   for(const [i,p]of panels.entries()){assert.ok(p.x>=0&&p.y>=0&&p.x+p.w<=1+1e-9&&p.y+p.h<=1+1e-9);for(const q of panels.slice(i+1))assert.ok(p.x+p.w<=q.x+1e-9||q.x+q.w<=p.x+1e-9||p.y+p.h<=q.y+1e-9||q.y+q.h<=p.y+1e-9);}
  }
 }
});
const wall=(id,y)=>({id,points:[{x:0,y,z:0},{x:4,y,z:0},{x:4,y,z:4},{x:0,y,z:4}],openings:[]});
const ownerAt=(scene,p)=>{const q=scene.at(p);return scene.surfaces[scene.owners[Math.floor(q.y)*scene.width+Math.floor(q.x)]]?.id;};
test('depth varies across a face and is independent of draw order',()=>{
 const flat=wall('flat',0),crossing=wall('crossing',0);crossing.points=crossing.points.map(p=>({...p,y:p.x-2}));
 for(const faces of [[flat,crossing],[crossing,flat]]){const s=PDF.rasterScene(faces,{x:0,y:-1},160,160,false,10);assert.equal(ownerAt(s,{x:1,y:0,z:2}),'crossing');assert.equal(ownerAt(s,{x:3,y:0,z:2}),'flat');}
});
test('holes reveal underlying surfaces and hidden walls/openings have no labels',()=>{
 const rear=wall('rear',1),front=wall('front',0);front.holes=[[{x:1,y:0,z:1},{x:3,y:0,z:1},{x:3,y:0,z:3},{x:1,y:0,z:3}]];
 const cut=PDF.rasterScene([front,rear],{x:0,y:-1},160,160,false,10);assert.equal(ownerAt(cut,{x:2,y:0,z:2}),'rear');assert.equal(ownerAt(cut,{x:.5,y:0,z:2}),'front');
 front.holes=[];rear.openings=[{...wall('hidden-window',1),type:'window'}];const hidden=PDF.rasterScene([front,rear],{x:0,y:-1},160,160,false,10);
 assert.equal(hidden.labels.find(l=>l.face.id==='rear').count,0);assert.equal(hidden.labels.find(l=>l.face.id==='hidden-window').point,null);
});
test('four elevations (front, back, left, right) use one diagram each and continuation pages contain only data',()=>{
 const fs=require('fs'),vm=require('vm'),R=require('../public/measure/internal/editor_scripts/exterior_report_model.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');
 const context={ExteriorGeometry:K,document:{createElement:()=>({getContext:()=>({createImageData:(w,h)=>({data:new Uint8Array(w*h*4)}),putImageData(){}}),toDataURL:()=> 'data:image/png,test'})}};context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/exterior_pdf.js','utf8'),context);
 const model=R.build({faces:[wall('base',0)]});model.walls=Array.from({length:80},(_,i)=>({...model.walls[0],id:'W'+String(i).padStart(2,'0'),gross:10,net:10,width:3,height:3,points:wall('w',0).points.map(p=>({...p,x:p.x+i*5}))}));
 model.walls[79].material='Horizontal trim';const pages=[];let page;
 const doc=new Proxy({internal:{pageSize:{getWidth:()=>210,getHeight:()=>297}},getTextWidth:s=>String(s).length,splitTextToSize:s=>[s],addImage:()=>page.images++},{get:(o,k)=>k in o?o[k]:(...args)=>{if(k==='text')page.text.push(args[0]);}});
 context.drawExteriorReportPages(doc,model,{},title=>{page={title,images:0,text:[]};pages.push(page);},{});
 const elevations=pages.filter(p=>/Elevation$/.test(p.title));assert.deepEqual(elevations.map(p=>p.title),['Front Elevation','Back Elevation','Left Elevation','Right Elevation']);assert.ok(elevations.every(p=>p.images===1));
 const continued=pages.filter(p=>/Elevation - continued/.test(p.title));assert.ok(continued.length);assert.ok(continued.every(p=>p.images===0));
 assert.ok(pages.some(p=>p.title==='Trim Dimensions'));assert.ok(!pages.some(p=>/takeoff|foundation/i.test(p.title)));
 for(const title of ['Opening Schedule','Exterior Quantities','Material Allowances'])assert.ok(pages.some(p=>p.title===title));
});
// A south-front box house with a hidden inner wall, a small piece and a narrow pilaster.
const SF=1/.3048**2,box=(id,a,b,z0,z1,normal)=>{const points=[{...a,z:z0},{...b,z:z0},{...b,z:z1},{...a,z:z1}],w=Math.hypot(b.x-a.x,b.y-a.y),area=w*(z1-z0)*SF;return {id,points,holes:[],normal,elevation:'',material:'Unassigned',gross:area,net:area,openingArea:0,openings:[],width:w/.3048,height:(z1-z0)/.3048,top:0,bottom:0};};
function boxHouse(){
 const walls=[box('W01',{x:0,y:0},{x:10,y:0},0,3,{x:0,y:-1,z:0}),box('W02',{x:10,y:0},{x:10,y:6},0,3,{x:1,y:0,z:0}),box('W03',{x:10,y:6},{x:0,y:6},0,3,{x:0,y:1,z:0}),box('W04',{x:0,y:6},{x:0,y:0},0,3,{x:-1,y:0,z:0}),
  box('W05',{x:4,y:3},{x:2,y:3},0,2,{x:0,y:1,z:0}),box('W06',{x:5.2,y:6.3},{x:5,y:6.3},1,1.2,{x:0,y:1,z:0}),box('W07',{x:8.25,y:6.2},{x:8,y:6.2},0,3,{x:0,y:1,z:0})];
 const sum=k=>walls.reduce((s,w)=>s+w[k],0);
 return {walls,returns:[],roof:[],openings:[],edges:[],warnings:[],totals:{gross:sum('gross'),net:sum('net'),openingArea:0,openingPerimeter:0,top:0,bottom:0,inside:0,outside:0,transitions:0,terminations:0,returns:0}};
}
test('each wall face is counted on exactly one elevation, hidden or small faces included, and totals reconcile',()=>{
 const model=boxHouse(),plan=PDF.elevationPlan(model,{frontBearing:180},{x:25,y:63,w:170,h:85});
 const counted=plan.views.flatMap(v=>[...v.ids,...v.small]).concat(plan.hidden);
 assert.deepEqual(counted.slice().sort(),model.walls.map(w=>w.id).sort());
 assert.equal(new Set(counted).size,counted.length);
 const byName=Object.fromEntries(plan.views.map(v=>[v.view.name,v]));
 assert.deepEqual(byName.Front.ids.slice().sort(),['W03','W07']);assert.deepEqual(byName.Front.small,['W06']);
 assert.deepEqual(byName.Back.ids,['W01']);assert.deepEqual(byName.Left.ids,['W04']);assert.deepEqual(byName.Right.ids,['W02']);
 assert.deepEqual(plan.hidden,['W05']);
 for(const v of plan.views)for(const id of v.ids){const i=v.scene.surfaces.findIndex(f=>f.id===id);assert.ok(v.scene.counts[i]>0,id+' is visible on '+v.view.name);}
 const gross=plan.views.flatMap(v=>[...v.ids,...v.small]).concat(plan.hidden).reduce((s,id)=>s+model.walls.find(w=>w.id===id).gross,0);
 assert.ok(Math.abs(gross-model.totals.gross)<1e-9);
});
test('there are exactly four elevations, the front turned in steps of 90 degrees, and their totals equal the gross area at any front',()=>{
 for(const frontBearing of [0,37,90,180,213.5,315]){
  const model=boxHouse(),plan=PDF.elevationPlan(model,{frontBearing},{x:25,y:33,w:170,h:110}),front=PDF.houseDirections({frontBearing})[0];
  assert.deepEqual(plan.views.map(v=>v.view.name),['Front','Back','Left','Right']);
  for(const [v,turn]of plan.views.map((v,i)=>[v,[0,180,90,-90][i]])){const a=(frontBearing+turn)*Math.PI/180;assert.ok(Math.abs(v.view.x-Math.sin(a))<1e-12&&Math.abs(v.view.y+Math.cos(a))<1e-12,v.view.name+' at '+frontBearing);}
  assert.ok(Math.abs(plan.views[0].view.x-front.x)<1e-12);
  const counted=plan.views.flatMap(v=>[...v.ids,...v.small]).concat(plan.hidden);assert.equal(counted.length,model.walls.length);assert.equal(new Set(counted).size,counted.length);
  const sum=(ids,k)=>ids.reduce((s,id)=>s+model.walls.find(w=>w.id===id)[k],0);
  for(const k of ['gross','net'])assert.ok(Math.abs(plan.views.reduce((s,v)=>s+sum([...v.ids,...v.small],k),0)+sum(plan.hidden,k)-model.totals[k])<1e-9,k+' at '+frontBearing);
  for(const v of plan.views)assert.ok(v.rect.h<=110&&v.rect.h>=40&&v.rect.y===33,'drawing fits its content');
 }
});
test('every face in an elevation table is labeled in its drawing, and every label is in the table',()=>{
 const fs=require('fs'),vm=require('vm'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),context={ExteriorGeometry:K};context.window=context;vm.createContext(context);
 vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/exterior_pdf.js','utf8'),context);
 const pages=[];let page,font='normal',size=9;
 const doc=new Proxy({internal:{pageSize:{getWidth:()=>210,getHeight:()=>297}},getTextWidth:s=>String(s).length,splitTextToSize:s=>[s],setFont:(f,style)=>{font=style;},setFontSize:s=>{size=s;},text:(value,x,y)=>page.text.push({value:String(value),bold:font==='bold',size,x,y}),line:(...a)=>page.lines.push(a),circle:()=>page.circles++},{get:(o,k)=>k in o?o[k]:()=>{}});
 context.drawExteriorReportPages(doc,boxHouse(),{frontBearing:180},title=>{page={title,text:[],lines:[],circles:0};pages.push(page);},{});
 const elevations=pages.filter(p=>/ Elevation$/.test(p.title));assert.equal(elevations.length,4);
 for(const p of elevations){
  const labels=p.text.filter(t=>t.bold&&t.size<=7&&/^W\d+$/.test(t.value)).map(t=>t.value).sort(),rows=p.text.filter(t=>!t.bold&&t.size===8&&/^W\d+$/.test(t.value)).map(t=>t.value).sort();
  assert.deepEqual(labels,rows,p.title);
 }
 const front=elevations.find(p=>p.title==='Front Elevation');assert.ok(front.text.some(t=>t.value==='W07'&&t.bold));assert.ok(front.circles>0&&front.text.some(t=>t.value==='W07'&&t.size===5.5),'the narrow face gets a leader line');
 assert.ok(front.text.some(t=>t.value==='1 piece < 1 ft²'),'small pieces are one short row');assert.ok(!pages.some(p=>p.text.some(t=>/^Small pieces/.test(t.value))));assert.ok(front.text.some(t=>/^Total/.test(t.value)&&t.bold));
 assert.ok(!pages.some(p=>p.text.some(t=>/irreducible|Unassigned/.test(t.value))));assert.ok(pages.some(p=>p.title==='Hidden Wall Faces'&&p.text.some(t=>t.value==='W05')));
 assert.ok(front.text.some(t=>t.value==='Openings ft²'));assert.ok(front.text.some(t=>t.value==='Gross ft²'));assert.ok(!front.text.some(t=>t.value==='Net ft²'),'net is in the totals box only');
 // No elevation page carries the old disclaimer.
 assert.ok(!pages.some(p=>p.text.some(t=>/Labeled faces are counted|pale faces|orthographic projection|elevation totals never overlap/i.test(t.value))));
 // Two columns: each elevation's rows fill the left column, then the right; one totals box spans both.
 const xs=elevations.flatMap(p=>p.text.filter(t=>!t.bold&&t.size===8&&/^W\d+$/.test(t.value)).map(t=>t.x));
 assert.ok(xs.length&&xs.every(x=>Math.abs(x-31)<1e-9||Math.abs(x-(25+(170-5)/2+5+6))<1e-9),'wall ids sit in the left or right column: '+xs);
 for(const p of elevations)assert.equal(p.text.filter(t=>/^Total/.test(t.value)).length,1,p.title+' has one totals box');
});
test('a landscape elevation side panel is only as wide as its table, its rows are never cut, and the drawing gets the rest',()=>{
 const ctx=loadPDF(),pages=[];let page,font='normal',size=9;
 const doc=new Proxy({internal:{pageSize:{getWidth:()=>279.4,getHeight:()=>215.9}},getTextWidth:s=>String(s).length*size*.16,splitTextToSize:s=>[s],setFont:(f,style)=>{font=style;},setFontSize:s=>{size=s;},text:(value,x,y)=>page.text.push({value:String(value),bold:font==='bold',size,x,y}),roundedRect:(...a)=>page.rounded.push(a)},{get:(o,k)=>k in o?o[k]:()=>{}});
 ctx.drawExteriorReportPages(doc,boxHouse(),{frontBearing:180},title=>{page={title,text:[],rounded:[]};pages.push(page);},{});
 const elevations=pages.filter(p=>/ Elevation$/.test(p.title)),w=279.4-40,panels=new Set();
 for(const p of elevations){const header=p.text.find(t=>t.value==='Wall');if(!header)continue;
  const box=p.rounded.find(r=>Math.abs(r[0]-(header.x-6))<1e-9);assert.ok(box,p.title+' table box');panels.add(box[2].toFixed(3));
  assert.ok(box[2]<=w*.34+1e-9&&box[2]>=w*.24-1e-9,p.title+' panel width '+box[2]);assert.ok(Math.abs(box[0]+box[2]-(25+w))<1e-9,'the panel ends at the content edge');
  assert.ok(!p.text.some(t=>/~$/.test(t.value)),p.title+': no row or total is cut: '+p.text.filter(t=>/~$/.test(t.value)).map(t=>t.value));}
 assert.equal(panels.size,1,'every elevation page has the same panel width');
 const front=elevations.find(p=>p.title==='Front Elevation');assert.ok(front.text.some(t=>t.value==='1 piece < 1 ft²'));
});
test('rows fill the left column first, then the right, and the totals box sits under both',()=>{
 const fs=require('fs'),vm=require('vm'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),context={ExteriorGeometry:K};context.window=context;vm.createContext(context);
 vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/exterior_pdf.js','utf8'),context);
 const texts=[],doc=new Proxy({internal:{pageSize:{getWidth:()=>210,getHeight:()=>297}},getTextWidth:s=>String(s).length,text:(value,x,y)=>texts.push({value:String(value),x,y})},{get:(o,k)=>k in o?o[k]:()=>{}});
 const {columns}=context.ExteriorPDF.writer?context.ExteriorPDF.writer(doc,{}):{};assert.ok(columns,'writer is exported');
 const rows=Array.from({length:7},(_,i)=>['R'+i,'Siding','1.0','-']),end=columns(['Wall','Material','Gross ft²','Openings ft²'],rows,100,[1,2.2,1.4,1.4],['Total','Gross 7.0 ft²'],()=>assert.fail('fits on one page'));
 const at=id=>texts.find(t=>t.value===id),left=['R0','R1','R2','R3'].map(at),right=['R4','R5','R6'].map(at);
 assert.ok(left.every(t=>t.x===left[0].x)&&right.every(t=>t.x===right[0].x)&&right[0].x>left[0].x);
 assert.ok(left.every((t,i)=>!i||t.y>left[i-1].y)&&right[0].y===left[0].y);
 const total=at('Total');assert.ok(total.y>left[3].y&&total.y<end&&total.x===left[0].x);
});
test('every elevation total in the PDF adds up to the gross wall area',()=>{
 const fs=require('fs'),vm=require('vm'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),context={ExteriorGeometry:K};context.window=context;vm.createContext(context);
 vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/exterior_pdf.js','utf8'),context);
 const pages=[];let page;const model=boxHouse();model.walls.forEach((w,i)=>{w.gross=w.net=[123.45,67.8,99.99,10.01,5.5,.7,3.33][i];});model.totals.gross=model.totals.net=model.walls.reduce((s,w)=>s+w.gross,0);
 const doc=new Proxy({internal:{pageSize:{getWidth:()=>210,getHeight:()=>297}},getTextWidth:s=>String(s).length,splitTextToSize:s=>[s],text:value=>page.text.push(String(value))},{get:(o,k)=>k in o?o[k]:()=>{}});
 context.drawExteriorReportPages(doc,model,{frontBearing:180},title=>{page={title,text:[]};pages.push(page);},{});
 const totals=pages.filter(p=>/ Elevation$|^Hidden Wall Faces$/.test(p.title)).flatMap(p=>p.text.filter(t=>/^Gross [\d,.]+ ft²$/.test(t)).map(t=>Number(t.replace(/[^\d.]/g,''))));
 assert.equal(totals.length,5);assert.ok(Math.abs(totals.reduce((a,b)=>a+b,0)-model.totals.gross)<.05*totals.length);
});
test('elevation drawings use light faces, dark edges and a white background, even for dark finishes',()=>{
 const model=boxHouse();model.walls.forEach(w=>w.finishColor='#3e454b');
 const scene=PDF.rasterScene(model.walls,{x:0,y:1},400,200,false,20),px=i=>[...scene.pixels.subarray(i*4,i*4+3)];
 assert.deepEqual(px(0),[255,255,255]);
 const face=scene.owners.findIndex((o,i)=>o>=0&&scene.owners[i-2]===o&&scene.owners[i+2]===o&&scene.owners[i-800]===o&&scene.owners[i+800]===o);
 assert.ok(Math.min(...px(face))>=170,'faces are light');
 const edge=scene.owners.findIndex((o,i)=>o>=0&&scene.owners[i+1]!==o);assert.ok(Math.max(...px(edge))<=60,'edges are dark');
 PDF.paintScene(scene,()=>true);assert.ok(Math.min(...px(face))>=230,'faces counted elsewhere are paler');
});
test('cover and summary views look from the configured front',()=>{
 for(const frontBearing of [0,90,126,300]){const v=PDF.coverView({frontBearing}),front=PDF.houseDirections({frontBearing})[0];assert.ok(Math.abs(v.x-front.x)<1e-12&&Math.abs(v.y-front.y)<1e-12);}
});
const P=(x,y,z)=>({x,y,z});
const loadPDF=(extra={})=>{const fs=require('fs'),vm=require('vm'),context={ExteriorGeometry:require('../public/measure/internal/editor_scripts/exterior_geometry.js'),...extra};context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/exterior_pdf.js','utf8'),context);return context;};
test('chimney tops and roof trim reach the PDF render inputs and are drawn, but are never counted as wall area',()=>{
 const M=require('../public/measure/internal/editor_scripts/exterior_report_model.js'),RT=require('../public/measure/internal/editor_scripts/roof_trim.js');
 const pts=[P(-1,-1,3),P(5,-1,3),P(5,2,4),P(-1,2,4),P(5,5,3),P(-1,5,3)],roof={points:pts,connections:[[0,1,'eave'],[1,2,'rake'],[2,4,'rake'],[4,5,'eave'],[5,3,'rake'],[3,0,'rake'],[3,2,'ridge']].map(([startIdx,endIdx,type])=>({startIdx,endIdx,type})),faces:[{points:[pts[0],pts[1],pts[2],pts[3]]},{points:[pts[3],pts[2],pts[4],pts[5]]}]};
 const wall={points:[P(0,0,0),P(4,0,0),P(4,0,3),P(0,0,3)]},cap={points:[P(1,1,5),P(2,1,5),P(2,1.6,5),P(1,1.6,5)],material:'chimney-top',chimney:{id:'c1',cap:true}},plainCap={points:[P(3,1,5),P(3.5,1,5),P(3.5,1.5,5),P(3,1.5,5)],chimney:{id:'c2',cap:true}};
 const roofTrim={edges:Object.fromEntries(RT.perimeter(roof).map(e=>[e.id,{height:.2}]))},m=M.build({faces:[wall,cap,plainCap],roof,roofTrim});
 assert.equal(m.walls.length,1);assert.equal(m.caps.length,2);assert.equal(m.roofTrim.length,6);assert.ok(m.roofTrim.every(f=>f.roofTrim&&f.trim&&Math.abs(f.points[0].z-f.points[3].z-.2)<1e-12));
 assert.ok(Math.abs(m.totals.gross-12/.3048**2)<1e-9,'caps and trim are not wall area');
 assert.equal(M.build({faces:[wall,cap],roof}).roofTrim.length,0,'no saved trim height, no trim, exactly as in the editor');
 const faces=PDF.houseFaces(m);assert.equal(faces.filter(f=>f.chimneyCap).length,2);assert.equal(faces.filter(f=>f.roofTrim).length,6);assert.ok(faces.filter(f=>f.chimneyCap||f.roofTrim).every(f=>f.id===''),'drawn, never labeled');
 const scene=PDF.rasterScene(faces,PDF.coverView({frontBearing:180}),600,500,true,20);
 for(const kind of ['chimneyCap','roofTrim'])assert.ok(scene.surfaces.some((f,i)=>f[kind]&&scene.counts[i]>0),kind+' is visible on the cover view');
});
test('the PDF z-fight rule: a wall top in or slightly through the roof plane never shows on the roof',()=>{
 // A roof rising away from the viewer, and a wall under it whose top pokes 2 cm through the roof plane.
 const roof={id:'',surface:'roof',points:[P(0,-1,3),P(6,-1,3),P(6,3,5),P(0,3,5)],openings:[]},wall={id:'W',points:[P(0,1,0),P(6,1,0),P(6,1,4.02),P(0,1,4.02)],normal:{x:0,y:-1,z:0},openings:[]};
 const owner=(scene,p)=>{const q=scene.at(p);return scene.surfaces[scene.owners[Math.floor(q.y)*scene.width+Math.floor(q.x)]];};
 const samples=[.5,1,1.5,2,2.5,3,3.5,4,4.5,5,5.5].flatMap(x=>[4.005,4.01,4.015].map(z=>P(x,1,z)));
 for(const view of [{x:0,y:-1},{x:.3,y:-1}])for(const iso of [true,false]){const scene=PDF.rasterScene([wall,roof],view,1600,1200,iso,20);assert.ok(samples.every(p=>owner(scene,p)?.surface==='roof'),'roof wins on the wall top line '+JSON.stringify({view,iso}));}
 // Control: the same geometry without the roof rule shows the poking wall top (the dotted soffit line).
 const plain=PDF.rasterScene([wall,{...roof,surface:undefined}],{x:0,y:-1},1600,1200,true,20);assert.ok(samples.some(p=>owner(plain,p)?.id==='W'));
 assert.ok(PDF.roofDepthBias(P(0,0,0),P(1,0,0),P(0,1,0),-1)>=PDF.ROOF_DEPTH_BIAS);
 // The visible part of the wall below the eave is still drawn.
 const scene=PDF.rasterScene([wall,roof],{x:0,y:-1},1600,1200,true,20);assert.equal(owner(scene,P(3,1,.3))?.id,'W');
 // Roof against roof compares exact depths: an upper roof layer 1 cm above a lower roof of a different pitch always wins.
 const lower={id:'',surface:'roof',points:[P(0,-1,0),P(6,-1,0),P(6,3,6),P(0,3,6)],openings:[]},upper={id:'',surface:'roof',points:[P(0,0,1.51),P(6,0,1.51),P(6,2,4.71),P(0,2,4.71)],openings:[]};
 for(const order of [[lower,upper],[upper,lower]]){const s=PDF.rasterScene(order,{x:0,y:-1},1600,1200,true,20);assert.ok([.5,2,3.5,5].flatMap(x=>[.05,1,1.9].map(y=>P(x,y,1.51+1.6*y))).every(p=>owner(s,p)===upper),'upper roof layer wins');}
 // The editor keeps its exact geometry: the rule lives only in the PDF rasterizer.
 assert.ok(!require('fs').readFileSync('public/measure/internal/editor_scripts/wall_mode.js','utf8').includes('roofDepthBias'));
});
const contextHouse=()=>{const m=boxHouse();m.roof=[{points:[P(-.3,-.3,3),P(10.3,-.3,3),P(10.3,3,4.5),P(-.3,3,4.5)]},{points:[P(-.3,3,4.5),P(10.3,3,4.5),P(10.3,6.3,3),P(-.3,6.3,3)]}];return m;};
test('a context render keeps the face framing and visibility and dims only the rest of the house',()=>{
 const m=contextHouse(),face=m.walls.find(w=>w.id==='W03'),others=PDF.houseFaces(m).filter(f=>f!==face);
 const alone=PDF.rasterScene([face],face.normal,480,320,false,72),withContext=PDF.rasterScene([face,...others],face.normal,480,320,false,72,{focus:1});
 for(const p of face.points){const a=alone.at(p),b=withContext.at(p);assert.ok(Math.abs(a.x-b.x)<1e-9&&Math.abs(a.y-b.y)<1e-9,'same framing');}
 assert.equal(withContext.counts[0],alone.counts[0],'W07 stands in front of W03 but never hides it');
 const contextPixels=withContext.owners.reduce((n,o)=>n+(o>0?1:0),0);assert.ok(contextPixels>0,'the roof shows behind the face');
 const color=i=>[...withContext.pixels.subarray(i*4,i*4+3)],inside=withContext.owners.findIndex((o,i)=>o===0&&withContext.owners[i-3]===0&&withContext.owners[i+3]===0&&withContext.owners[i-1440]===0&&withContext.owners[i+1440]===0),dim=withContext.owners.findIndex((o,i)=>o>0&&withContext.owners[i-3]===o&&withContext.owners[i+3]===o&&withContext.owners[i-1440]===o&&withContext.owners[i+1440]===o);
 assert.deepEqual(color(inside),[...alone.pixels.subarray(inside*4,inside*4+3)],'the measured face looks as it did alone');assert.deepEqual(color(dim),[243,244,246],'context faces are very light grey');
});
test('house context behind wall dimension drawings is on by default and the organization or the report can turn it off',()=>{
 const run=(settings,org)=>{const images=[];let title='';const ctx=loadPDF({projectOrganization:org,document:{createElement:()=>({getContext:()=>({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:d=>images.push({title,data:d.data})}),toDataURL:()=>'data:image/png,test'})}});
  const doc=new Proxy({internal:{pageSize:{getWidth:()=>210,getHeight:()=>297}},getTextWidth:s=>String(s).length,splitTextToSize:s=>[s]},{get:(o,k)=>k in o?o[k]:()=>{}});
  ctx.drawExteriorReportPages(doc,contextHouse(),settings,t=>{title=t;},{});
  const dims=images.filter(i=>/Dimensions/.test(i.title));assert.ok(dims.length);let n=0;for(const {data}of dims)for(let i=0;i<data.length;i+=4)if(data[i]===243&&data[i+1]===244&&data[i+2]===246)n++;
  return {n,on:ctx.ExteriorPDF.dimensionContext(settings)};};
 const general=v=>({report_settings:{general:{exterior_dimension_context:v}}});
 const on=run({},undefined),orgOff=run({},general(false)),orgOn=run({},general(true)),reportOn=run({dimensionContext:true},general(false)),reportOff=run({dimensionContext:false},general(true));
 assert.ok(on.on&&on.n>0,'default on');assert.ok(orgOn.on&&orgOn.n===on.n);
 assert.ok(!orgOff.on&&orgOff.n===0,'organization off: faces alone, as before');
 assert.ok(reportOn.on&&reportOn.n===on.n,'a report can turn it back on');assert.ok(!reportOff.on&&reportOff.n===0,'a report can turn it off');
});
test('every exterior table uses the boxed roof-table style with unchanged values; long narrow tables use two columns and page breaks stay inside the page',()=>{
 const render=model=>{const pages=[];let page,font='normal',size=9;const ctx=loadPDF();
  const doc=new Proxy({internal:{pageSize:{getWidth:()=>210,getHeight:()=>297}},getTextWidth:s=>String(s).length,splitTextToSize:s=>[s],setFont:(f,style)=>{font=style;},setFontSize:s=>{size=s;},text:(value,x,y)=>page.text.push({value:String(value),bold:font==='bold',size,x,y}),lines:(...a)=>page.bars++,roundedRect:(...a)=>page.rounded.push(a)},{get:(o,k)=>k in o?o[k]:()=>{}});
  ctx.drawExteriorReportPages(doc,model,{frontBearing:180,dimensionContext:false},title=>{page={title,text:[],bars:0,rounded:[]};pages.push(page);},{});return pages;};
 const isMaterial=t=>/^Material ([A-G]|\d+)$/.test(t.value);
 const model=boxHouse();model.openings=[{id:'W01-1',label:'Window',wall:'W01',width:3,height:4,area:12,perimeter:14}];
 const pages=render(model),bottom=297-22;
 for(const title of ['Hidden Wall Faces','Opening Schedule','Exterior Quantities','Material Allowances']){const p=pages.find(p=>p.title===title);assert.ok(p,title);
  assert.ok(p.bars>0,title+' tables have the accent bar');assert.ok(!p.rounded.some(r=>r[3]===9&&r[2]>150),title+' has no old full-width header strip');}
 const q=pages.find(p=>p.title==='Exterior Quantities').text.map(t=>t.value);for(const v of ['Top of walls','Exposed vertical terminations','Not assigned','Area (sq ft)','Squares'])assert.ok(q.includes(v),v);
 const sched=pages.find(p=>p.title==='Opening Schedule').text.map(t=>t.value);for(const v of ['W01-1','Window','W01','3.0 x 4.0','12.0'])assert.ok(sched.includes(v),v);
 assert.ok(!sched.includes('14.0'),'an opening without trim does not report its perimeter as trim');
 for(const v of ['Measured lengths','Trim','Window trim','Door trim','Garage door trim','Roof trim (fascia)','Total trim'])assert.ok(q.includes(v),v);
 const allow=pages.find(p=>p.title==='Material Allowances').text;assert.ok(['0%','20%','Area including waste (sq ft)','Squares including waste'].every(v=>allow.some(t=>t.value===v)));
 // Many materials: the narrow "Net area by material" table goes to two columns, the wide allowance table stays one, and nothing runs off a page.
 const many=boxHouse();many.walls.forEach((w,i)=>{w.material='Material '+String.fromCharCode(65+i);});for(let i=0;i<53;i++)many.walls.push({...many.walls[0],id:'X'+i,material:'Material '+i});
 const long=render(many),quantities=long.filter(p=>/^Exterior Quantities/.test(p.title)),allowances=long.filter(p=>/^Material Allowances/.test(p.title));
 const matX=new Set(quantities.flatMap(p=>p.text.filter(isMaterial).map(t=>t.x)));assert.equal(matX.size,2,'net area by material uses two columns');
 const listed=quantities.flatMap(p=>p.text.filter(isMaterial).map(t=>t.value));assert.equal(listed.length,60);assert.equal(new Set(listed).size,60,'every material listed once');
 const allowX=new Set(allowances.flatMap(p=>p.text.filter(isMaterial).map(t=>t.x)));assert.equal(allowX.size,1,'the wide allowance table keeps one column');assert.ok(allowances.length>1,'allowances continue on another page');
 for(const p of long)assert.ok(p.text.every(t=>t.y<=bottom+.01),p.title+' stays above the footer');
});
test('the Exterior Summary shows its seven figures as equal compact header-stat cells (one row in landscape, four then three in portrait) and the wall ID note at the foot',()=>{
 for(const [W,H,layout]of [[210,297,[4,3]],[279.4,215.9,[7]]]){
  const pages=[];let page;const ctx=loadPDF(),doc=new Proxy({internal:{pageSize:{getWidth:()=>W,getHeight:()=>H}},getTextWidth:s=>String(s).length*.9,splitTextToSize:s=>[s],text:(value,x,y)=>page.text.push({value:String(value),x,y}),lines:(l,x,y)=>page.bars.push({x,y}),roundedRect:(...a)=>page.rounded.push(a),addImage:(...a)=>page.images.push(a)},{get:(o,k)=>k in o?o[k]:()=>{}});
  ctx.ExteriorPDF.drawExteriorSummaryPage(doc,boxHouse(),{},title=>{page={title,text:[],bars:[],rounded:[],images:[]};pages.push(page);},{});
  const p=pages[0],at=v=>p.text.find(t=>t.value===v);
  assert.equal(p.bars.length,7,'seven accent-bar cards');
  const rows=[...new Set(p.bars.map(b=>b.y))].sort((a,b)=>a-b);assert.deepEqual(rows.map(y=>p.bars.filter(b=>b.y===y).length),layout);
  const cards=p.rounded.slice(0,14).filter((r,i)=>i%2===1);assert.equal(cards.length,7);assert.equal(new Set(cards.map(r=>r[2].toFixed(6))).size,1,'every cell the same width');assert.equal(new Set(cards.map(r=>r[3].toFixed(6))).size,1,'every cell the same height');
  assert.ok(cards[0][3]<=14,'compact cells');assert.ok(Math.max(...cards.map(r=>r[1]+r[3]))<=36+layout.length*17,'the stats header is short');
  const columns=[...new Set(cards.map(r=>r[0].toFixed(6)))];assert.equal(columns.length,layout[0],'a short last row stays on the grid');
  for(const [label,value]of [['NET WALL AREA',null],['GROSS WALL AREA',null],['OPENINGS','0'],['WALL REGIONS','7'],['OPENING AREA',null],['OPENING PERIMETER',null],['HORIZONTAL RETURNS',null]]){const t=at(label);assert.ok(t,label);if(value)assert.ok(p.text.some(v=>v.value===value&&Math.abs(v.x-t.x)<1e-9&&v.y>t.y),label+' has its value under it');}
  assert.ok(!p.text.some(t=>t.value==='Measurement'||t.value==='Quantity'),'no measurement table');
  const note=p.text.find(t=>/^Wall IDs connect/.test(t.value)),footer=H-16;assert.ok(note.y>footer-10&&note.y<footer-5,'the note sits just above the footer address: '+note.y);
 }
});

test('the Exterior Summary figures are whole numbers with thousands separators, in feet or in metric units',()=>{
 const values=manifest=>{const ctx=loadPDF({currentProjectManifest:manifest});require('vm').runInContext(require('fs').readFileSync('public/libraries/report-units.js','utf8'),ctx);
  const text=[];const doc=new Proxy({internal:{pageSize:{getWidth:()=>279.4,getHeight:()=>215.9}},getTextWidth:s=>String(s).length*.9,splitTextToSize:s=>[s],text:value=>text.push(String(value))},{get:(o,k)=>k in o?o[k]:()=>{}});
  const model=boxHouse();Object.assign(model.totals,{net:4374.42,gross:4550.18,openingArea:175.61,openingPerimeter:121.73,returns:36.4});
  ctx.ExteriorPDF.drawExteriorSummaryPage(doc,model,{},()=>{},{});return text;};
 const feet=values({});for(const v of ['4,374 sq ft','4,550 sq ft','176 sq ft','122 ft','36 sq ft'])assert.ok(feet.includes(v),v+' in '+feet.join(' | '));
 assert.ok(!feet.some(v=>/\d\.\d/.test(v)&&/ft$/.test(v)),'no decimals');
 const metric=values({measurement_system:'metric',report_language:'en-GB'});for(const v of ['406 m²','423 m²','16 m²','37 m','3 m²'])assert.ok(metric.includes(v),v+' in '+metric.join(' | '));
});
test('landscape wall dimension pages have at most two rows of up to three faces; portrait keeps three rows of small faces',()=>{
 const rowsOf=page=>new Set(page.map(p=>p.y.toFixed(6))).size;
 const [portrait]=PDF.dimensionPages(Array(9).fill(10).map((a,i)=>face('W'+i,a)));assert.equal(portrait.length,9);assert.equal(rowsOf(portrait),3);
 const small=PDF.dimensionPages(Array(9).fill(10).map((a,i)=>face('W'+i,a)),{landscape:true});assert.deepEqual(small.map(p=>p.length).sort(),[3,6]);
 for(const p of small.find(p=>p.length===6)){assert.ok(Math.abs(p.w-1/3)<1e-9);assert.ok(Math.abs(p.h-.5)<1e-9);}
 for(let count=1;count<=30;count++){
  const faces=Array.from({length:count},(_,i)=>face('W'+i,10+(i*77)%400)),pages=PDF.dimensionPages(faces,{landscape:true});
  assert.equal(new Set(pages.flat().map(p=>p.face.id)).size,count);
  for(const page of pages){assert.ok(rowsOf(page)<=2,'two rows at most');assert.ok(Math.abs(page.reduce((s,p)=>s+p.w*p.h,0)-1)<1e-9);}
 }
});
test('a wall dimension drawing is only as tall as its face needs, so its size and material sit right under it',()=>{
 const wide={id:'W',points:[P(0,0,0),P(20,0,0),P(20,0,3),P(0,0,3)],normal:{x:0,y:-1,z:0}},rect={x:0,y:0,w:80,h:120};
 const h=PDF.fitHeight([wide],wide.normal,rect,9,0,24);assert.ok(Math.abs(h-((3*(80-18))/20+18))<1e-9,'height follows the face at full width');
 const tall={...wide,points:[P(0,0,0),P(2,0,0),P(2,0,9),P(0,0,9)]};assert.equal(PDF.fitHeight([tall],tall.normal,rect,9,0,24),120,'a tall face uses the panel height');
});
// Exterior Images boxes: the content width, from the page header down to 7 mm above the footer address.
const LANDSCAPE_PHOTOS={x:25,y:36,w:239.4,h:215.9-16-2.2-7-36},PORTRAIT_PHOTOS={x:25,y:36,w:175.9,h:279.4-16-2.2-7-36},L43=4/3,P34=3/4;
const photoRows=layout=>layout.rows.map(r=>r.map(i=>layout.rects[i]));
test('exterior images: justified rows of mixed aspect ratios inside the page, labels above each photo, six to a page',()=>{
 for(const box of [LANDSCAPE_PHOTOS,PORTRAIT_PHOTOS])for(const aspects of [[L43,P34,L43,P34,L43,L43],[L43,L43,P34,L43],[L43,L43,L43],[P34]]){
  const layout=PDF.mosaicLayout(aspects,box),{rects}=layout;assert.equal(rects.length,aspects.length);assert.ok(layout.minHeight>=45);
  for(const [i,r]of rects.entries()){
   const shown=r.w/r.h;assert.ok(aspects[i]>=1?Math.abs(shown-aspects[i])<1e-9:shown>=aspects[i]-1e-9&&shown<=aspects[i]/.8+1e-9,'landscape photos keep their shape; a portrait one loses at most a fifth of its height');
   assert.ok(r.x>=box.x-1e-9&&r.x+r.w<=box.x+box.w+1e-9&&r.y-7>=box.y-1e-9&&r.y+r.h<=box.y+box.h+1e-9,'inside the page with room for its label');
   for(const q of rects.slice(i+1))assert.ok(r.x+r.w<=q.x+1e-9||q.x+q.w<=r.x+1e-9||r.y+r.h+7<=q.y+1e-9||q.y+q.h+7<=r.y+1e-9,'no overlap, labels included');
  }
  const rows=photoRows(layout),heights=rows.map(r=>r[0].h);
  for(const row of rows){assert.equal(new Set(row.map(r=>r.h.toFixed(6))).size,1,'one height per row');row.slice(1).forEach((r,k)=>assert.ok(Math.abs(r.x-row[k].x-row[k].w-6)<1e-9,'a 6 mm gutter'));
   assert.ok(Math.abs(row[0].x-box.x-(box.x+box.w-row.at(-1).x-row.at(-1).w))<1e-9,'a narrower row is centred');}
  assert.ok(Math.max(...heights)/Math.min(...heights)<=1.3+1e-9,'row heights stay within 1.3 of each other');
 }
 // Rows span the content width when the photos allow it.
 const width=(layout,row)=>{const r=photoRows(layout)[row];return r.at(-1).x+r.at(-1).w-r[0].x;};
 const mixed=PDF.mosaicLayout([L43,P34,L43,P34,L43,L43],LANDSCAPE_PHOTOS);assert.deepEqual(mixed.rows.map(r=>r.length),[3,3]);
 for(const k of [0,1])assert.ok(Math.abs(width(mixed,k)-LANDSCAPE_PHOTOS.w)<.5,'six mixed photos in landscape: both rows span the width');
 // Photo area first: three landscape photos take two rows (the single one centred), not a thin band.
 const three=PDF.mosaicLayout([L43,L43,L43],LANDSCAPE_PHOTOS),band=(LANDSCAPE_PHOTOS.w-12)*(LANDSCAPE_PHOTOS.w-12)/4/(LANDSCAPE_PHOTOS.w*LANDSCAPE_PHOTOS.h);
 assert.equal(three.rows.length,2);assert.ok(three.cover>1.3*band,'much more photo area than one row: '+three.cover+' vs '+band);assert.ok(three.minHeight>65);
 const portraitThree=PDF.mosaicLayout([L43,L43,L43],PORTRAIT_PHOTOS);assert.equal(portraitThree.rows.length,2);assert.ok(portraitThree.cover>.5);
 const six=PDF.mosaicLayout(Array(6).fill(L43),PORTRAIT_PHOTOS);assert.deepEqual(six.rows.map(r=>r.length),[2,2,2]);assert.ok(six.rows.every((r,k)=>width(six,k)>=.97*PORTRAIT_PHOTOS.w),'portrait: three rows of two across the page');
 // The reported job: Front and Back, Left and Right tall phone shots, then three more. Five then two,
 // so no page is a thin band; the two rows of the first page come out equally wide (the portrait
 // shots cropped a little), and the last two span the page.
 const job=PDF.mosaicPages([L43,L43,P34,P34,L43,L43,L43],LANDSCAPE_PHOTOS);assert.deepEqual(job.map(p=>p.indexes.length),[5,2]);
 assert.ok(Math.abs(width(job[0],0)-width(job[0],1))<.02*LANDSCAPE_PHOTOS.w&&width(job[0],0)>.8*LANDSCAPE_PHOTOS.w,'Front/Back and Left/Right/Front Right equally wide');assert.ok(Math.abs(width(job[1],0)-LANDSCAPE_PHOTOS.w)<.5,'the last two span it');
 const leftShot=job[0].rects[2];assert.ok(leftShot.w/leftShot.h>P34+.1&&leftShot.h>leftShot.w,'a cropped portrait shot is still portrait');
 assert.deepEqual(PDF.mosaicPages([L43,P34,L43,P34,L43,L43],LANDSCAPE_PHOTOS).map(p=>p.indexes.length),[6]);
 assert.deepEqual(PDF.mosaicPages(Array(8).fill(L43),LANDSCAPE_PHOTOS).map(p=>p.indexes.length),[4,4],'eight photos: two even pages');
 const portrait=PDF.mosaicPages([L43,P34,L43,P34,L43,L43],PORTRAIT_PHOTOS);assert.ok(portrait.every(p=>p.minHeight>=45));assert.equal(portrait.flatMap(p=>p.indexes).length,6);
});
test('the Exterior Images pages leave the fine print gap above the footer address',async()=>{
 const pages=[];let page;const ctx=loadPDF(),img={naturalWidth:1600,naturalHeight:1200};
 for(const [W,H]of [[279.4,215.9],[215.9,279.4]]){
  const doc=new Proxy({internal:{pageSize:{getWidth:()=>W,getHeight:()=>H}},getTextWidth:s=>String(s).length*.9,splitTextToSize:s=>[s],text:()=>{},addImage:(d,f,x,y,w,h)=>page.images.push({x,y,w,h})},{get:(o,k)=>k in o?o[k]:()=>{}});
  ctx.Image=function(){const self=this;Object.assign(self,img);Object.defineProperty(self,'src',{set(){setTimeout(()=>self.onload());}});};
  const photoSlots={};['front','back','left','right','front-right','front-left','back-right','back-left'].forEach((id,i)=>photoSlots[id]={enabled:i<3,image:i<3?{key:id,dataUrl:'data:image/jpeg;base64,'}:null});
  await ctx.drawReportImagery(doc,{exteriorSettings:{photoSlots}},title=>{page={title,images:[]};pages.push(page);},{});
  const p=pages.at(-1);assert.equal(p.images.length,3);assert.ok(p.images.every(i=>i.y+i.h<=H-16-2.2-7+1e-9),'7 mm clear of the footer address');
  assert.ok(p.images.every(i=>i.x>=25-1e-9&&i.x+i.w<=W-15+1e-9),'inside the content width');assert.ok(p.images.reduce((t,i)=>t+i.w*i.h,0)>=.45*(W-40)*(H-16-2.2-7-36),'three photos fill about half the page');
 }
});

test('trim is measured: opening boards along their outside edge by kind, wall trim strips along their run, roof trim along its edge',()=>{
 const X=require('../public/measure/internal/editor_scripts/exterior_pdf.js'),ft=.3048;
 // A 3 x 7 ft door with 4 in trim on its sides and head (no bottom board): 7 + 3 + 7 ft inside, plus the miters outside.
 const t=4/12,board=(a,b,c,d)=>({points:[a,b,c,d].map(([x,z])=>({x:x*ft,y:0,z:z*ft}))});
 const door={label:'Door',trimFaces:[board([3,0],[3,7],[3+t,7+t],[3+t,0]),board([3,7],[0,7],[-t,7+t],[3+t,7+t]),board([0,7],[0,0],[-t,0],[-t,7+t])]};
 assert.ok(Math.abs(X.openingTrimLength(door)-(7+t+3+2*t+7+t))<1e-9);
 assert.equal(X.openingTrimLength({label:'Window',trimFaces:[]}),0);
 const fascia={points:[{x:0,y:0,z:3},{x:10*ft,y:0,z:3},{x:10*ft,y:0,z:2.9},{x:0,y:0,z:2.9}]};
 const totals=X.trimTotals({openings:[door,{label:'Garage door',trimFaces:door.trimFaces},{label:'Window'}],walls:[{material:'Horizontal trim',width:12,height:.5},{material:'Vertical trim',width:.4,height:9},{material:'Brick',width:30,height:9}],roofTrim:[fascia]});
 const near=(a,b)=>Math.abs(a-b)<1e-9,doorLength=7+t+3+2*t+7+t;
 assert.ok(near(totals.door,doorLength)&&near(totals.garage,doorLength)&&totals.window===0);
 assert.ok(near(totals.wallHorizontal,12)&&near(totals.wallVertical,9)&&near(totals.roof,10));
 assert.ok(near(totals.total,2*doorLength+12+9+10));
});
