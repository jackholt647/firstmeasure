/* Metric texture coordinates and shared neutral maps, tinted by the finish color. */
(function(root){'use strict';
const cache=new Map();
const defaults={material:'unassigned',color:'#80868b',trimColor:'#f5f3ef'};
// Roof coverings are data. tile is one texture repeat in metres: [along the eave, up the slope].
// The first color of each category is its default; the roof default is industry standard charcoal shingles.
const roofMaterials={
 shingles:{label:'Shingles',description:'Architectural asphalt',tile:[1,.572],courses:4,roughness:.9,metalness:0,colors:[{id:'charcoal',label:'Charcoal',color:'#4a4c4f'},{id:'weathered-wood',label:'Weathered wood',color:'#6e6459'},{id:'driftwood',label:'Driftwood',color:'#8c8478'},{id:'pewter',label:'Pewter gray',color:'#7a7e82'},{id:'barkwood',label:'Barkwood',color:'#5e4838'},{id:'hunter-green',label:'Hunter green',color:'#424f44'}]},
 shake:{label:'Shake',description:'Cedar shake',tile:[1.2,1.016],courses:4,roughness:.95,metalness:0,colors:[{id:'natural-cedar',label:'Natural cedar',color:'#a8784e'},{id:'weathered',label:'Weathered',color:'#8f8c85'},{id:'aged-cedar',label:'Aged cedar',color:'#7c5d44'},{id:'honey',label:'Honey',color:'#bb8f5e'}]},
 slate:{label:'Slate',description:'Natural slate',tile:[1.016,.864],courses:4,roughness:.72,metalness:.04,colors:[{id:'gray',label:'Slate gray',color:'#626970'},{id:'black',label:'Black',color:'#34373b'},{id:'purple',label:'Purple',color:'#5e4f5d'},{id:'green',label:'Green',color:'#5a685e'}]},
 metal:{label:'Standing seam metal',description:'16 in panels',tile:[.8128,1],courses:0,roughness:.55,metalness:.25,colors:[{id:'charcoal',label:'Charcoal',color:'#404347'},{id:'galvalume',label:'Galvalume',color:'#b6babd'},{id:'barn-red',label:'Barn red',color:'#8e3127'},{id:'forest-green',label:'Forest green',color:'#324b3c'},{id:'matte-black',label:'Matte black',color:'#2a2c2e'},{id:'bronze',label:'Bronze',color:'#51412f'}]}
};
const roofDefault={category:'shingles',color:roofMaterials.shingles.colors[0].color};
function resolveRoof(value){const category=roofMaterials[value?.category]?value.category:roofDefault.category,color=typeof value?.color==='string'&&/^#[0-9a-f]{6}$/i.test(value.color)?value.color.toLowerCase():roofMaterials[category].colors[0].color;return {category,color};}
// Sticker defaults are data: a trim and a main colour per kind of sticker. Windows have no main colour (glass is
// drawn as glass); vents keep their own look. Trims seed from the wall trim colour and mains from doorFinishes until
// set. A sticker's own colour (finishColor, or a trim colour chosen for it) always wins.
const stickerPieces=[{id:'doorTrim',label:'Door trim',part:'trim',kind:'door'},{id:'doorMain',label:'Door colour',part:'main',kind:'door'},{id:'windowTrim',label:'Window trim',part:'trim',kind:'window'},{id:'garageTrim',label:'Garage door trim',part:'trim',kind:'garage'},{id:'garageMain',label:'Garage door colour',part:'main',kind:'garage'},{id:'untypedTrim',label:'Untyped trim',part:'trim',kind:'untyped'},{id:'untypedMain',label:'Untyped main',part:'main',kind:'untyped'}];
const LEGACY_TRIM='#f5f3ef',UNTYPED_MAIN='#deddd6';
const stickerKind=type=>type==='door'||type==='garage'||type==='window'?type:type==='skylight'?'window':type==='vent'?null:'untyped';
function stickerDefaults(settings=root.WallMode?.finishDefaults||{}){
 const hex=v=>typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v)?v.toLowerCase():null,trim=hex(settings.trimColor)||LEGACY_TRIM,seed={doorMain:doorFinishes.door.color,garageMain:doorFinishes.garage.color,untypedMain:UNTYPED_MAIN},out={};
 for(const piece of stickerPieces)out[piece.id]=hex(settings.stickers?.[piece.id])||(piece.part==='trim'?trim:seed[piece.id]);
 return out;
}
function stickerColor(type,part,settings){const kind=stickerKind(type);if(!kind)return null;return stickerDefaults(settings)[kind+(part==='trim'?'Trim':'Main')]||null;}
// A trim's own colour; trims saved before sticker defaults carry the old fixed white, which means "use the default".
const stickerTrimOwnColor=(trim,settings=root.WallMode?.finishDefaults||{})=>typeof trim?.color==='string'&&/^#[0-9a-f]{6}$/i.test(trim.color)&&![LEGACY_TRIM,String(settings.trimColor||'').toLowerCase()].includes(trim.color.toLowerCase())?trim.color.toLowerCase():null;
function resolve(face={},settings=root.WallMode?.finishDefaults||{}){
 const normal=face.normal||(face.points&&root.WallSolidGeometry?.faceFrame(face)?.n),d={...defaults,...settings},source=face.material||(face.chimney?.cap&&!face.chimney.derived&&!face.trim?'chimney-top':normal?.z<-.5?'soffit':'default'),type=source==='default'?d.material:source;
 if(source==='shingles'){const roof=resolveRoof(face.roofMaterial||d.roof);return {material:'shingles',category:roof.category,color:face.finishColor||face.color||roof.color};}
 // Roof trim has its own default (Wall materials › Roof), else the default trim colour.
 if(face.roofTrim)return {material:type,color:face.finishColor||face.color||d.roofTrimColor||d.trimColor};
 if(type==='opening-trim'&&face.stickerType!==undefined)return {material:type,color:face.finishColor||face.color||stickerColor(face.stickerType,'trim',settings)||d.trimColor};
 return {material:type==='default'?'unassigned':type,color:face.finishColor||face.color||((face.trim||type.startsWith('trim-')||type==='opening-trim')?d.trimColor:source==='chimney-top'?'#d4d0c8':d.color)};
}
// Neutral roof maps (gray, mean near 0.85) so the chosen color tints them. Seeded, so every render is identical.
const roofMaps=new Map();
function roofCanvas(category){
 const spec=roofMaterials[category],W=512,H=Math.round(W*spec.tile[1]/spec.tile[0]),canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;const c=canvas.getContext('2d');
 let seed=[...category].reduce((s,ch)=>s*31+ch.charCodeAt(0)|0,7);const rnd=()=>{seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};
 const gray=(v,a=1)=>{const n=Math.max(0,Math.min(255,Math.round(v*255)));return a<1?'rgba('+n+','+n+','+n+','+a+')':'rgb('+n+','+n+','+n+')';};
 // Every shape repeats across both tile edges so the map tiles seamlessly.
 const each=(x,y,fn)=>{for(const dx of [0,-W,W])for(const dy of [0,-H,H])fn(x+dx,y+dy);};
 const rect=(x,y,w,h,fill)=>{c.fillStyle=fill;each(x,y,(px,py)=>c.fillRect(px,py,w,h));};
 const shadow=(y,h,strength)=>{each(0,y,(px,py)=>{const g=c.createLinearGradient(0,py,0,py+h);g.addColorStop(0,gray(0,strength));g.addColorStop(1,gray(0,0));c.fillStyle=g;c.fillRect(0,py,W,h);});};
 const speckle=(count,size,alpha)=>{for(let i=0;i<count;i++){c.fillStyle=gray(rnd()<.5?1:0,alpha*rnd());c.fillRect(Math.floor(rnd()*W),Math.floor(rnd()*H),size,size);}};
 const rows=spec.courses,ch=rows?H/rows:H;
 if(category==='shingles'){
  rect(0,0,W,H,gray(.5));
  for(let r=rows-1;r>=0;r--){const y=r*ch;let x=rnd()*W,end=x+W;
   while(x<end){const w=Math.round(W*(.09+rnd()*.11)),short=rnd()<.45?ch*(.1+rnd()*.12):0;rect(x,y,w-1,ch,gray(.48));rect(x+1,y,w-2,ch-short-1,gray(.74+rnd()*.2));rect(x+1,y+ch-short-2,w-2,1,gray(.38));x+=w;}
   shadow(y,ch*.2,.42);}
  speckle(W*H/2.5,1,.22);
 }else if(category==='shake'){
  rect(0,0,W,H,gray(.28));
  for(let r=rows-1;r>=0;r--){const y=r*ch;let x=rnd()*W,end=x+W;
   while(x<end){const w=Math.round(W*(.07+rnd()*.17)),drop=Math.round(rnd()*ch*.05),tone=.7+rnd()*.22;rect(x+2,y,w-3,ch+drop,gray(tone));
    for(let k=0;k<w*.7;k++){const gx=x+2+rnd()*(w-4),gy=y+rnd()*ch*.4,len=ch*(.4+rnd()*.7);rect(Math.floor(gx),gy,1,Math.min(len,ch+drop-(gy-y)),gray(rnd()<.5?tone+.12:tone-.16,.55));}
    if(rnd()<.18){const sx=Math.floor(x+3+rnd()*(w-6));rect(sx,y+ch*.3,1.5,ch*.7+drop,gray(.25));}
    rect(x+2,y+ch+drop-2,w-3,2,gray(.4));x+=w;}
   shadow(y,ch*.24,.55);}
  speckle(W*H/6,1,.15);
 }else if(category==='slate'){
  rect(0,0,W,H,gray(.22));const sw=W/4;
  for(let r=rows-1;r>=0;r--){const y=r*ch,offset=r%2?sw/2:0;
   for(let k=0;k<4;k++){const x=offset+k*sw+1,w=sw-2,h=ch-1,tone=.68+rnd()*.24,cut=[rnd()*5,rnd()*5];
    c.fillStyle=gray(tone);each(x,y,(px,py)=>{c.beginPath();c.moveTo(px,py);c.lineTo(px+w,py);c.lineTo(px+w,py+h-cut[1]);c.lineTo(px+w-cut[1],py+h);c.lineTo(px+cut[0],py+h);c.lineTo(px,py+h-cut[0]);c.closePath();c.fill();});
    for(let s=0;s<6;s++)rect(x+rnd()*w*.6,y+ch*(.25+rnd()*.7),w*(.2+rnd()*.4),1,gray(rnd()<.5?tone+.08:tone-.08,.6));
    rect(x,y+h-1,w,1,gray(.35));}
   shadow(y,ch*.16,.5);}
  speckle(W*H/3,1,.12);
 }else{
  const panels=2,pw=W/panels,rib=Math.max(6,Math.round(.025/spec.tile[0]*W));
  for(let p=0;p<panels;p++){const x=p*pw;
   each(x,0,(px)=>{const g=c.createLinearGradient(px,0,px+pw,0);g.addColorStop(0,gray(.8));g.addColorStop(.5,gray(.86));g.addColorStop(1,gray(.8));c.fillStyle=g;c.fillRect(px,0,pw,H);});
   for(const at of [1/3,2/3]){rect(x+pw*at,0,2,H,gray(.74));rect(x+pw*at+2,0,1,H,gray(.92));}}
  // Seams after every pan, so the seam on the tile edge is not painted over by the next pan.
  for(let p=0;p<panels;p++){const x=p*pw;
   rect(x-rib/2-2,0,2,H,gray(.42));each(x-rib/2,0,px=>{const gg=c.createLinearGradient(px,0,px+rib,0);gg.addColorStop(0,gray(.97));gg.addColorStop(.55,gray(.9));gg.addColorStop(1,gray(.62));c.fillStyle=gg;c.fillRect(px,0,rib,H);});rect(x+rib/2,0,3,H,gray(.5,.8));}
  for(let i=0;i<40;i++)rect(rnd()*W,0,1,H,gray(rnd()<.5?1:0,.03));
 }
 return canvas;
}
function roofTexture(category){
 category=roofMaterials[category]?category:roofDefault.category;if(roofMaps.has(category))return roofMaps.get(category);
 const t=new THREE.CanvasTexture(roofCanvas(category));t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=8;if(THREE.SRGBColorSpace)t.colorSpace=THREE.SRGBColorSpace;else if(THREE.sRGBEncoding)t.encoding=THREE.sRGBEncoding;t.userData||={};t.userData.roofCategory=category;roofMaps.set(category,t);return t;
}
// Tangent-space normals from the map's brightness: butts, keyways and seams read as relief under real light.
const roofNormals=new Map();
function roofNormalMap(category){
 category=roofMaterials[category]?category:roofDefault.category;if(roofNormals.has(category))return roofNormals.get(category);
 const source=roofTexture(category).image,W=source.width,H=source.height,read=source.getContext?.('2d')?.getImageData?.(0,0,W,H);if(!read?.data)return null;
 const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;const c=canvas.getContext('2d'),out=c.createImageData(W,H),h=(x,y)=>{const i=(((y+H)%H)*W+((x+W)%W))*4;return (read.data[i]+read.data[i+1]+read.data[i+2])/765;},k=category==='metal'?3:category==='shake'?5:4;
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){const dx=(h(x+1,y)-h(x-1,y))*k,dy=(h(x,y+1)-h(x,y-1))*k,l=Math.hypot(dx,dy,1),i=(y*W+x)*4;out.data[i]=Math.round((-dx/l*.5+.5)*255);out.data[i+1]=Math.round((dy/l*.5+.5)*255);out.data[i+2]=Math.round((1/l*.5+.5)*255);out.data[i+3]=255;}
 c.putImageData(out,0,0);const t=new THREE.CanvasTexture(canvas);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=8;roofNormals.set(category,t);return t;
}
// Normal map from a height canvas (brightness = height). wrap repeats across the edges; otherwise edges clamp.
function normalFromCanvas(source,k,wrap=true){
 const W=source.width,H=source.height,read=source.getContext?.('2d')?.getImageData?.(0,0,W,H);if(!read?.data)return null;
 const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;const c=canvas.getContext('2d'),out=c.createImageData(W,H),at=(v,n)=>wrap?(v+n)%n:Math.max(0,Math.min(n-1,v)),h=(x,y)=>{const i=(at(y,H)*W+at(x,W))*4;return (read.data[i]+read.data[i+1]+read.data[i+2])/765;};
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){const dx=(h(x+1,y)-h(x-1,y))*k,dy=(h(x,y+1)-h(x,y-1))*k,l=Math.hypot(dx,dy,1),i=(y*W+x)*4;out.data[i]=Math.round((-dx/l*.5+.5)*255);out.data[i+1]=Math.round((dy/l*.5+.5)*255);out.data[i+2]=Math.round((1/l*.5+.5)*255);out.data[i+3]=255;}
 c.putImageData(out,0,0);const t=new THREE.CanvasTexture(canvas);t.wrapS=t.wrapT=wrap?THREE.RepeatWrapping:THREE.ClampToEdgeWrapping;t.anisotropy=8;return t;
}
const srgb=t=>{if(THREE.SRGBColorSpace)t.colorSpace=THREE.SRGBColorSpace;else if(THREE.sRGBEncoding)t.encoding=THREE.sRGBEncoding;return t;};
// Ridge and hip caps are data per roof category. exposure is one cap piece along the line, width is each side
// of the line (metres). Metal has no textured cap. Valleys never get one: the faces just meet.
const roofCapSpecs={shingles:{style:'lapped',exposure:.14,width:.15,shade:.92},shake:{style:'alternating',exposure:.2,width:.18,shade:.9},slate:{style:'saddle',exposure:.3,width:.15,shade:.94},metal:null};
const CAP_LIFT=.015,CAP_RIDGE_LIFT=.004,CAP_PIECES=4;
function roofCapCanvas(category){
 const spec=roofCapSpecs[category];if(!spec)return null;
 const W=512,H=128,pw=W/CAP_PIECES,canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;const c=canvas.getContext('2d');
 let seed=[...('cap'+category)].reduce((s,ch)=>s*31+ch.charCodeAt(0)|0,11);const rnd=()=>{seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};
 const gray=(v,a=1)=>{const n=Math.max(0,Math.min(255,Math.round(v*255)));return a<1?'rgba('+n+','+n+','+n+','+a+')':'rgb('+n+','+n+','+n+')';};
 const rect=(x,y,w,h,fill)=>{c.fillStyle=fill;for(const dx of [0,-W,W])c.fillRect(x+dx,y,w,h);};
 const butt=(x,y,h)=>{for(const dx of [0,-W,W]){const g=c.createLinearGradient(x+dx-18,0,x+dx,0);g.addColorStop(0,gray(0,0));g.addColorStop(1,gray(0,.5));c.fillStyle=g;c.fillRect(x+dx-18,y,18,h);}rect(x,y,2,h,gray(.97));};
 // u runs along the line (uphill on hips), so each piece's exposed butt faces down the line and laps the one before it.
 if(spec.style==='lapped'){for(let k=0;k<CAP_PIECES;k++)rect(k*pw,0,pw,H,gray(.74+rnd()*.16));for(let k=0;k<CAP_PIECES;k++)butt(k*pw,0,H);for(let i=0;i<W*H/3;i++){c.fillStyle=gray(rnd()<.5?1:0,.2*rnd());c.fillRect(Math.floor(rnd()*W),Math.floor(rnd()*H),1,1);}}
 else if(spec.style==='alternating'){
  // Wood caps alternate which side laps over the line, so each side's joints sit half a piece apart.
  for(const [y0,offset]of [[0,0],[H/2,pw/2]])for(let k=0;k<CAP_PIECES;k++){const x=k*pw+offset,tone=.7+rnd()*.2;rect(x,y0,pw,H/2,gray(tone));for(let s=0;s<pw*.5;s++)rect(x+rnd()*pw,y0+rnd()*H/2*.3,rnd()*pw*.6,1,gray(rnd()<.5?tone+.12:tone-.14,.5));}
  for(const [y0,offset]of [[0,0],[H/2,pw/2]])for(let k=0;k<CAP_PIECES;k++)butt(k*pw+offset,y0,H/2);
  for(let k=0;k<CAP_PIECES;k++)rect(k*pw+(k%2?0:pw/2),H/2+(k%2?-2:0),pw/2,2,gray(.3));
 }else{
  // Saddle ridge: butt-jointed slates along the line, joints staggered between the two sides.
  rect(0,0,W,H,gray(.25));
  for(const [y0,offset]of [[0,0],[H/2,pw/2]])for(let k=0;k<CAP_PIECES;k++){const x=k*pw+offset+1,tone=.68+rnd()*.24;rect(x,y0+1,pw-2,H/2-2,gray(tone));for(let s=0;s<4;s++)rect(x+rnd()*pw*.5,y0+rnd()*H/2,pw*(.2+rnd()*.4),1,gray(tone-.08,.6));}
  rect(0,H/2-1,W,2,gray(.35));
 }
 rect(0,0,W,2,gray(.4));rect(0,H-2,W,2,gray(.4));
 return canvas;
}
const capMaps=new Map();
function roofCapTexture(category){if(!roofCapSpecs[category])return null;if(!capMaps.has(category)){const t=srgb(new THREE.CanvasTexture(roofCapCanvas(category)));t.wrapS=THREE.RepeatWrapping;t.wrapT=THREE.ClampToEdgeWrapping;t.anisotropy=8;capMaps.set(category,t);}return capMaps.get(category);}
const capNormals=new Map();
function roofCapNormalMap(category){if(!roofCapSpecs[category])return null;if(!capNormals.has(category)){const t=normalFromCanvas(roofCapTexture(category).image,4);if(t)t.wrapT=THREE.ClampToEdgeWrapping;capNormals.set(category,t);}return capNormals.get(category);}
// Cap strips straddle every ridge and hip line, folded onto each adjacent face, clipped to that face and lifted
// slightly above it (ridges a little more, so they lap the hips where they meet). Metric points, one merged geometry.
function roofCapGeometry(roof,category){
 const spec=roofCapSpecs[category];if(!spec||!roof?.faces?.length)return null;
 const K=root.ExteriorGeometry,Wg=root.WallSolidGeometry,positions=[],uv=[],index=[],sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z}),dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z,cross=(a,b)=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x}),unit=a=>{const l=Math.hypot(a.x,a.y,a.z)||1;return {x:a.x/l,y:a.y/l,z:a.z/l};};
 const onEdge=(p,ring)=>ring.some((a,i)=>{const b=ring[(i+1)%ring.length],ab=sub(b,a),l2=dot(ab,ab),t=l2?Math.max(0,Math.min(1,dot(sub(p,a),ab)/l2)):0;return Math.hypot(p.x-a.x-ab.x*t,p.y-a.y-ab.y*t,p.z-a.z-ab.z*t)<.02;});
 const lines=[],seen=new Set();
 for(const c of roof.connections||[]){
  const type=c.type?.id||c.type;if(type!=='ridge'&&type!=='hip')continue;
  let a=roof.points[c.startIdx],b=roof.points[c.endIdx];if(!K.finite3(a)||!K.finite3(b))continue;
  const key=[a,b].map(p=>[p.x,p.y,p.z].map(v=>Math.round(v*1000)).join(':')).sort().join('|');if(seen.has(key))continue;seen.add(key);
  if(type==='hip'&&a.z>b.z)[a,b]=[b,a];
  const length=Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z);if(length<.05)continue;
  const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2,z:(a.z+b.z)/2},dir=unit(sub(b,a)),faces=roof.faces.filter(f=>f.points?.length>2&&[a,b,mid].every(p=>onEdge(p,f.points))).slice(0,2);
  if(!faces.length)continue;lines.push({type,a,b});
  faces.forEach((face,sideIndex)=>{
   const frame=Wg.faceFrame(face);if(!frame||Math.abs(frame.n.z)<.05)return;const n=frame.n.z<0?{x:-frame.n.x,y:-frame.n.y,z:-frame.n.z}:frame.n,side=sideIndex?-1:1;
   let d=unit(cross(n,dir));const centroid=face.points.reduce((s,p)=>({x:s.x+p.x/face.points.length,y:s.y+p.y/face.points.length,z:s.z+p.z/face.points.length}),{x:0,y:0,z:0});if(dot(sub(centroid,a),d)<0)d={x:-d.x,y:-d.y,z:-d.z};
   const w=spec.width,quad=[a,b,{x:b.x+d.x*w,y:b.y+d.y*w,z:b.z+d.z*w},{x:a.x+d.x*w,y:a.y+d.y*w,z:a.z+d.z*w}];
   let parts=[];try{parts=K.intersection([{points:face.points,holes:face.holes||[]}],[{points:quad,holes:[]}]);}catch(_){parts=[];}
   const planeZ=p=>frame.origin.z-(n.x*(p.x-frame.origin.x)+n.y*(p.y-frame.origin.y))/n.z,lift=CAP_LIFT+(type==='ridge'?CAP_RIDGE_LIFT:0);
   for(const part of parts){
    const rings=[part.points,...(part.holes||[])];if(rings[0].length<3)continue;
    const flat=rings.flat(),base=positions.length/3,tri=THREE.ShapeUtils.triangulateShape(rings[0].map(p=>new THREE.Vector2(p.x,p.y)),rings.slice(1).map(r=>r.map(p=>new THREE.Vector2(p.x,p.y))));
    for(const p of flat){const q={x:p.x,y:p.y,z:planeZ(p)},rel=sub(q,a),s=Math.max(0,Math.min(w,dot(rel,d)));positions.push(q.x,q.y,q.z+lift);uv.push(dot(rel,dir)/(spec.exposure*CAP_PIECES),.5+side*s/(2*w));}
    for(const t of tri)index.push(base+t[0],base+t[1],base+t[2]);
   }
  });
 }
 return index.length?{positions,uv,index,lines}:null;
}
function roofCaps(roof,vector,category){
 const current=resolve({material:'shingles'}).category;category=category||current;const data=roofCapGeometry(roof,category);if(!data)return null;
 const g=new THREE.BufferGeometry(),pts=[];for(let i=0;i<data.positions.length;i+=3)pts.push(vector({x:data.positions[i],y:data.positions[i+1],z:data.positions[i+2]}));g.setFromPoints(pts);g.setAttribute('uv',new THREE.Float32BufferAttribute(data.uv,2));g.setIndex(data.index);
 const mesh=new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:'#54cf86',side:THREE.DoubleSide,transparent:true,opacity:.1,depthWrite:false}));mesh.name='roof-caps';mesh.userData.pickLayer='roof';mesh.userData.roofCaps=true;mesh.raycast=()=>{};
 mesh.userData.exteriorFinish={material:'shingles',roofCap:true,color:null,normal:{x:0,y:0,z:1},...(category===current?{}:{roofMaterial:{category}})};return mesh;
}
// Doors: one default door material per kind, tinted by the door's own color when it has one. The inset detail
// is grooves in the door's own outline: a standard panel layout for a recognised rectangle, otherwise the outline
// traced inward by the margin (following curves). Too small or degenerate doors get no inset.
const doorFinishes={door:{color:'#c8b9a2',roughness:.55,margin:.089,groove:.014,depth:6},garage:{color:'#d8d7d0',roughness:.5,margin:.07,groove:.014,depth:6}};
function doorInset(outline,type,rectangle){
 const spec=doorFinishes[type],empty={kind:'none',grooves:[]};if(!spec||!Array.isArray(outline)||outline.length<3||!outline.every(p=>Number.isFinite(p?.x)&&Number.isFinite(p?.y)))return empty;
 const xs=outline.map(p=>p.x),ys=outline.map(p=>p.y),left=Math.min(...xs),bottom=Math.min(...ys),w=Math.max(...xs)-left,h=Math.max(...ys)-bottom,m=spec.margin;
 if(!(w>=4*m&&h>=4*m))return empty;
 const box=(x0,y0,x1,y1)=>[{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];
 if(rectangle&&type==='door'){
  // Two to six recessed panels per leaf: stiles and rails one margin wide.
  const leaves=w>1.35?2:1,lw=w/leaves,rows=h>=1.9?3:2,cols=lw>=.75?2:1,grooves=[];
  for(let leaf=0;leaf<leaves;leaf++){const x0=left+leaf*lw,cw=(lw-m*(cols+1))/cols,rh=(h-m*(rows+1))/rows;if(cw<m||rh<m)continue;for(let r=0;r<rows;r++)for(let k=0;k<cols;k++){const x=x0+m+k*(cw+m),y=bottom+m+r*(rh+m);grooves.push(box(x,y,x+cw,y+rh));}}
  return grooves.length?{kind:'panels',grooves}:empty;
 }
 if(rectangle&&type==='garage'){
  // Horizontal sections, each with a row of recessed panels.
  const rows=Math.max(3,Math.min(6,Math.round(h/.53))),cols=Math.max(2,Math.min(8,Math.round(w/.75))),rh=h/rows,cw=w/cols,grooves=[];
  for(let r=1;r<rows;r++)grooves.push([{x:left,y:bottom+r*rh},{x:left+w,y:bottom+r*rh}]);
  for(let r=0;r<rows;r++)for(let k=0;k<cols;k++){const x=left+k*cw+m*.6,y=bottom+r*rh+m*.6;if(cw-1.2*m>m*.5&&rh-1.2*m>m*.5)grooves.push(box(x,y,x+cw-1.2*m,y+rh-1.2*m));}
  return {kind:'sections',grooves};
 }
 // Unrecognised outline: trace the edge inward by the margin.
 const C=root.ClipperLib;if(!C)return empty;const S=1e4,o=new C.ClipperOffset(2,S*.0025),solution=new C.Paths();
 o.AddPath(outline.map(p=>({X:Math.round(p.x*S),Y:Math.round(p.y*S)})),C.JoinType.jtRound,C.EndType.etClosedPolygon);o.Execute(solution,-m*S);
 const grooves=solution.filter(path=>path.length>2&&Math.abs(C.Clipper.Area(path))/S/S>m*m).map(path=>path.map(q=>({x:q.X/S,y:q.Y/S})));
 return grooves.length?{kind:'traced',grooves}:empty;
}
// The inset as a normal map over the door's bounds (its UVs span the bounds), drawn as grooves in a height canvas.
const doorMaps=new Map();
function doorNormalMap(outline,type,rectangle){
 const plan=doorInset(outline,type,rectangle);if(!plan.grooves.length)return null;
 const key=type+':'+rectangle+':'+outline.map(p=>p.x.toFixed(3)+','+p.y.toFixed(3)).join(';');if(doorMaps.has(key)){const t=doorMaps.get(key);doorMaps.delete(key);doorMaps.set(key,t);return t;}
 const xs=outline.map(p=>p.x),ys=outline.map(p=>p.y),left=Math.min(...xs),bottom=Math.min(...ys),w=Math.max(...xs)-left,h=Math.max(...ys)-bottom,ppm=Math.min(512/Math.max(w,h),200),W=Math.max(8,Math.round(w*ppm)),H=Math.max(8,Math.round(h*ppm));
 const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;const c=canvas.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,W,H);
 c.strokeStyle='#000';c.lineWidth=Math.max(2,doorFinishes[type].groove*ppm);c.lineJoin='round';if('filter' in c)c.filter='blur(1px)';
 for(const g of plan.grooves){c.beginPath();g.forEach((p,i)=>{const x=(p.x-left)*ppm,y=H-(p.y-bottom)*ppm;i?c.lineTo(x,y):c.moveTo(x,y);});if(g.length>2)c.closePath();c.stroke();}
 const t=normalFromCanvas(canvas,doorFinishes[type].depth,false);if(!t)return null;t.userData||={};t.userData.doorInset=plan.kind;doorMaps.set(key,t);
 for(const [k,old]of doorMaps){if(doorMaps.size<=48)break;doorMaps.delete(k);old.dispose();}
 return t;
}
// Stone and masonry have no photo set, so they get seeded procedural maps in natural colour (the photo brick stays
// brick). size is one tile in metres; wall UVs run in 2 ft units, so the map repeats at 0.6096/size.
const wallTiles={stone:{size:[1.2192,1.2192],description:'Fieldstone: irregular rubble, about 20-35 cm stones, recessed mortar'},masonry:{size:[1.2192,.6096],description:'CMU block: 16 x 8 in units, running bond, 3/8 in mortar'}};
function wallCanvas(type){
 const spec=wallTiles[type];if(!spec)return null;const ppm=420,W=Math.round(spec.size[0]*ppm),H=Math.round(spec.size[1]*ppm),canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;const c=canvas.getContext('2d');
 let seed=[...('wall'+type)].reduce((s,ch)=>s*31+ch.charCodeAt(0)|0,17);const rnd=()=>{seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};
 const image=c.createImageData?.(W,H);if(!image?.data){c.fillStyle=type==='stone'?'#8f8a80':'#b9b6ae';c.fillRect(0,0,W,H);return canvas;}
 const px=image.data,put=(i,r,g,b)=>{px[i]=Math.max(0,Math.min(255,r));px[i+1]=Math.max(0,Math.min(255,g));px[i+2]=Math.max(0,Math.min(255,b));px[i+3]=255;};
 if(type==='stone'){
  // Voronoi rubble on a torus (seamless): each cell a stone with its own warm-grey tone, mortar between cells.
  const n=5,cells=[],cw=W/n,ch=H/n;for(let j=0;j<n;j++)for(let i=0;i<n;i++){const tone=.42+rnd()*.3,warm=rnd()*.12-.04;cells.push({x:(i+.15+rnd()*.7)*cw,y:(j+.15+rnd()*.7)*ch,i,j,r:tone+warm,g:tone+warm*.4,b:tone-warm*.6,grain:rnd()*1000});}
  const mortar=.011*ppm,noise=(x,y,s)=>{const v=Math.sin(x*12.9898+y*78.233+s)*43758.5453;return v-Math.floor(v);};
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
   const ci=Math.floor(x/cw),cj=Math.floor(y/ch);let d1=Infinity,d2=Infinity,best=null;
   for(let dj=-2;dj<=2;dj++)for(let di=-2;di<=2;di++){const cell=cells[((cj+dj+n)%n)*n+((ci+di+n)%n)],ox=Math.floor((ci+di)/n)*W,oy=Math.floor((cj+dj)/n)*H,dx=cell.x+ox-x,dy=cell.y+oy-y,d=Math.sqrt(dx*dx+dy*dy);if(d<d1){d2=d1;d1=d;best=cell;}else if(d<d2)d2=d;}
   const edge=(d2-d1)/2,i=(y*W+x)*4;
   if(edge<mortar/2){const m=150+noise(x,y,3)*25;put(i,m,m-4,m-10);continue;}
   const bevel=Math.min(1,(edge-mortar/2)/(mortar*1.6)),shade=.72+.28*bevel,fleck=(noise(x,y,best.grain)-.5)*.12,k=255*shade;
   put(i,(best.r+fleck)*k,(best.g+fleck)*k,(best.b+fleck)*k);
  }
 }else{
  // CMU: 16 x 8 in blocks in running bond with thin recessed mortar; concrete pores, slight per-block tone.
  const bw=.4064*ppm,bh=.2032*ppm,mortar=Math.max(2,Math.round(.0095*ppm)),rows=Math.round(H/bh),cols=Math.round(W/bw),tones=[];for(let k=0;k<rows*cols;k++)tones.push(.68+rnd()*.1);
  for(let y=0;y<H;y++){const row=Math.floor(y/bh)%rows,yy=y-row*bh,offset=row%2?bw/2:0;for(let x=0;x<W;x++){
   const sx=(x+offset)%W,col=Math.floor(sx/bw)%cols,xx=sx-col*bw,i=(y*W+x)*4,joint=Math.min(xx,bw-xx,yy,bh-yy);
   if(joint<mortar/2){put(i,128,126,121);continue;}
   const tone=tones[row*cols+col]*(joint<mortar*1.5?.9:1),pore=rnd()<.05?-.12:(rnd()-.5)*.05,k=255*(tone+pore);put(i,k,k-1,k-4);
  }}
 }
 c.putImageData(image,0,0);return canvas;
}
const wallMaps=new Map(),wallNormals=new Map(),wallMeans=new Map();
function wallTexture(type){
 if(!wallTiles[type])return null;if(!wallMaps.has(type)){const t=srgb(new THREE.CanvasTexture(wallCanvas(type))),s=wallTiles[type].size;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(.6096/s[0],.6096/s[1]);t.anisotropy=8;t.userData||={};t.userData.wallType=type;wallMaps.set(type,t);}return wallMaps.get(type);
}
function wallNormalMap(type){
 if(!wallTiles[type])return null;if(!wallNormals.has(type)){const map=wallTexture(type),t=normalFromCanvas(map.image,type==='stone'?5:3);if(t)t.repeat.copy(map.repeat);wallNormals.set(type,t);}return wallNormals.get(type);
}
// Mean albedo in linear light and the mean paint-grain factor (see ExteriorRendered), for chimney caps.
function wallTextureMean(type){
 if(!wallTiles[type])return null;if(wallMeans.has(type))return wallMeans.get(type);
 const canvas=wallTexture(type).image,read=canvas.getContext?.('2d')?.getImageData?.(0,0,canvas.width,canvas.height);if(!read?.data)return null;
 const lin=v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;},sum=[0,0,0];let grain=0,n=0;
 for(let i=0;i<read.data.length;i+=4){const r=lin(read.data[i]),g=lin(read.data[i+1]),b=lin(read.data[i+2]);sum[0]+=r;sum[1]+=g;sum[2]+=b;grain+=.82+.24*Math.min(1,Math.max(0,(.2126*r+.7152*g+.0722*b)*2));n++;}
 const mean={linear:sum.map(v=>v/n),grain:grain/n};wallMeans.set(type,mean);return mean;
}
function texture(type){
 if(wallTiles[type])return wallTexture(type);
 if(cache.has(type))return cache.get(type);
 const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const c=canvas.getContext('2d');
 c.fillStyle='#eee';c.fillRect(0,0,256,256);
 const vertical=type.includes('vertical'),trim=type.startsWith('trim'),siding=type==='siding'||type.startsWith('siding-');
 if(vertical){c.translate(256,0);c.rotate(Math.PI/2);}
 if(siding){const grad=c.createLinearGradient(0,0,0,64);grad.addColorStop(0,'#aaa');grad.addColorStop(.09,'#dedede');grad.addColorStop(.16,'#f5f5f5');grad.addColorStop(1,'#e1e1e1');for(let y=0;y<256;y+=64){c.save();c.translate(0,y);c.fillStyle=grad;c.fillRect(0,0,256,64);c.fillStyle='#888';c.fillRect(0,0,256,2);c.restore();}}
 if(siding||trim){c.strokeStyle=trim?'#d6d6d6':'#d0d0d0';c.lineWidth=.5;for(let y=5;y<256;y+=7){c.beginPath();c.moveTo(0,y);c.bezierCurveTo(80,y+2,180,y-2,256,y);c.stroke();}}
 if(type==='opening-trim'){const g=c.createLinearGradient(0,0,0,256);for(const [at,color]of [[0,'#929292'],[.035,'#b6b6b6'],[.09,'#fafafa'],[.18,'#eeeeee'],[.84,'#e8e8e8'],[.94,'#cccccc'],[1,'#888888']])g.addColorStop(at,color);c.fillStyle=g;c.fillRect(0,0,256,256);c.strokeStyle='#00000008';c.lineWidth=.5;for(let y=28;y<224;y+=9){c.beginPath();c.moveTo(0,y);c.bezierCurveTo(80,y+1,180,y-1,256,y);c.stroke();}}
 if(type==='soffit'){for(let x=0;x<256;x+=32){c.fillStyle='#9ca0a2';c.fillRect(x,0,2,256);c.fillStyle='#fafafa';c.fillRect(x+2,0,2,256);for(let y=8;y<256;y+=12){c.fillStyle='#9ca0a2';c.fillRect(x+13,y,2,2);c.fillRect(x+19,y,2,2);}}}
 if(type==='shingles'){c.fillStyle='#d3d3d3';c.fillRect(0,0,256,256);for(let row=0;row<4;row++){const y=row*64;for(let col=-1;col<4;col++){const x=col*85+(row%2?42:0);c.fillStyle=['#c6c6c6','#dedede','#cecece'][(col+row+3)%3];c.fillRect(x,y,84,63);c.fillStyle='#777';c.fillRect(x,y+61,85,3);c.fillStyle='#a0a0a0';c.fillRect(x,y,1,61);}}for(let i=0;i<8000;i++){c.fillStyle=i%2?'#ffffff18':'#00000018';c.fillRect((i*73)%256,(i*139+Math.floor(i/256)*31)%256,1,1);}}
 if(type==='brick'||type==='masonry'){c.strokeStyle='#a0a0a0';c.lineWidth=3;for(let y=0;y<256;y+=32){c.beginPath();c.moveTo(0,y);c.lineTo(256,y);for(let x=(y%64?32:0);x<=256;x+=64){c.moveTo(x,y);c.lineTo(x,y+32);}c.stroke();}}
 if(['stucco','stone','other'].includes(type)){for(let i=0;i<1800;i++){const x=(i*137)%256,y=(i*73+Math.floor(i/256)*17)%256;c.fillStyle=i%2?'#dadada':'#f8f8f8';c.fillRect(x,y,type==='stone'?7:1,type==='stone'?5:1);}}
 const t=new THREE.CanvasTexture(canvas);t.wrapS=t.wrapT=THREE.RepeatWrapping;if(type==='opening-trim')t.wrapT=THREE.ClampToEdgeWrapping;t.anisotropy=4;if(THREE.SRGBColorSpace)t.colorSpace=THREE.SRGBColorSpace;else if(THREE.sRGBEncoding)t.encoding=THREE.sRGBEncoding;cache.set(type,t);return t;
}
// Opening maps cover one whole opening instead of repeating wall-sized tiles.
const openingMaps=new Map();
function openingTexture(finish){
 const type=finish.featureType,w=Math.max(.25,Math.round(finish.width*4)/4),h=Math.max(.25,Math.round(finish.height*4)/4),color=finish.color||(type==='door'||type==='garage'?stickerColor(type,'main'):type==='window'?stickerColor(type,'trim'):null)||({window:'#e8e7e1',skylight:'#41494e',door:'#c8c3b9',garage:'#deddd6',vent:'#d5d5ce'})[type]||'#deddd6',key=[type,w,h,color].join(':');
 if(openingMaps.has(key)){const t=openingMaps.get(key);openingMaps.delete(key);openingMaps.set(key,t);return t;}
 const canvas=document.createElement('canvas');canvas.width=canvas.height=512;const c=canvas.getContext('2d'),N=512;
 const fill=(x,y,w,h,color)=>{c.fillStyle=color;c.fillRect(x,y,w,h);};
 const gradient=(x,y,w,h,stops,vertical=true)=>{const g=c.createLinearGradient(x,y,vertical?x:x+w,vertical?y+h:y);for(const [at,color]of stops)g.addColorStop(at,color);fill(x,y,w,h,g);};
 const bevel=(x,y,w,h,b=5)=>{fill(x,y,w,h,'#777d7c');fill(x+b,y+b,w-2*b,h-2*b,color);fill(x+1,y+1,w-2,Math.max(1,b/2),'#ffffffa0');fill(x+1,y+1,Math.max(1,b/2),h-2,'#ffffff70');fill(x+b,y+h-b,w-b,b,'#00000036');fill(x+w-b,y+b,b,h-b,'#00000028');};
 const bx=Math.min(40,Math.max(5,.045/w*N)),by=Math.min(40,Math.max(5,.045/h*N));
 fill(0,0,N,N,'#343a3c');fill(bx*.4,by*.4,N-bx*.8,N-by*.8,color);
 if(type==='window'||type==='skylight'){
  const cols=type==='skylight'?1:Math.max(1,Math.min(4,Math.round(w/.95))),rows=type==='skylight'?1:h>1.05?2:1,gx=bx*.8,gy=by*.8,inner={x:bx*1.6,y:by*1.6,w:N-bx*3.2,h:N-by*3.2};
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
   const x=inner.x+col*inner.w/cols+gx/2,y=inner.y+row*inner.h/rows+gy/2,pw=inner.w/cols-gx,ph=inner.h/rows-gy;
   fill(x-3,y-3,pw+6,ph+6,'#616c6e');
   gradient(x,y,pw,ph,[[0,'#314958'],[.42,'#718c98'],[.64,'#536c74'],[1,'#233b42']]);
   // Soft sky reflections, shaded interior, and a restrained grazing highlight.
   c.save();c.beginPath();c.rect(x,y,pw,ph);c.clip();
   gradient(x,y,pw,ph,[[0,'#b4d7e01a'],[.48,'#d9e8e82e'],[.52,'#c2d7d60a'],[1,'#071419a0']]);
   for(let k=0;k<4;k++){c.fillStyle='#dce9e714';c.beginPath();c.ellipse(x+pw*(.1+k*.3),y+ph*.22,pw*.3,ph*.065,0,0,Math.PI*2);c.fill();}
   c.save();c.filter='blur(3px)';c.fillStyle='#172f3024';for(let k=0;k<22;k++){const tx=x+pw*k/21,ty=y+ph*(.82+.05*Math.sin(k*1.7+col));c.beginPath();c.ellipse(tx,ty,pw*.08,ph*(.035+.018*(1+Math.sin(k*2.1))),0,0,Math.PI*2);c.fill();}c.restore();
   c.fillStyle='#ffffff14';c.beginPath();c.moveTo(x+pw*.55,y);c.lineTo(x+pw*.8,y);c.lineTo(x+pw*.3,y+ph);c.lineTo(x+pw*.05,y+ph);c.fill();c.restore();
   fill(x,y,2,ph,'#101e2355');fill(x,y,pw,2,'#101e2366');fill(x+pw-1,y,1,ph,'#d5e6e977');
  }
  gradient(bx, N-by*1.5,N-bx*2,by,[[0,'#ffffff88'],[.3,'#ffffff22'],[1,'#00000055']]);
  if(rows===2){fill(N/2-8,N/2-2,16,4,'#a5a8a5');fill(N/2-4,N/2-4,8,3,'#ebede6');}
 }else if(type==='door'){
  const leaves=w>1.35?2:1;for(let leaf=0;leaf<leaves;leaf++){
   const x0=bx+leaf*(N-2*bx)/leaves,lw=(N-2*bx)/leaves;
   fill(x0,by,lw-1,N-by*2,color);const margin=Math.max(bx,lw*.12),gap=lw*.075,pw=(lw-2*margin-gap)/2;
   for(let row=0;row<3;row++)for(let col=0;col<2;col++){
    const heights=[.18,.32,.29],starts=[.08,.32,.69],x=x0+margin+col*(pw+gap),y=N*starts[row],ph=N*heights[row];bevel(x,y,pw,ph,Math.max(3,bx*.38));
    gradient(x+bx*.5,y+by*.6,pw-bx,ph-by*1.2,[[0,'#0000001e'],[.1,'#ffffff0a'],[1,'#ffffff26']]);
   }
   const hx=leaves===2?(leaf===0?x0+lw-bx*.75:x0+bx*.75):x0+lw-bx*.85,hy=N*.53;
   c.fillStyle='#262a2c';c.beginPath();c.ellipse(hx+2,hy+3,6,9,0,0,Math.PI*2);c.fill();
   gradient(hx-4,hy-9,8,18,[[0,'#e5e5df'],[.4,'#899295'],[.55,'#f4f3eb'],[1,'#444c51']],false);
   gradient(hx-4,hy-2,Math.min(25,lw*.12),5,[[0,'#626c70'],[.45,'#f0efe4'],[1,'#727d80']]);
   fill(x0,by,1,N-by*2,'#00000055');
  }
  gradient(bx,N-by,N-2*bx,by*.7,[[0,'#8c9292'],[.3,'#e2e0d7'],[1,'#565e62']]);
 }else if(type==='garage'){
  const rows=Math.max(3,Math.min(6,Math.round(h/.52))),cols=Math.max(2,Math.min(8,Math.round(w/.65))),left=bx*.6,top=by*.6,iw=N-left*2,ih=N-top*2;
  fill(left,top,iw,ih,color);
  for(let row=0;row<rows;row++){
   const y=top+row*ih/rows,rh=ih/rows;gradient(left,y,iw,rh,[[0,'#ffffff40'],[.08,'#ffffff12'],[.9,'#00000008'],[1,'#0000003a']]);
   for(let col=0;col<cols;col++){const cw=iw/cols;bevel(left+col*cw+cw*.12,y+rh*.19,cw*.76,rh*.6,3);}
   fill(left,y+rh-2,iw,2,'#454b4a');fill(left,y+rh,iw,1,'#faf9ef');
  }
  for(const x of [N*.46,N*.54]){fill(x-2,N*.77,4,14,'#535957');fill(x-1,N*.77,1,13,'#c5ccc8');}
 }else{
  fill(bx,by,N-2*bx,N-2*by,'#3c4748');const rows=Math.max(5,Math.min(16,Math.round(h/.065)));for(let i=0;i<rows;i++){const y=by+i*(N-2*by)/rows,rh=(N-2*by)/rows;fill(bx,y,N-2*bx,rh*.78,color);gradient(bx,y,N-2*bx,rh*.78,[[0,'#ffffff66'],[.2,'#ffffff0a'],[1,'#00000066']]);}
 }
 // Subpixel paint variation prevents broad frame surfaces looking perfectly flat.
 for(let i=0;i<2200;i++){c.fillStyle=i%2?'#ffffff05':'#00000005';c.fillRect((i*137)%N,(i*73+Math.floor(i/N)*17)%N,1,1);}
 const t=new THREE.CanvasTexture(canvas);t.wrapS=t.wrapT=THREE.ClampToEdgeWrapping;t.anisotropy=4;if(THREE.SRGBColorSpace)t.colorSpace=THREE.SRGBColorSpace;else if(THREE.sRGBEncoding)t.encoding=THREE.sRGBEncoding;t.userData||={};t.userData.exteriorFinishShared=true;t.userData.users=0;openingMaps.set(key,t);return t;
}
function pruneOpeningMaps(){for(const [key,t]of openingMaps){if(openingMaps.size<=48)break;if(!t.userData.users){openingMaps.delete(key);t.dispose();}}}
function bindOpeningMap(material,map){
 material.userData||={};const data=material.userData;if(data.openingMap!==map){if(data.openingMap)data.openingMap.userData.users--;data.openingMap=map;if(map)map.userData.users++;}
 if(!data.openingMapRelease&&material.addEventListener){data.openingMapRelease=true;material.addEventListener('dispose',()=>{if(data.openingMap){data.openingMap.userData.users--;data.openingMap=null;}pruneOpeningMaps();});}material.map=map;pruneOpeningMaps();
}
function prepare(mesh,face,points,parameters){
 if(!mesh.geometry?.setAttribute||!points?.length)return;
 if(face.feature)mesh.userData.renderedOpening={points:face.points||points,feature:face.feature,color:face.finishColor||null};
 const W=root.WallSolidGeometry;
 if(face.feature&&['window','skylight','door','garage','vent'].includes(face.feature.type)){
  const d=root.WallFeatures?.dimensions(face.points||points,face.feature);if(d){const uv=points.flatMap(p=>{const q=W.inFrame(d.frame,p);return [(q.x-d.bounds.left)/Math.max(1e-8,d.bounds.right-d.bounds.left),(q.y-d.bounds.bottom)/Math.max(1e-8,d.bounds.top-d.bounds.bottom)];});mesh.geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));mesh.userData.exteriorFinish={feature:true,featureType:face.feature.type,width:d.width*.3048,height:d.height*.3048,color:face.finishColor||null,normal:d.frame.n};return;}
 }
 if(face.openingTrim){
  const fr=W.faceFrame(face),a=face.points[0],b=face.points[1],length=Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z),u={x:(b.x-a.x)/length,y:(b.y-a.y)/length,z:(b.z-a.z)/length},v={x:fr.n.y*u.z-fr.n.z*u.y,y:fr.n.z*u.x-fr.n.x*u.z,z:fr.n.x*u.y-fr.n.y*u.x},dot=(p,axis)=>(p.x-a.x)*axis.x+(p.y-a.y)*axis.y+(p.z-a.z)*axis.z,ys=points.map(p=>dot(p,v)),lo=Math.min(...ys),span=Math.max(...ys)-lo;
  mesh.geometry.setAttribute('uv',new THREE.Float32BufferAttribute(points.flatMap((p,i)=>[dot(p,u)/.6096,(ys[i]-lo)/Math.max(1e-8,span)]),2));mesh.userData.exteriorFinish={material:'opening-trim',trim:true,color:face.stickerType!==undefined?(face.trimOwnColor||null):(face.finishColor||null),normal:fr.n,...(face.stickerType!==undefined?{stickerType:face.stickerType}:{})};mesh.userData.openingTrim=true;return;
 }
 const frame=W.faceFrame({points:face.points||points});let u=frame?.u||{x:1,y:0,z:0};
 if(frame&&Math.abs(frame.n.z)<.999){const length=Math.hypot(frame.n.x,frame.n.y);u={x:-frame.n.y/length,y:frame.n.x/length,z:0};}
 // Curved walls use arc length rather than a flattened projection, so boards
 // keep their width around the bend. Sampling here belongs only to rendering.
 let arcAt=null;const curve=face.curvedSurface?.start||face.curvedSurface?.curve;if(curve&&parameters){const K=root.ExteriorGeometry,lengths=[0];let previous=K.curvePoint(curve,0);for(let i=1;i<=128;i++){const p=K.curvePoint(curve,i/128);lengths.push(lengths.at(-1)+Math.hypot(p.x-previous.x,p.y-previous.y,p.z-previous.z));previous=p;}arcAt=t=>{const q=Math.max(0,Math.min(128,t*128)),i=Math.min(127,Math.floor(q));return lengths[i]+(lengths[i+1]-lengths[i])*(q-i);};}
 let axes=face.textureAxes;if(['shingles','soffit'].includes(face.material)&&frame){const n=frame.n.z<0?{x:-frame.n.x,y:-frame.n.y,z:-frame.n.z}:frame.n,l=Math.hypot(n.x,n.y),a=l>1e-8?{x:-n.y/l,y:n.x/l,z:0}:{x:1,y:0,z:0};axes={u:a,v:{x:n.y*a.z-n.z*a.y,y:n.z*a.x-n.x*a.z,z:n.x*a.y-n.y*a.x}};}const dot=(p,a)=>p.x*a.x+p.y*a.y+p.z*a.z;
 // A roof covering repeats at its own metric size: one tile is whole courses up the slope.
 const tile=face.material==='shingles'?roofMaterials[resolve(face).category].tile:[.6096,.6096];
 const horizontal=Math.abs(frame?.n.z||0)>.999,uv=points.flatMap((p,i)=>[(axes?dot(p,axes.u):arcAt?arcAt(parameters[i].x):p.x*u.x+p.y*u.y+p.z*u.z)/tile[0],(axes?dot(p,axes.v):horizontal?p.x*(frame?.v.x||0)+p.y*(frame?.v.y||1):p.z)/tile[1]]);
 mesh.geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));mesh.userData.exteriorFinish={material:face.material||(face.chimney?.cap&&!face.chimney.derived&&!face.trim?'chimney-top':frame?.n.z<-.5?'soffit':'default'),color:face.finishColor||null,feature:!!face.feature,trim:!!face.trim,normal:frame?.n,chimney:face.chimney?.id??null,chimneyCap:!!(face.chimney?.cap&&!face.chimney.derived&&!face.trim)};
}
// Roof features stay in the roof model. These derived surfaces are presentation-only.
function roofSkylights(roof){
 const K=root.ExteriorGeometry,nodes=new Map(),edges=new Set();
 const key=p=>[p.x,p.y,p.z].map(v=>Math.round(v*10000)).join(':');
 for(const c of roof?.connections||[]){
  if((c.type?.id||c.type)!=='skylight')continue;
  const a=roof.points[c.startIdx],b=roof.points[c.endIdx];if(!K.finite3(a)||!K.finite3(b))continue;
  const ak=key(a),bk=key(b),edge=[ak,bk].sort().join('|');if(ak===bk||edges.has(edge))continue;edges.add(edge);
  for(const [k,p,other]of [[ak,a,bk],[bk,b,ak]]){if(!nodes.has(k))nodes.set(k,{point:{...p},neighbors:[]});nodes.get(k).neighbors.push(other);}
 }
 const visited=new Set(),out=[];
 for(const start of nodes.keys()){
  if(visited.has(start))continue;
  const component=[],stack=[start];while(stack.length){const k=stack.pop();if(visited.has(k))continue;visited.add(k);component.push(k);stack.push(...nodes.get(k).neighbors);}
  // Never invent missing edges or guess through a branch.
  if(component.length<3||component.some(k=>nodes.get(k).neighbors.length!==2))continue;
  const points=[];let previous=null,current=start;
  do{const node=nodes.get(current);points.push(node.point);const next=node.neighbors.find(k=>k!==previous);previous=current;current=next;}while(current!==start&&points.length<=component.length);
  if(current!==start||points.length!==component.length)continue;
  try{K.validateFace({points});}catch(_){continue;}
  const n=K.normal(points);if(!n||Math.abs(n.z)<.01)continue;if(n.z<0)points.reverse();
  const a=points[0],b=points[1];out.push({points,feature:{type:'skylight',axis:{x:b.x-a.x,y:b.y-a.y,z:b.z-a.z}}});
 }
 return out;
}
function roofPresentation(roof){
 const skylights=roofSkylights(roof),K=root.ExteriorGeometry,W=root.WallSolidGeometry;
 if(!skylights.length)return {faces:roof.faces,skylights};
 const faces=(roof.faces||[]).flatMap(face=>{
  const frame=W.faceFrame(face);if(!frame||Math.abs(frame.n.z)<.01)return [face];
  const cuts=skylights.filter(s=>s.points.every(p=>Math.abs(K.local(frame,p).z)<.15));
  if(!cuts.length||!K.intersection([face],cuts).length)return [face];
  const lift=p=>({...p,z:frame.origin.z-(frame.n.x*(p.x-frame.origin.x)+frame.n.y*(p.y-frame.origin.y))/frame.n.z});
  return K.difference(face,cuts).map(part=>({...face,points:part.points.map(lift),holes:(part.holes||[]).map(r=>r.map(lift))}));
 });
 return {faces,skylights};
}
function skylightMesh(face,vector){
 const geometry=new THREE.BufferGeometry().setFromPoints(face.points.map(vector));
 geometry.setIndex(root.ExteriorGeometry.triangles(face.points).triangles.flat());
 const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:'#88a5ad',side:THREE.DoubleSide}));
 mesh.name='roof-skylight';mesh.userData.pickLayer='roof';mesh.userData.exteriorFeature=true;
 prepare(mesh,face,face.points);return mesh;
}
function roofMeshes(face,vector,textured){
 const rings=[face.points,...(face.holes||[])],points=rings.flat(),positions=points.map(vector),projected=rings.map(r=>r.map(p=>new THREE.Vector2(p.x,p.y)));
 const triangles=THREE.ShapeUtils.triangulateShape(projected[0],projected.slice(1)).map(ids=>{const [a,b,c]=ids.map(i=>positions[i]),rise=vector({...points[ids[0]],z:points[ids[0]].z+1}),u={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},v={x:c.x-a.x,y:c.y-a.y,z:c.z-a.z},dot=(u.y*v.z-u.z*v.y)*(rise.x-a.x)+(u.z*v.x-u.x*v.z)*(rise.y-a.y)+(u.x*v.y-u.y*v.x)*(rise.z-a.z);return dot<0?[ids[0],ids[2],ids[1]]:ids;});
 return (textured?[false,true]:[false]).map(underside=>{
  const geometry=new THREE.BufferGeometry().setFromPoints(positions);geometry.setIndex(triangles.flat());
  const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:'#54cf86',side:textured?(underside?THREE.BackSide:THREE.FrontSide):THREE.DoubleSide,transparent:true,opacity:.1,depthWrite:false}));mesh.userData.pickLayer='roof';mesh.userData.roofUnderside=underside;
  prepare(mesh,{...face,material:underside?(face.soffitMaterial||'soffit'):'shingles',finishColor:underside?face.soffitColor:face.finishColor,textureAxes:face.textureAxes},points);return mesh;
 });
}
// r128 leaves CSS colors in sRGB, while tile visibility changes renderer output.
// Finish maps and tints use linear light internally and always emit display sRGB.
// A uniform restores the normal renderer policy when leaving textured mode.
function colorManagedFinish(material){
 material.userData||={};
 let enabled=material.userData.exteriorFinishColorManaged;
 if(!enabled){
  enabled=material.userData.exteriorFinishColorManaged={value:0};
  const compile=material.onBeforeCompile,key=material.customProgramCacheKey;
  material.onBeforeCompile=function(shader,renderer){
   compile?.call(this,shader,renderer);
   shader.uniforms.exteriorFinishColorManaged=enabled;
   shader.fragmentShader='uniform float exteriorFinishColorManaged;\n'+shader.fragmentShader.replace('#include <encodings_fragment>', 'if (exteriorFinishColorManaged > 0.5) { gl_FragColor = LinearTosRGB(gl_FragColor); } else {\n#include <encodings_fragment>\n}');
  };
  material.customProgramCacheKey=function(){return (key?.call(this)||'')+':exterior-finish-srgb-v1';};
  material.needsUpdate=true;
 }
 enabled.value=1;
}
function reset(material){const enabled=material.userData?.exteriorFinishColorManaged;if(enabled)enabled.value=0;}
function apply(mesh,material){
 const finish=mesh.userData.exteriorFinish||((mesh.userData.pickLayer==='walls'||mesh.userData.pickLayer==='base'||mesh.userData.baseId!==undefined)?{material:'default'}:null);
 if(!finish)return;if(finish.feature){if(finish.featureType){colorManagedFinish(material);material.color.set('#ffffff');bindOpeningMap(material,openingTexture(finish));}return;}
 // The construction base has its own neutral default, independent of cladding.
 const base=(mesh.userData.baseId!==undefined||mesh.userData.pickLayer==='base')&&!finish.trim&&['default','unassigned',undefined].includes(finish.material);
 const resolved=base?{material:'unassigned',color:finish.color||'#b3afa7'}:resolve(finish);
 colorManagedFinish(material);
 material.color.set(resolved.color);material.color.convertSRGBToLinear?.();
 const n=finish.normal;if(n)material.color.multiplyScalar(.78+.22*Math.abs(n.x*.37+n.y*.53+n.z*.76));
 material.map=['unassigned','chimney-top'].includes(resolved.material)?null:resolved.material==='shingles'?(finish.roofCap?roofCapTexture(resolved.category):roofTexture(resolved.category)):texture(resolved.material);
}
root.ExteriorFinishes={prepare,apply,reset,resolve,defaults,roofMeshes,roofSkylights,roofPresentation,skylightMesh,roofMaterials,roofDefault,resolveRoof,roofCanvas,roofTexture,roofNormalMap,roofCapSpecs,roofCapCanvas,roofCapTexture,roofCapNormalMap,roofCapGeometry,roofCaps,doorFinishes,doorInset,doorNormalMap,stickerPieces,stickerKind,stickerDefaults,stickerColor,stickerTrimOwnColor,wallTiles,wallCanvas,wallTexture,wallNormalMap,wallTextureMean};
})(window);
