// FM-375: the report's Holiday Lights page counts lights by side of the house and roofline: each side in its colour on
// the drawing and in the table, each unbroken stretch labelled with its length. The same two-story house as
// public/v1/tests/measurements-holiday-lights-browser.test.mjs (the browser's Holiday Lights tab), to the same groups
// and lengths: keep the two in step.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),vm=require('vm');
// Values made in the vm are copied out, so deepEqual compares plain arrays.
const plain=v=>JSON.parse(JSON.stringify(v));
const loadPDF=()=>{const c={console:{...console,log(){}}};c.window=c;vm.createContext(c);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/pdf.js','utf8'),c);return c;};
const roof=()=>{
 const points={m1:[0,0,10],m2:[40,0,10],m3:[40,30,10],m4:[0,30,10],r1:[0,15,18],r2:[40,15,18],p1:[10,-8,0],p2:[30,-8,0],p3:[30,0,4],p4:[10,0,4]};
 const lines=[['se','m1','m2','EAVE'],['ne','m3','m4','EAVE'],['ridge','r1','r2','RIDGE'],['ser','m2','r2','RAKE'],['ner','r2','m3','RAKE'],['swr','r1','m1','RAKE'],['nwr','m4','r1','RAKE'],['pe','p1','p2','EAVE'],['per','p2','p3','RAKE'],['pw','p3','p4','FLASHING'],['pwr','p4','p1','RAKE']].map(([id,a,b,type])=>({id,a,b,type}));
 const faces=[['m1','m2','r2','r1'],['m4','r1','r2','m3'],['p1','p2','p3','p4']];
 return {roofs:[{points,lines,faces}]};
};
const rake=Math.hypot(15,8),porchRake=Math.hypot(8,4);
const expected=[['north:upper',40],['east:lower',porchRake],['east:upper',2*rake],['south:lower',20],['south:upper',40],['west:lower',porchRake],['west:upper',2*rake]];
const key=g=>g.side+(g.levelKey?':'+g.levelKey:'');

test('lights are grouped by side and roofline, as the browser tab groups them',()=>{
 const pdf=loadPDF(),metrics=pdf.buildPdfHolidayLightsMetrics(roof());
 assert.equal(metrics.levels,2);
 assert.deepEqual(plain(metrics.groups.map(key)),expected.map(([id])=>id),'compass order, rooflines lower to upper');
 metrics.groups.forEach((g,i)=>assert.ok(Math.abs(g.length-expected[i][1])<1e-9,key(g)));
 assert.deepEqual(plain(metrics.groups.slice(0,3).map(g=>[g.sideName,g.levelName])),[['North','Upper'],['East','Lower'],['East','Upper']]);
 assert.deepEqual(plain(metrics.sides.map(s=>[s.name,Math.round(s.length)])),[['North',40],['East',Math.round(porchRake+2*rake)],['South',60],['West',Math.round(porchRake+2*rake)]]);
 assert.ok(Math.abs(metrics.totalFt-expected.reduce((sum,[,l])=>sum+l,0))<1e-9);
 assert.ok(Math.abs(metrics.lengths.RIDGE-40)<1e-9,'ridges are measured but not lit on the report');
 assert.equal(metrics.groups.find(g=>key(g)==='east:upper').lengths.RAKE,2*rake);
 // Bulbs: one per foot at 12 in, at least one per edge, over lit edges only.
 assert.equal(metrics.bySpacing.find(r=>r.inches===12).bulbs,metrics.groups.flatMap(g=>g.edges).reduce((n,e)=>n+Math.max(1,Math.round(e.length)),0));
});

test('a one-story house turned on its lot: sides square to its walls, no rooflines named',()=>{
 const pdf=loadPDF(),c=Math.cos(Math.PI/6),s=Math.sin(Math.PI/6),turn=(x,y)=>[x*c-y*s,x*s+y*c,0];
 const points={a:turn(0,0),b:turn(30,0),c:turn(30,20),d:turn(0,20)};
 const lines=[['ab','a','b'],['bc','b','c'],['cd','c','d'],['da','d','a']].map(([id,a,b])=>({id,a,b,type:'EAVE'}));
 const metrics=pdf.buildPdfHolidayLightsMetrics({roofs:[{points,lines,faces:[['a','b','c','d']]}]});
 assert.equal(metrics.levels,1);
 assert.deepEqual(plain(metrics.groups.map(g=>[key(g),g.levelName,Math.round(g.length)])),[['north','',30],['east','',20],['south','',30],['west','',20]]);
});

// A recording jsPDF stand-in (anything else it is asked to do is a no-op): everything the page draws must stay
// inside the area it was given.
function fakeDoc(){
 const calls=[];let size=10;
 const doc={calls,setFont(){},setFontSize(v){size=v;},getFontSize:()=>size,setTextColor(){},setFillColor(){},setDrawColor(){},setLineWidth(){},setLineDashPattern(){},setGState(){},GState:function(){},
  getTextWidth:t=>String(t).length*size*0.2,
  text(t,x,y,o={}){const w=String(t).length*size*0.2,left=o.align==='center'?x-w/2:o.align==='right'?x-w:x;calls.push({kind:'text',t,x0:left,x1:left+w,y0:y-size*0.3,y1:y});},
  rect(x,y,w,h){calls.push({kind:'rect',x0:x,x1:x+w,y0:y,y1:y+h});},
  roundedRect(x,y,w,h){calls.push({kind:'rect',x0:x,x1:x+w,y0:y,y1:y+h});},
  line(x1,y1,x2,y2){calls.push({kind:'line',x0:Math.min(x1,x2),x1:Math.max(x1,x2),y0:Math.min(y1,y2),y1:Math.max(y1,y2)});},
  circle(x,y,r){calls.push({kind:'circle',x0:x-r,x1:x+r,y0:y-r,y1:y+r});},
  addImage(d,f,x,y,w,h){calls.push({kind:'image',x0:x,x1:x+w,y0:y,y1:y+h});}};
 return new Proxy(doc,{get:(target,key)=>key in target?target[key]:()=>{}});
}
for(const [name,w,h] of [['portrait',190,219],['landscape',250,150]]){
 test(`the page fits a long table on a ${name} page`,async()=>{
  const pdf=loadPDF();
  pdf.createHolidayLightsCanvas=(model,metrics,{width,height})=>({width,height,toDataURL:()=>'data:image/jpeg;base64,'});
  // Four rooflines on every side: sixteen rows.
  const points={},lines=[],faces=[];
  for(let k=0;k<4;k++){
   const z=k*9,o=k*3,id=n=>`${n}${k}`;
   Object.assign(points,{[id('a')]:[o,o,z],[id('b')]:[60-o,o,z],[id('c')]:[60-o,40-o,z],[id('d')]:[o,40-o,z]});
   [['ab','a','b'],['bc','b','c'],['cd','c','d'],['da','d','a']].forEach(([l,a,b])=>lines.push({id:id(l),a:id(a),b:id(b),type:'EAVE'}));
   faces.push(['a','b','c','d'].map(id));
  }
  const model={roofs:[{points,lines,faces}]};
  assert.equal(pdf.buildPdfHolidayLightsMetrics(model).groups.length,16);
  assert.deepEqual(plain(pdf.buildPdfHolidayLightsMetrics(model).groups.slice(0,4).map(g=>g.levelName)),['Roofline 1','Roofline 2','Roofline 3','Roofline 4'],'more than three rooflines are numbered');
  const doc=fakeDoc(),x=10,y=35;
  await pdf.drawHolidayLightsPage(doc,{},model,x,y,w,h,null);
  const out=doc.calls.filter(c=>c.x0<x-1.6||c.x1>x+w+1.6||c.y0<y-0.01||c.y1>y+h+1.6);
  assert.deepEqual(out,[]);
  assert.equal(doc.calls.filter(c=>c.kind==='text'&&/^Roofline [1-4]$/.test(c.t)).length,16,'every row names its roofline');
  const image=doc.calls.find(c=>c.kind==='image');
  assert.ok(image&&image.y1-image.y0>30,'the drawing keeps a usable height');
 });
}

test('the drawing labels every visible stretch with its length, in its side colour, with no label on another',()=>{
 const pdf=loadPDF(),labels=[];
 // A canvas stand-in that keeps what is written and the colour it is written on.
 let fill='';
 const ctx=new Proxy({measureText:t=>({width:String(t).length*12}),getImageData:(x,y,w,h)=>({data:new Uint8ClampedArray(w*h*4)}),
  fillText(t,x,y){labels.push({t,x,y,on:fill});}},{get:(target,k)=>k in target?target[k]:()=>{},set:(target,k,v)=>{if(k==='fillStyle'&&v!=='#ffffff')fill=v;return true;}});
 pdf.document={createElement:()=>({getContext:()=>ctx})};
 const model=roof(),metrics=pdf.buildPdfHolidayLightsMetrics(model);
 pdf.createHolidayLightsCanvas(model,metrics,{width:1600,height:1000});
 const runs=labels.filter(l=>/ ft$/.test(l.t));
 const pieces=metrics.groups.flatMap(g=>g.pieces.map(p=>({t:`${Math.round(p.length)} ft`,color:g.color})));
 assert.ok(runs.length>=5,'most stretches face the camera: '+runs.map(l=>l.t).join(', '));
 for(const l of runs)assert.ok(pieces.some(p=>p.t===l.t&&p.color===l.on),`${l.t} on ${l.on} is a stretch's length in its side colour`);
 assert.ok(runs.some(l=>l.t==='20 ft'&&l.on==='#9334e6'),'the porch eave (south, lower) is labelled');
 for(const [i,a] of runs.entries())for(const b of runs.slice(i+1))assert.ok(Math.abs(a.x-b.x)>30||Math.abs(a.y-b.y)>20,`${a.t} and ${b.t} do not overlap`);
 assert.ok(labels.every(l=>!/^[NESW][LMU1-9]?$/.test(l.t)||l.t==='N'),'no side tags on the drawing, only the north arrow');
});
