// FM-311: the Full Exterior PDF's Wall Notes card is a blank page for the customer's own notes.
// exterior_pdf.js drawExteriorNotes must never write model warnings ("Review: ..."), stored
// exteriorSettings.notes or any other system text on it, and never add a continuation page.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');
const SF=1/.3048**2,box=(id,a,b,normal)=>{const points=[{...a,z:0},{...b,z:0},{...b,z:3},{...a,z:3}],w=Math.hypot(b.x-a.x,b.y-a.y),area=w*3*SF;return {id,points,holes:[],normal,elevation:'',material:'Unassigned',gross:area,net:area,openingArea:0,openings:[],width:w/.3048,height:3/.3048};};
function render(model,settings){
 const context={ExteriorGeometry:K};context.window=context;vm.createContext(context);
 vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/exterior_pdf.js','utf8'),context);
 const pages=[],cards=[];let page;
 context.pdfNotesLayout=(doc,n)=>({cells:Array.from({length:n},(_,i)=>({x:20+(i%2)*60,y:40+Math.floor(i/2)*60,w:58,h:58})),notes:{x:150,y:40,w:120,h:150},page:{x:20,y:40,w:250,h:150}});
 context.drawPdfCard=()=>{};
 context.drawPdfNotesCard=(doc,rect,paragraphs)=>{cards.push(paragraphs);for(const p of paragraphs)doc.text(p,rect.x,rect.y);return [];};
 const doc=new Proxy({internal:{pageSize:{getWidth:()=>297,getHeight:()=>210}},getTextWidth:s=>String(s).length,splitTextToSize:s=>[String(s)],text:v=>page.text.push(String(v))},{get:(o,k)=>k in o?o[k]:()=>{}});
 context.drawExteriorNotes(doc,model,settings,title=>{page={title,text:[]};pages.push(page);},{});
 return {pages,cards};
}
test('the Wall Notes card stays blank even when the model has warnings and settings carry notes',()=>{
 const walls=[box('W01',{x:0,y:0},{x:10,y:0},{x:0,y:-1,z:0}),box('W02',{x:10,y:0},{x:10,y:6},{x:1,y:0,z:0}),box('W03',{x:10,y:6},{x:0,y:6},{x:0,y:1,z:0}),box('W04',{x:0,y:6},{x:0,y:0},{x:-1,y:0,z:0})];
 const warnings=['An opening has no matching supporting wall and is excluded from totals.','An opening is not on a vertical wall and is excluded from the wall schedule.',...Array.from({length:40},(_,i)=>'Generated warning '+i)];
 const {pages,cards}=render({walls,returns:[],roof:[],openings:[],edges:[],warnings},{frontBearing:180,notes:'Stored system note that must not print'});
 assert.deepEqual(Array.from(pages,p=>p.title),["Wall Notes"]);
 assert.equal(cards.length,1);assert.equal(cards[0].length,0);
 const written=pages.flatMap(p=>p.text).join('\n');
 assert.doesNotMatch(written,/Review|warning|excluded|supporting wall|Stored system note/i);
});
test('drawExteriorNotes passes no paragraphs to the notes card in source',()=>{
 const src=fs.readFileSync('public/measure/internal/editor_scripts/exterior_pdf.js','utf8');
 const body=src.slice(src.indexOf('function drawExteriorNotes('),src.indexOf('\n}\n',src.indexOf('function drawExteriorNotes(')));
 assert.doesNotMatch(body,/warnings|Review|settings\.notes/);
 assert.match(body,/drawPdfNotesCard\(doc,notes,\[\],colors\)/);
});
