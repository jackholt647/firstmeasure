// FM-319: a full-house practice project gets the source's reference imagery (map layers, structure imagery,
// the saved Google 3D capture) through the allowlist, never the answer. tests/tutorial-exteriors.test.ts checks the same names against Node's copy.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),os=require('node:os');
const dir=path.join(__dirname,'../public/measure/internal/');
const hasPhp=spawnSync('php',['-v']).status===0;

test('the source bundle carries reference imagery and no answer files',{skip:!hasPhp},()=>{
 const stub=fs.mkdtempSync(path.join(os.tmpdir(),'tutorial-imagery-'));
 const names=['google.png','azure.png','apple.png','rgb.tif','dsm.tif','structure-1-rgb.tif','structure-1-apple.png','instant-structures.json','internal-resource-v2-a-front.jpg','internal-markup-part-a-00000000.bin','app_metadata.json','pdf_state.json','Report.pdf','model_data.xml','quad_crop.png','internal-markup-a-1.json'];
 fs.writeFileSync(stub+'/_full_house.php',"<?php function fm_is_full_house_id($id){return true;} function fm_legacy_manifest($m){return $m;} function fm_staff_session_email(){return 's@e.test';}");
 const source=fs.readFileSync(dir+'_tutorial_source.php','utf8').replace(/function fm_tutorial_bridge\(\$body\) \{/,`function fm_tutorial_bridge($body) { return ['status'=>200,'json'=>['manifest'=>[],'assets'=>['google_3d_manifest'=>'https://node.test/manifest.json'],'files'=>array_map(fn($name)=>['name'=>$name],${JSON.stringify(names)})]]; }\nfunction fm_tutorial_bridge_unused($body) {`);
 fs.writeFileSync(stub+'/_tutorial_source.php',source);
 fs.writeFileSync(stub+'/run.php',`<?php
function fm_tutorial_find_project($id,$student,$course=null){return ['course_id'=>'full-house-drawing','manifest'=>['source_project_id'=>'fullhouse_x','measurement_scope'=>'full_house']];}
require __DIR__.'/_tutorial_source.php';
$b=fm_tutorial_fetch_source_bundle('tutorial_a','s@e.test','default');
echo json_encode(['files'=>array_column($b['files'],'name'),'assets'=>$b['assets'],'manifest'=>json_decode(fm_tutorial_source_capture_manifest('{"tiles":[{"file":"0001-a.glb"}]}','tutorial_a','s@e.test','full-house-drawing'),true)]);
`);
 const run=spawnSync('php',[stub+'/run.php'],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);
 const out=JSON.parse(run.stdout);fs.rmSync(stub,{recursive:true,force:true});
 assert.deepEqual(out.files,names.slice(0,10));
 for(const key of ['azure','apple','structure-1-rgb','structure-1-apple','instant-structures'])assert.match(out.assets[key],/^tutorial_sources\.php\?/,key);
 assert.equal(out.assets.app_metadata,undefined);assert.equal(out.assets.report,undefined);
 const manifestUrl=new URL(out.assets.google_3d_manifest,'https://x.test/');
 assert.equal(manifestUrl.searchParams.get('name'),'google-3d/manifest.json','the capture is read through the training proxy, not Node');
 assert.equal(manifestUrl.searchParams.get('course_id'),'full-house-drawing');
 assert.equal(new URL(out.manifest.tiles[0].url,'https://x.test/').searchParams.get('name'),'google-3d/tiles/0001-a.glb');
 assert.equal(out.manifest.tiles[0].file,'0001-a.glb');
});

test('the editor loads a training capture by tile url and never asks a training project to make one',()=>{
 const scene=fs.readFileSync(dir+'editor_scripts/scene_3d.js','utf8');
 assert.match(scene,/loadGltfScene\(tile\.url \? new URL\(tile\.url, manifestUrl\)\.href : tileBaseUrl \+ tile\.file, loader\)/);
 assert.match(scene,/allowGenerate: !hasManifestUrl && !window\.FIRSTMEASURE_TUTORIAL\?\.enabled/);
});

test('a training project takes reference notes from its own manifest, with no false load error',()=>{
 assert.match(fs.readFileSync(dir+'editor_scripts/project_resources.js','utf8'),/async function feedback\(id\)\{if\(window\.firstMeasureIsTutorialProjectId\?\.\(id\)\)return \{manifest:/);
});
