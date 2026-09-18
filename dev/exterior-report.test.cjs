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
