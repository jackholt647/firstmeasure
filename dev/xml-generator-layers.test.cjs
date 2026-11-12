// FM-405: where a lower roof meets an upper one in plan, model_data.xml keeps each layer's own point, so every roof face
// is written as the plane it is drawn on (the export used to match points by plan position alone).
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function generator(){const context={console};context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/measure/internal/editor_scripts/xml_generator.js'),'utf8'),context);return context;}
function offPlane(ring){
 for(let k=2;k<ring.length;k++){const [a,b,c]=[ring[0],ring[1],ring[k]],d=(b[0]-a[0])*(c[1]-a[1])-(c[0]-a[0])*(b[1]-a[1]);if(Math.abs(d)<1e-6)continue;
  const A=((b[2]-a[2])*(c[1]-a[1])-(c[2]-a[2])*(b[1]-a[1]))/d,B=((b[0]-a[0])*(c[2]-a[2])-(c[0]-a[0])*(b[2]-a[2]))/d;
  return Math.max(...ring.map(p=>Math.abs(A*(p[0]-a[0])+B*(p[1]-a[1])+a[2]-p[2])));}
 return 0;
}
const pt=(x,y,z,layer)=>({x,y,z,layer}),line=(a,b,type)=>({points:[a,b],type,length:1});
// Metres, 0.1 m per pixel. The upper face's corner (20, 10) is 3 m above the lower face's corner at the same place.
const upper=[pt(0,0,13,2),pt(20,0,13,2),pt(20,10,12,2),pt(0,10,12,2)],lower=[pt(20,10,9,1),pt(40,10,9,1),pt(40,30,8,1),pt(20,30,8,1)];
const state=extra=>({geometry:{points:[...upper,...lower]},radiusMeters:2,dims:{w:40,h:40},address:'',facesData:[{points:upper},{points:lower}],
 report:{lines:[line(upper[0],upper[1],'ridge'),line(upper[2],upper[3],'eave'),line(lower[0],lower[1],'side_wall'),line(lower[2],lower[3],'eave')]},...extra});
function parse(xml){
 const points=Object.fromEntries([...xml.matchAll(/<POINT data="([^"]+)" id="([^"]+)"\/>/g)].map(m=>[m[2],m[1].split(',').map(Number)]));
 const lines=Object.fromEntries([...xml.matchAll(/<LINE [^>]*id="([^"]+)" path="([^"]+)" type="([^"]+)"/g)].map(m=>[m[1],{ends:m[2].split(','),type:m[3]}]));
 const faces=[...xml.matchAll(/<POLYGON id="[^"]+" path="([^"]+)"/g)].map(m=>[...new Set(m[1].split(',').flatMap(id=>lines[id].ends))].map(id=>points[id]));
 return {points,lines,faces};
}

test('a lower roof\'s corner under an upper roof\'s corner is its own point, and every face is a plane',()=>{
 const {points,lines,faces}=parse(generator().generateRoofXML(state()));
 assert.equal(Object.keys(points).length,8);
 assert.equal(faces.length,2);
 for(const face of faces)assert.ok(offPlane(face)<.01,'face is a plane');
 // The lower roof's side wall runs along the lower roof (1 m above its 8 m eave), not up to the upper roof's corner.
 const side=Object.values(lines).find(l=>l.type==='SIDE_WALL');
 assert.deepEqual(side.ends.map(id=>points[id][2]),[2003.28084,2003.28084]);
});

test('points that agree in height are still one point',()=>{
 // Two faces of one roof meeting at a ridge share both its corners.
 const a=[pt(0,0,10,1),pt(20,0,10,1),pt(20,10,12,1),pt(0,10,12,1)],b=[pt(0,10,12,1),pt(20,10,12,1),pt(20,20,10,1),pt(0,20,10,1)];
 const {points,faces}=parse(generator().generateRoofXML({geometry:{points:[...a,...b.slice(2)]},radiusMeters:2,dims:{w:40,h:40},address:'',facesData:[{points:a},{points:b.map(p=>({...p,z:p.z+.01}))}],report:{lines:[]}}));
 assert.equal(Object.keys(points).length,6);
 for(const face of faces)assert.ok(offPlane(face)<.1);
});
