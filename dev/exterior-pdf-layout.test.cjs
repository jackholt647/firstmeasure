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
test('eight elevations use one diagram each and continuation pages contain only data',()=>{
 const fs=require('fs'),vm=require('vm'),R=require('../public/measure/internal/editor_scripts/exterior_report_model.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');
 const context={ExteriorGeometry:K,document:{createElement:()=>({getContext:()=>({createImageData:(w,h)=>({data:new Uint8Array(w*h*4)}),putImageData(){}}),toDataURL:()=> 'data:image/png,test'})}};context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/exterior_pdf.js','utf8'),context);
 const model=R.build({faces:[wall('base',0)]});model.walls=Array.from({length:24},(_,i)=>({...model.walls[0],id:'W'+i,gross:10,net:10,width:3,height:3,points:wall('w',0).points.map(p=>({...p,x:p.x+i*5}))}));
 model.walls[23].material='Horizontal trim';const pages=[];let page;
 const doc=new Proxy({internal:{pageSize:{getWidth:()=>210,getHeight:()=>297}},getTextWidth:s=>String(s).length,splitTextToSize:s=>[s],addImage:()=>page.images++},{get:(o,k)=>k in o?o[k]:(...args)=>{if(k==='text')page.text.push(args[0]);}});
 context.drawExteriorReportPages(doc,model,{},title=>{page={title,images:0,text:[]};pages.push(page);},{});
 const elevations=pages.filter(p=>/Elevation$/.test(p.title));assert.deepEqual(elevations.map(p=>p.title),PDF.photoSlots.map(s=>s.name+' Elevation'));assert.ok(elevations.every(p=>p.images===1));
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
test('every face in an elevation table is labeled in its drawing, and every label is in the table',()=>{
 const fs=require('fs'),vm=require('vm'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),context={ExteriorGeometry:K};context.window=context;vm.createContext(context);
 vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/exterior_pdf.js','utf8'),context);
 const pages=[];let page,font='normal',size=9;
 const doc=new Proxy({internal:{pageSize:{getWidth:()=>210,getHeight:()=>297}},getTextWidth:s=>String(s).length,splitTextToSize:s=>[s],setFont:(f,style)=>{font=style;},setFontSize:s=>{size=s;},text:(value,x,y)=>page.text.push({value:String(value),bold:font==='bold',size,x,y}),line:(...a)=>page.lines.push(a),circle:()=>page.circles++},{get:(o,k)=>k in o?o[k]:()=>{}});
 context.drawExteriorReportPages(doc,boxHouse(),{frontBearing:180},title=>{page={title,text:[],lines:[],circles:0};pages.push(page);},{});
 const elevations=pages.filter(p=>/ Elevation$/.test(p.title));assert.equal(elevations.length,8);
 for(const p of elevations){
  const labels=p.text.filter(t=>t.bold&&t.size<=7&&/^W\d+$/.test(t.value)).map(t=>t.value).sort(),rows=p.text.filter(t=>!t.bold&&t.size===8&&/^W\d+$/.test(t.value)).map(t=>t.value).sort();
  assert.deepEqual(labels,rows,p.title);
 }
 const front=elevations.find(p=>p.title==='Front Elevation');assert.ok(front.text.some(t=>t.value==='W07'&&t.bold));assert.ok(front.circles>0&&front.text.some(t=>t.value==='W07'&&t.size===5.5),'the narrow face gets a leader line');
 assert.ok(front.text.some(t=>t.value==='Small pieces'));assert.ok(front.text.some(t=>t.value==='Total'));
 assert.ok(!pages.some(p=>p.text.some(t=>/irreducible|Unassigned/.test(t.value))));assert.ok(pages.some(p=>p.title==='Hidden Wall Faces'&&p.text.some(t=>t.value==='W05')));
 assert.ok(front.text.some(t=>t.value==='Openings ft²'));
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
