const test=require('node:test'),assert=require('node:assert/strict'),R=require('../public/measure/internal/editor_scripts/roof_trim.js');
const p=(x,y,z)=>({x,y,z}),a=p(0,0,3),b=p(6,0,3),c=p(6,2,4),d=p(0,2,4),e=p(6,4,3),f=p(0,4,3),roof={points:[a,b,c,d,e,f],connections:[[0,1,'eave'],[1,2,'rake'],[2,4,'rake'],[4,5,'eave'],[5,3,'rake'],[3,0,'rake'],[3,2,'ridge']].map(([startIdx,endIdx,type])=>({startIdx,endIdx,type})),faces:[{points:[a,b,c,d]},{points:[d,c,e,f]}]};
test('gable perimeter has six vertical six-inch panels and no ridge trim',()=>{const original=JSON.stringify(roof),panels=R.panels(roof);assert.equal(panels.length,6);assert.ok(panels.every(f=>Math.abs(f.height-.1524)<1e-10));assert.ok(!panels.some(f=>[f.a,f.b].every(p=>p.y===2)));for(const f of panels){assert.equal(f.material,'trim-horizontal');assert.deepEqual(f.points[0],f.a);assert.ok(Math.abs(f.points[0].z-f.points[3].z-.1524)<1e-10);assert.equal(f.points[0].x,f.points[3].x);assert.equal(f.points[0].y,f.points[3].y);}assert.equal(JSON.stringify(roof),original);});
test('collinear roof anchors and duplicate faces do not create duplicate trim',()=>{const mid=p(3,0,3),split={...roof,faces:[{points:[a,mid,b,c,d]},roof.faces[1],{points:[...roof.faces[1].points].reverse()}]};assert.equal(R.panels(split).length,6);assert.deepEqual(R.panels(split).map(p=>p.id),R.panels(roof).map(p=>p.id));});
test('a long edge shared with split neighboring faces is internal, including T-junctions',()=>{const center=p(3,2,4),rear=p(3,4,3),split={...roof,faces:[roof.faces[0],{points:[d,center,rear,f]},{points:[center,c,e,rear]}]};assert.equal(R.panels(split).length,6);assert.ok(!R.panels(split).some(f=>[f.a,f.b].every(p=>p.y===2)));});
test('multi-selection height, deletion and reload preserve roof geometry and unrelated sides',()=>{const panels=R.panels(roof),ids=panels.slice(0,2).map(f=>f.id),initial={};const taller=R.setHeight(initial,ids,9.5);assert.deepEqual(initial,{});const next=R.panels(roof,JSON.parse(JSON.stringify(taller)));assert.ok(next.filter(p=>ids.includes(p.id)).every(p=>Math.abs(p.height-9.5*.0254)<1e-9));assert.ok(next.filter(p=>!ids.includes(p.id)).every(p=>Math.abs(p.height-.1524)<1e-10));const deleted=R.setHeight(taller,[ids[0]],0);assert.equal(R.panels(roof,deleted).filter(f=>f.deleted).length,1);assert.equal(R.panels(roof,R.setHeight(deleted,[ids[0]],6)).filter(f=>f.deleted).length,0);assert.throws(()=>R.setHeight(initial,ids,-2));});

test('trim controller supports Shift selection, typed inches, Escape, Delete and undo snapshots',()=>{
 const vm=require('node:vm'),fs=require('node:fs');let settings={},editor,front,history=[];const ctx={RoofTrim:R,document:{querySelector:()=>null},wallNearestSurface:()=>front};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/roof_trim_editor.js','utf8'),ctx);
 editor=ctx.createRoofTrimEditor({settings:()=>settings,set:v=>settings=v,visible:()=>true,redraw:()=>editor.refresh(roof),screen:()=>null,commit:b=>history.push(b),undo:()=>{settings=history.pop();editor.refresh(roof);}});const panels=editor.refresh(roof),event=shiftKey=>({shiftKey,target:{closest:()=>true}}),key=k=>editor.key({key:k,preventDefault(){},stopImmediatePropagation(){}}),pick=(i,shift=false)=>{front={object:{userData:{roofTrimId:panels[i].id}}};assert.equal(editor.pick(event(shift),{},p=>p),true);};
 pick(0);pick(1,true);key('9');key('.');key('5');assert.ok(R.panels(roof,settings).slice(0,2).every(p=>Math.abs(p.height-9.5*.0254)<1e-9));key('Enter');assert.equal(history.length,1);key('1');key('2');key('Escape');assert.ok(R.panels(roof,settings).slice(0,2).every(p=>Math.abs(p.height-9.5*.0254)<1e-9));key('Delete');assert.equal(R.panels(roof,settings).filter(f=>f.deleted).length,2);assert.equal(history.length,2);editor.key({key:'z',ctrlKey:true,preventDefault(){},stopImmediatePropagation(){}});assert.equal(R.panels(roof,settings).filter(f=>f.deleted).length,0);pick(1,true);assert.equal(editor.selected(panels[1].id),false);
});

test('fascia excludes chimney, sidewall, headwall and unclassified boundaries even with saved trim',()=>{
 for(const type of ['chimney','sidewall','headwall','unknown','ridge','valley']){const changed={...roof,connections:roof.connections.map((c,i)=>i===0?{...c,type}:c)};const previous=R.panels(roof).find(f=>f.a.y===0&&f.b.y===0),settings=R.setHeight({},[previous.id],12);assert.equal(R.panels(changed,settings).length,5);assert.ok(!R.panels(changed,settings).some(f=>f.id===previous.id));}
 assert.deepEqual(R.panels({faces:roof.faces}),[]);
 const hole=[p(2,.5,3.25),p(3,.5,3.25),p(3,1,3.5),p(2,1,3.5)];assert.equal(R.panels({...roof,faces:[{...roof.faces[0],holes:[hole]},roof.faces[1]]}).length,6);
});
test('fascia stops where an eave changes to a headwall on one polygon edge',()=>{
 const mid=p(3,0,3),mixed={...roof,points:[...roof.points,mid],connections:[...roof.connections.slice(1),{startIdx:0,endIdx:6,type:'eave'},{startIdx:6,endIdx:1,type:'headwall'}]};
 const bottom=R.panels(mixed).filter(f=>f.a.y===0&&f.b.y===0);assert.equal(bottom.length,1);assert.deepEqual([bottom[0].a.x,bottom[0].b.x].sort(),[0,3]);
});


test('empty array settings from project metadata retain new fascia sizes after serialization',()=>{
 for(const settings of [[],{edges:[]}]){const id=R.panels(roof)[0].id,next=JSON.parse(JSON.stringify(R.setHeight(settings,[id],8)));assert.equal(next.edges[id].height,8*R.INCH);assert.equal(R.panels(roof,next)[0].height,8*R.INCH);}
});


test('compact trim menu selects additively without applying, then applies chosen width and color',()=>{
 const vm=require('node:vm'),fs=require('node:fs'),nodes=new Map(),calls=[];
 const element=()=>({style:{},value:'',hidden:false,addEventListener(){},setAttribute(){},focus(){},blur(){},querySelector:q=>nodes.get(q.slice(1)),querySelectorAll:()=>[],set innerHTML(html){for(const m of html.matchAll(/<(?:button|input|select|span|section)[^>]*id="([^"]+)"[^>]*>/g)){const n=element();n.value=m[0].match(/value="([^"]+)"/)?.[1]||'';nodes.set(m[1],n);}},get parentElement(){return parent;}}),parent={insertBefore(node){nodes.set(node.id,node);}};
 const ctx={RoofTrim:R,document:{querySelector:()=>parent,createElement:element,head:{appendChild(){}},getElementById:()=>null}},settings={};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/roof_trim_editor.js','utf8'),ctx);
 const editor=ctx.createRoofTrimEditor({settings:()=>settings,enabled:()=>true,visible:()=>true,redraw(){},wallWidth:()=>8,setWallWidth:n=>calls.push(['width',n]),selectWallTrim:k=>calls.push(['select',k]),applyWallTrim:(w,c)=>calls.push(['apply',w,c])});editor.refresh(roof);
 nodes.get('roof-trim-tool').onclick();nodes.get('wall-trim-select').onclick();nodes.get('wall-trim-ground').onclick();assert.deepEqual(calls,[['select','walls'],['select','ground']]);assert.equal(nodes.get('roof-trim-options').hidden,false);
 nodes.get('wall-trim-color').value='#aabbcc';nodes.get('wall-trim-apply').onclick();assert.deepEqual(calls.at(-1),['apply',8,'#aabbcc']);
 const width=nodes.get('wall-trim-width');width.value='custom';width.onchange();nodes.get('wall-trim-custom').value='4.5';nodes.get('wall-trim-apply').onclick();assert.deepEqual(calls.at(-1),['apply',4.5,'#aabbcc']);assert.equal(nodes.get('wall-trim-custom').hidden,false);
});
test('roof fascia wins coplanar depth ties without offsetting measured or picked geometry',()=>{
 const vm=require('node:vm'),fs=require('node:fs'),source=fs.readFileSync('public/measure/internal/editor_scripts/wall_mode.js','utf8'),fn=source.split('\n').find(l=>l.includes('function drawRoofTrim('));
 class Geometry{setFromPoints(points){this.points=points;return this;}setIndex(){}}
 class Material{constructor(values){Object.assign(this,{depthTest:true},values);delete this.color;}}
 class Mesh{constructor(geometry,material){Object.assign(this,{geometry,material,userData:{},isMesh:true});}}
 const ctx={RoofTrim:R,roofTrimEditor:null,state:null,roofTrimOnly:{},THREE:{BufferGeometry:Geometry,MeshBasicMaterial:Material,Mesh,DoubleSide:2}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fn,ctx);const meshes=[];ctx.drawRoofTrim({add:m=>meshes.push(m)},roof,p=>({...p}));vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);for(const mode of ['textured','opaque','translucent']){ctx.exteriorSurfaceDisplay({traverse:fn=>meshes.forEach(fn)},mode);assert.ok(meshes.every(m=>m.material.polygonOffsetFactor===-2&&m.material.polygonOffsetUnits===-2),mode);}
 assert.ok(meshes.length);const panels=R.panels(roof);for(let i=0;i<meshes.length;i++){const m=meshes[i];assert.deepEqual(JSON.parse(JSON.stringify(m.geometry.points)),panels[i].points);assert.equal(m.material.depthTest,true);assert.equal(m.material.depthWrite,true);assert.equal(m.material.polygonOffset,true);assert.ok(m.material.polygonOffsetFactor<0&&m.material.polygonOffsetUnits<0);assert.equal(m.userData.roofTrimId,panels[i].id);}
});
