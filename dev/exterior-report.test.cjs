const test=require('node:test'),assert=require('node:assert/strict'),R=require('../public/measure/internal/editor_scripts/exterior_report_model.js');
const rect=(x0,z0,x1,z1)=>[{x:x0,y:0,z:z0},{x:x1,y:0,z:z0},{x:x1,y:0,z:z1},{x:x0,y:0,z:z1}];
test('exterior areas deduct openings exactly once and keep per-section materials',()=>{const opening=rect(1,2,2,3),m=R.build({faces:[{points:rect(0,0,4,2),material:'brick'},{points:rect(0,2,4,4),holes:[opening],material:'siding'},{points:opening,feature:{type:'window'}}]});assert.equal(m.openings.length,1);assert.equal(m.walls.length,2);assert.ok(Math.abs(m.totals.gross-16/.3048**2)<1e-5);assert.ok(Math.abs(m.totals.net-15/.3048**2)<1e-5);assert.deepEqual(new Set(m.walls.map(w=>w.material)),new Set(['Brick','Horizontal siding']));assert.ok(m.edges.some(e=>e.type==='Material transition'));});
test('roof-only scenes do not produce exterior pages',()=>assert.equal(R.build({faces:[]}),null));
test('PDF pages and diagrams exclude the editor base without changing wall quantities',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),ctx={ExteriorGeometry:require('../public/measure/internal/editor_scripts/exterior_geometry.js')};ctx.window=ctx;vm.createContext(ctx);
 vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/exterior_pdf.js','utf8'),ctx);
 const model=R.build({faces:[{points:rect(0,0,4,4)}],base:{faces:[{points:[{x:-100,y:-100,z:-20},{x:100,y:-100,z:-20},{x:100,y:100,z:-20},{x:-100,y:100,z:-20}]}]}});
 const render=m=>{const calls=[],doc=new Proxy({internal:{pageSize:{getWidth:()=>210,getHeight:()=>297}},getTextWidth:s=>String(s).length*1.2,splitTextToSize:s=>[s]},{get:(target,key)=>key in target?target[key]:(...args)=>calls.push([key,...args])});ctx.drawExteriorReportPages(doc,m,{},title=>calls.push(['page',title]),{});return calls;};
 const before=JSON.stringify(model),withBase=render(model),withoutBase=render({...model,base:[]});
 assert.deepEqual(withBase,withoutBase);assert.equal(JSON.stringify(model),before);
 for(const title of ['Opening Schedule','Exterior Quantities','Material Allowances'])assert.ok(withBase.some(c=>c[0]==='page'&&c[1]===title));
 assert.ok(!withBase.some(c=>c[0]==='page'&&/takeoff/i.test(c[1])));
 assert.ok(!withBase.some(c=>c[0]==='page'&&/foundation|grade/i.test(c[1])));
});
test('browser script order initializes report dependencies and includes the roof without changing wall area',()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),dir=path.resolve(__dirname,'../public/measure/internal'),html=fs.readFileSync(path.join(dir,'editor.php'),'utf8');
 const context={console,navigator:{userAgent:'test'}};context.window=context;context.self=context;vm.createContext(context);
 const needed=/\/(?:clipper-lib-6\.4\.2-clipper|earcut-3\.2\.3-earcut\.dev|exterior_geometry|wall_solid_geometry|exterior_report_model)\.js$/;
 for(const [,file] of html.matchAll(/<script src="(editor_scripts\/[^?]+)\?/g))if(needed.test(file))vm.runInContext(fs.readFileSync(path.join(dir,file),'utf8'),context);
 const roof={faces:[{points:[{x:0,y:0,z:4},{x:4,y:0,z:4},{x:4,y:4,z:5},{x:0,y:4,z:5}]}]},scene={faces:[{points:rect(0,0,4,4)}],roof};
 const model=context.ExteriorReportModel.build(scene);
 assert.equal(model.walls.length,1);assert.equal(model.roof.length,1);assert.ok(Math.abs(model.totals.net-16/.3048**2)<1e-5);
 model.roof[0].points[0].z=50;assert.equal(roof.faces[0].points[0].z,4);
});
test('a door cut as a notch in the bottom edge of its wall is a counted opening',()=>{
 const wall=[{x:0,y:0,z:0},{x:1,y:0,z:0},{x:1,y:0,z:2},{x:2,y:0,z:2},{x:2,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:3},{x:0,y:0,z:3}];
 const m=R.build({faces:[{points:wall},{points:rect(1,0,2,2),feature:{type:'door'}}]});
 assert.equal(m.warnings.length,0);assert.equal(m.openings.length,1);assert.equal(m.walls.length,1);
 assert.ok(Math.abs(m.walls[0].gross-12/.3048**2)<1e-6);assert.ok(Math.abs(m.walls[0].openingArea-2/.3048**2)<1e-6);assert.ok(Math.abs(m.walls[0].net-10/.3048**2)<1e-6);
});
test('chimney faces point away from their own chimney',()=>{
 const side=y=>({points:[{x:5,y,z:3},{x:6,y,z:3},{x:6,y,z:5},{x:5,y,z:5}],chimney:{id:'c1',side:0}});
 const m=R.build({faces:[{points:rect(0,0,4,3)},side(5),side(6)],base:{faces:[{points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:8,z:0},{x:0,y:8,z:0}]}]}});
 const chimney=m.walls.filter(w=>w.chimney).sort((a,b)=>a.points[0].y-b.points[0].y);
 assert.equal(chimney.length,2);assert.ok(chimney[0].normal.y<0);assert.ok(chimney[1].normal.y>0);
});
test('report configuration warns about wall faces without a material',()=>{
 const m=R.build({faces:[{points:rect(0,0,4,2),material:'brick'},{points:rect(0,2,4,4)},{points:rect(0,4,4,6),material:'unassigned'}]});
 const warning=R.materialWarning(m);assert.equal(warning.count,1);assert.equal(warning.total,2);assert.deepEqual(warning.ids,R.unassigned(m).map(w=>w.id));
 assert.match(warning.text,/1 of 2 wall faces have no material assigned/);
 assert.equal(R.materialWarning(R.build({faces:[{points:rect(0,0,4,2),material:'siding'}]})),null);
 const many=R.build({faces:Array.from({length:10},(_,i)=>({points:rect(i*5,0,i*5+4,2)}))});assert.match(R.materialWarning(many).text,/No wall face has a material assigned \(W01, .*W08, \+2 more\)/);
});
test('the report tray opens about half again wider than before, resizes within limits and remembers each person\'s width',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),ts=require('../public/v1/node_modules/typescript'),file='public/measure/internal/editor_scripts/report.js',source=fs.readFileSync(file,'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),parts=[];
 const wanted=new Set(['reportTrayWidthKey','clampReportTrayWidth','readReportTrayWidth','saveReportTrayWidth']);
 ts.forEachChild(tree,node=>{if(ts.isFunctionDeclaration(node)&&wanted.has(node.name?.text))parts.push(node.getText(tree));if(ts.isVariableStatement(node)&&node.getText(tree).includes('REPORT_TRAY_DEFAULT_SHARE'))parts.push(node.getText(tree).replace(/^const /,'var '));});
 assert.equal(parts.length,5);
 const store=new Map(),c={localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)},FIRSTMEASURE_ACTOR:{email:'Tech@Example.com'}};c.window=c;vm.createContext(c);vm.runInContext(parts.join('\n'),c);
 assert.equal(c.clampReportTrayWidth(null,1920),691);assert.ok(c.clampReportTrayWidth(null,1920)>=1920*.35*1.0&&c.clampReportTrayWidth(null,1440)>=270*1.5);
 assert.equal(c.clampReportTrayWidth(100,1440),360);assert.equal(c.clampReportTrayWidth(5000,1440),1440-605);assert.equal(c.clampReportTrayWidth(600,1440),600);
 c.saveReportTrayWidth(640.4);assert.equal(store.get('firstmeasure:report-tray-width:tech@example.com'),'640');assert.equal(c.readReportTrayWidth(),640);
 c.FIRSTMEASURE_ACTOR={email:'other@example.com'};assert.equal(c.readReportTrayWidth(),null);
 c.localStorage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};assert.equal(c.readReportTrayWidth(),null);assert.doesNotThrow(()=>c.saveReportTrayWidth(500));
 assert.match(source,/body\.report-mode-active #main-pane-slot \{ flex-shrink:1; \}/);assert.doesNotMatch(source,/report-column \{ display:flex; width:35%; \}/);
});
