/* Saved undo/redo: deduplicate immutable snapshots and upload bounded artifacts.
 * The project metadata references a complete immutable upload, never half a save.
 */
(function(root){'use strict';
 const CHUNK_BYTES=1024*1024;
 // History snapshots are immutable. Reuse unchanged branches in memory too,
 // rather than retaining another full building for every committed edit.
 function share(previous,value){
  if(previous===value)return previous;
  if(!previous||!value||typeof previous!=='object'||typeof value!=='object'||Array.isArray(previous)!==Array.isArray(value))return value;
  const keys=Object.keys(value);let same=keys.length===Object.keys(previous).length;
  const pairs=keys.map(k=>{const next=share(previous[k],value[k]);if(!Object.hasOwn(previous,k)||next!==previous[k])same=false;return [k,next];});
  if(same)return previous;return Array.isArray(value)?pairs.map(([,v])=>v):Object.fromEntries(pairs);
 }
 function pack(value){
  const nodes=[],intern=new Map(),memo=new WeakMap(),visiting=new WeakSet();
  function token(v){
   if(v===null||typeof v!=='object')return v===undefined?null:v;
   if(memo.has(v))return [memo.get(v)];
   if(visiting.has(v))throw Error('Undo history contains a circular reference.');visiting.add(v);
   const node=Array.isArray(v)?['a',v.map(token)]:['o',Object.keys(v).filter(k=>v[k]!==undefined).sort().flatMap(k=>[k,token(v[k])])];
   const key=JSON.stringify(node);let id=intern.get(key);
   if(id===undefined){id=nodes.length;nodes.push(node);intern.set(key,id);}
   visiting.delete(v);memo.set(v,id);return [id];
  }
  const start=token(value);return {version:1,nodes,root:start};
 }
 function unpack(data){
  if(data?.version!==1||!Array.isArray(data.nodes))throw Error('Unsupported undo history format.');
  const values=[];
  const token=(v,limit)=>{if(!Array.isArray(v))return v;if(v.length!==1||!Number.isInteger(v[0])||v[0]<0||v[0]>=limit)throw Error('Invalid undo history reference.');return values[v[0]];};
  for(const node of data.nodes){
   if(!Array.isArray(node)||node.length!==2||!Array.isArray(node[1]))throw Error('Invalid undo history data.');
   const [type,items]=node;let value;
   if(type==='a')value=items.map(v=>token(v,values.length));
   else if(type==='o'&&items.length%2===0){value={};for(let i=0;i<items.length;i+=2){if(typeof items[i]!=='string')throw Error('Invalid undo history key.');Object.defineProperty(value,items[i],{value:token(items[i+1],values.length),enumerable:true,writable:true,configurable:true});}}
   else throw Error('Invalid undo history node.');values.push(Object.freeze(value));
  }
  return token(data.root,values.length);
 }
 const digest=async bytes=>Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
 const uploaded=new Set();
 async function save(project,value,upload){
  let blob=new Blob([JSON.stringify(pack(value))],{type:'application/json'}),encoding='json';
  if(typeof CompressionStream!=='undefined'){blob=await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();encoding='gzip';}
  const parts=[];
  for(let offset=0;offset<blob.size;offset+=CHUNK_BYTES){
   const chunk=blob.slice(offset,offset+CHUNK_BYTES),hash=await digest(await chunk.arrayBuffer()),name='editor-history-'+hash+'.bin',key=project+':'+name;
   if(!uploaded.has(key)){await upload(project,chunk,name);uploaded.add(key);}
   parts.push({name,sha256:hash,size:chunk.size});
  }
  return {version:1,encoding,size:blob.size,parts};
 }
 async function load(project,manifest,read){
  if(!manifest)return null;
  if(manifest.version!==1||!['json','gzip'].includes(manifest.encoding)||!Array.isArray(manifest.parts)||!manifest.parts.length)throw Error('Unsupported saved undo history.');
  const chunks=[];let size=0;
  for(const part of manifest.parts){
   if(!/^[a-f0-9]{64}$/.test(part.sha256)||part.name!=='editor-history-'+part.sha256+'.bin'||!Number.isInteger(part.size)||part.size<1||part.size>CHUNK_BYTES)throw Error('Invalid undo history artifact.');
   const bytes=await read(project,part.name);
   if(bytes.byteLength!==part.size||await digest(bytes)!==part.sha256)throw Error('Undo history download failed its integrity check. Please reload.');
   chunks.push(bytes);size+=bytes.byteLength;uploaded.add(project+':'+part.name);
  }
  if(size!==manifest.size)throw Error('Incomplete undo history download.');
  let blob=new Blob(chunks);
  if(manifest.encoding==='gzip'){
   if(typeof DecompressionStream==='undefined')throw Error('This browser cannot read compressed undo history. Please use an updated browser.');
   blob=await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
  }
  return unpack(JSON.parse(await blob.text()));
 }
 // History points retain the imagery calibration at capture time. This allows
 // undo after a supplemental-structure view or a different calibrated raster.
 function projectPoint(point,from,to){
  const p=JSON.parse(JSON.stringify(point));
  if(!from||!to||!(from.mpp>0&&to.mpp>0)||![from.lat,from.lng,to.lat,to.lng,from.width,from.height,to.width,to.height].every(Number.isFinite))return p;
  const sx=from.mpp/to.mpp*Math.cos(to.lat*Math.PI/180)/Math.cos(from.lat*Math.PI/180),sy=from.mpp/to.mpp;
  const dx=to.width/2-from.width/2*sx+(from.lng-to.lng)*111132*Math.cos(to.lat*Math.PI/180)/to.mpp;
  const dy=to.height/2-from.height/2*sy+(to.lat-from.lat)*111132/to.mpp;
  p.x=p.x*sx+dx;p.y=p.y*sy+dy;
  if(p._lockedPlanes)p._lockedPlanes=p._lockedPlanes.map(pl=>({a:pl.a/sx,b:pl.b/sy,c:pl.c-pl.a*dx/sx-pl.b*dy/sy}));
  return p;
 }
 const api={pack,unpack,save,load,projectPoint,share};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.EditorHistory=api;
})(typeof window==='undefined'?globalThis:window);
