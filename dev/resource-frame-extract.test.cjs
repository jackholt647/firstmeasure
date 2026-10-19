// Server-side frame extraction: the PHP job assembles a stored chunked video,
// decodes the frame a browser shows at a timestamp with ffmpeg, and publishes
// it as a chunked PNG resource (plus an optional favorite record).
// Needs php and ffmpeg (set FIRSTMEASURE_FFMPEG to a binary when it is not on PATH).
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const ffmpeg=process.env.FIRSTMEASURE_FFMPEG||'ffmpeg',php=process.env.PHP_BINARY||'php';
const available=bin=>!spawnSync(bin,['-version'],{encoding:'utf8'}).error;
const missing=!available(php)?'php is not installed':!available(ffmpeg)?'ffmpeg is not installed (set FIRSTMEASURE_FFMPEG)':'';
const library=path.resolve(__dirname,'../public/measure/internal/_resource_frames.php').replace(/\\/g,'/');
const harness=`<?php
require ${JSON.stringify(library)};
$input=json_decode(file_get_contents($argv[1]),true);$dir=$input['store'];
$get=function($name)use($dir){if(!is_file("$dir/$name"))throw new RuntimeException("missing $name");return file_get_contents("$dir/$name");};
$put=function($name,$bytes,$digest)use($dir){if($digest!==null&&!hash_equals($digest,hash('sha256',$bytes)))throw new RuntimeException('digest');file_put_contents("$dir/$name",$bytes);};
if(isset($input['publish'])){fm_resource_publish_bytes($input['publish']['name'],file_get_contents($input['publish']['file']),['original_name'=>'Walk through.mp4'],$put);echo json_encode(['ok'=>true]);exit;}
try{echo json_encode(fm_resource_frame_run($input['job'],$get,$put,['ffmpeg'=>$input['ffmpeg']??null,'cache_dir'=>"$dir/cache"]));}
catch(Throwable $e){echo json_encode(['status'=>'failed','error'=>$e->getMessage()]);}
`;
const video='internal-resource-v2-11111111-1111-4111-8111-111111111111-Walk_through.mp4';
const frameName=n=>`internal-resource-v2-2222222${n}-2222-4222-8222-222222222222-Walk_through-frame.png`;
test('server extracts the displayed video frame and publishes it as a chunked resource',{skip:missing||false},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-frames-')),store=path.join(dir,'store');fs.mkdirSync(store);
 try{
  const script=path.join(dir,'harness.php');fs.writeFileSync(script,harness);
  const run=input=>{const file=path.join(dir,'input.json');fs.writeFileSync(file,JSON.stringify({store,ffmpeg,...input}));const result=spawnSync(php,[script,file],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
  // 10 fps, two seconds; frame N has red = N * 12 so each frame is identifiable.
  const source=path.join(dir,'source.mp4');
  const made=spawnSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=black:s=64x48:r=10:d=2','-vf',"format=rgb24,geq=r='N*12':g=0:b=0",'-c:v','libx264','-pix_fmt','yuv444p','-qp','0','-g','7',source],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);
  run({publish:{name:video,file:source}});
  const red=name=>{const index=JSON.parse(fs.readFileSync(path.join(store,name),'utf8'));const png=Buffer.concat(Array.from({length:index.parts},(_,i)=>fs.readFileSync(path.join(store,`internal-markup-part-${index.id}-${String(i).padStart(8,'0')}.bin`))));
   assert.equal(png.subarray(1,4).toString(),'PNG');const pngFile=path.join(dir,'check.png');fs.writeFileSync(pngFile,png);
   const raw=spawnSync(ffmpeg,['-v','error','-i',pngFile,'-f','rawvideo','-pix_fmt','rgb24','-'],{maxBuffer:1<<24});return {red:raw.stdout[0],index};};
  const job=(n,time,extra={})=>({project:'fullhouse_test',frame:frameName(n),source:video,time,original_name:'Walk through – 0:0'+n+'.png',role:'tech',actor:{email:'tech@example.com',name:'Tech'},...extra});
  for(const [n,time,expected]of [[1,.55,5],[2,.5,5],[3,.49,4],[4,1.95,19],[5,0,0]]){
   const result=run({job:job(n,time)});assert.equal(result.status,'done',result.error);
   const {red:value,index}=red(frameName(n));assert.ok(Math.abs(value-expected*12)<=3,`t=${time}: frame ${expected} expected (red ${expected*12}), got red ${value}`);
   assert.equal(index.original_name,'Walk through – 0:0'+n+'.png');assert.deepEqual(index.source_video,{name:video,time});assert.equal(index.role,'tech');assert.equal(index.uploaded_by.email,'tech@example.com');assert.equal(index.content_type,'image/png');
  }
  // The assembled video is reused from the workspace for later frames.
  assert.equal(fs.readdirSync(path.join(store,'cache')).filter(f=>f.endsWith('.mp4')).length,1);
  const favorite=run({job:job(6,1.0,{favorite:{record:'internal-markup-favorite-33333333-3333-4333-8333-333333333333.json',label:'Back of house'}})});assert.equal(favorite.status,'done');
  const record=JSON.parse(fs.readFileSync(path.join(store,'internal-markup-favorite-33333333-3333-4333-8333-333333333333.json'),'utf8'));
  assert.deepEqual({label:record.label,source:record.source,time:record.time,frame:record.frame,version:record.version},{label:'Back of house',source:video,time:1,frame:frameName(6),version:1});
  assert.ok(Math.abs(red(frameName(6)).red-120)<=3);
  // Failures are reported, never published.
  const missingBinary=run({ffmpeg:path.join(dir,'no-ffmpeg-here'),job:job(7,.5)});assert.equal(missingBinary.status,'failed');assert.match(missingBinary.error,/not available|not installed/);assert.equal(fs.existsSync(path.join(store,frameName(7))),false);
  fs.rmSync(path.join(store,'cache'),{recursive:true});const part=path.join(store,'internal-markup-part-11111111-1111-4111-8111-111111111111-00000000.bin'),bytes=fs.readFileSync(part);fs.writeFileSync(part,Buffer.concat([bytes.subarray(0,-1),Buffer.from([bytes.at(-1)^1])]));
  const corrupt=run({job:job(8,.5)});assert.equal(corrupt.status,'failed');assert.match(corrupt.error,/integrity/);assert.equal(fs.existsSync(path.join(store,frameName(8))),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

// The real bridge: POST ?action=frame answers 202 at once, then the same
// request extracts and publishes the frame, and the job record reports it.
const http=require('node:http'),crypto=require('node:crypto');
const phpExt=path.dirname(spawnSync(php,['-r','echo PHP_BINARY;'],{encoding:'utf8'}).stdout||'')+'/ext';
const phpArgs=['-d','display_errors=0','-d','extension_dir='+phpExt,'-d','extension=curl','-d','extension=mbstring'];
const bridgeMissing=missing||(spawnSync(php,[...phpArgs,'-r','exit(function_exists("curl_init")?0:1);']).status?'php curl extension is unavailable':'');
test('project_resources.php accepts a frame job, answers before extracting, and publishes the frame',{skip:bridgeMissing||false},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-bridge-')),project='fullhouse_'+'a'.repeat(32),store=new Map();
 const api=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
  const body=Buffer.concat(chunks),u=new URL(req.url,'http://api'),send=(status,value,type='application/json')=>{res.writeHead(status,{'Content-Type':type});res.end(Buffer.isBuffer(value)?value:JSON.stringify(value));};
  if(u.pathname==='/internal-exteriors/capability')return send(200,{email:'tech@example.com'});
  const m=u.pathname.match(/^\/projects\/([^/]+)\/artifacts(?:\/(.+))?$/);if(!m||m[1]!==project)return send(404,{error:'no'});
  if(req.method==='POST'){const boundary=req.headers['content-type'].split('boundary=')[1],text=body.toString('latin1'),name=text.match(/filename="([^"]+)"/)[1],start=text.indexOf('\r\n\r\n')+4,end=text.lastIndexOf('\r\n--'+boundary);store.set(name,body.subarray(start,end));return send(200,{ok:true,artifact:{name,size:end-start}});}
  if(!m[2])return send(200,{files:[...store].map(([name,b])=>({name,size:b.length,updated_at:new Date().toISOString()}))});
  const name=decodeURIComponent(m[2]);return store.has(name)?send(200,store.get(name),'application/octet-stream'):send(404,{error:'missing'});
 });});
 await new Promise(r=>api.listen(0,'127.0.0.1',r));
 const router=path.join(dir,'router.php'),entry=path.resolve(__dirname,'../public/measure/internal/project_resources.php').replace(/\\/g,'/');
 fs.writeFileSync(router,`<?php session_start(); $_SESSION['user_email']='tech@example.com'; session_write_close(); chdir(${JSON.stringify(path.dirname(entry))}); require ${JSON.stringify(entry)};`);
 const port=40000+Math.floor(Math.random()*20000);
 const server=require('node:child_process').spawn(php,[...phpArgs,'-S','127.0.0.1:'+port,router],{env:{...process.env,FIRSTMEASURE_API_BASE:'http://127.0.0.1:'+api.address().port,FIRSTMEASURE_FULL_HOUSE_SIGNING_SECRET:'test-secret',FIRSTMEASURE_FFMPEG:ffmpeg},stdio:'ignore'});
 try{
  const source=path.join(dir,'source.mp4');assert.equal(spawnSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=black:s=64x48:r=10:d=2','-vf',"format=rgb24,geq=r='N*12':g=0:b=0",'-c:v','libx264','-pix_fmt','yuv444p','-qp','0',source]).status,0);
  // Store the video the way the browser upload does: parts, then an index.
  const bytes=fs.readFileSync(source),vid='44444444-4444-4444-8444-444444444444',sha=crypto.createHash('sha256').update(bytes).digest('hex');
  store.set(`internal-markup-part-${vid}-00000000.bin`,bytes);store.set(`internal-resource-v2-${vid}-Walk_through.mp4`,Buffer.from(JSON.stringify({format:'firstmeasure-resource-chunks-v1',id:vid,size:bytes.length,chunkSize:8*1024*1024,parts:1,sha256:[sha],original_name:'Walk through.mp4'})));
  const base=`http://127.0.0.1:${port}/project_resources.php?project=${project}`;
  for(let i=0;i<50;i++){try{await fetch(base);break;}catch{await new Promise(r=>setTimeout(r,100));}}
  const frame='internal-resource-v2-55555555-5555-4555-8555-555555555555-Walk_through-frame-1.20s.png';
  const post=(name,body)=>fetch(`${base}&name=${name}&action=frame`,{method:'POST',headers:{'X-Resource-Request':'1','X-Resource-Role':'tech','Content-Type':'application/json'},body:JSON.stringify(body)});
  const bad=await post(frame,{source:`internal-resource-v2-${vid}-missing.mp4`,time:1});assert.equal(bad.status,404);
  assert.equal((await post('internal-resource-v2-55555555-5555-4555-8555-555555555555-Ünïcode frame.png',{source:`internal-resource-v2-${vid}-Walk_through.mp4`,time:1})).status,400);
  const accepted=await post(frame,{source:`internal-resource-v2-${vid}-Walk_through.mp4`,time:1.2,original_name:'Walk through – 0:01.png',favorite:{record:'internal-markup-favorite-66666666-6666-4666-8666-666666666666.json',label:'Porch'}});
  assert.equal(accepted.status,202);const answer=await accepted.json();assert.equal(answer.job,'internal-markup-framejob-55555555-5555-4555-8555-555555555555.json');
  let record;for(let i=0;i<100;i++){record=await (await fetch(`${base}&name=${answer.job}`)).json();if(record.status!=='running')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(record.status,'done',record.error);
  const png=Buffer.from(await (await fetch(`${base}&name=${frame}`)).arrayBuffer());assert.equal(png.subarray(1,4).toString(),'PNG');
  const check=path.join(dir,'check.png');fs.writeFileSync(check,png);const red=spawnSync(ffmpeg,['-v','error','-i',check,'-f','rawvideo','-pix_fmt','rgb24','-']).stdout[0];assert.ok(Math.abs(red-144)<=3,'frame 12 expected, red '+red);
  const listing=(await (await fetch(base)).json()).files,listed=listing.find(f=>f.name===frame);assert.equal(listed.original_name,'Walk through – 0:01.png');assert.equal(listed.role,'tech');
  const favorite=JSON.parse(store.get('internal-markup-favorite-66666666-6666-4666-8666-666666666666.json'));assert.equal(favorite.label,'Porch');assert.equal(favorite.frame,frame);
 }finally{server.kill();api.close();fs.rmSync(dir,{recursive:true,force:true});}
});
