// FM-318: the editor's resource requests carry no course_id. A project in any course but "default"
// must still reach Node under its own course, or every request answers "Training references are unavailable."
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),os=require('node:os');
const dir=path.join(__dirname,'../public/measure/internal/');
const read=name=>fs.readFileSync(dir+name,'utf8');

test('project_resources.php uses the course the project was found in',()=>{
 const source=read('project_resources.php'),find=source.indexOf('$tutorialResource = fm_tutorial_find_project('),course=source.indexOf("$tutorialCourse = $tutorialResource['course_id'];"),use=source.indexOf('function resource_api(');
 assert.ok(find>0&&course>find&&course<use,'the found course replaces the request course before any storage call');
});

test('the source bundle asks Node for the course the project lives in',{skip:spawnSync('php',['-v']).status!==0},()=>{
 const stub=fs.mkdtempSync(path.join(os.tmpdir(),'tutorial-course-'));
 fs.writeFileSync(stub+'/_full_house.php',"<?php function fm_is_full_house_id($id){return true;} function fm_legacy_manifest($m){return $m;} function fm_staff_session_email(){return 's@e.test';}");
 fs.copyFileSync(dir+'_tutorial_source.php',stub+'/_tutorial_source.php');
 fs.writeFileSync(stub+'/run.php',`<?php
function fm_tutorial_find_project($id,$student,$course=null){return ['course_id'=>'full-house-drawing','manifest'=>['source_project_id'=>'fullhouse_x','measurement_scope'=>'full_house']];}
require __DIR__.'/_tutorial_source.php';
`);
 const source=fs.readFileSync(stub+'/_tutorial_source.php','utf8').replace(/function fm_tutorial_bridge\(\$body\) \{/,"function fm_tutorial_bridge($body) { echo json_encode($body); return ['status'=>200,'json'=>['manifest'=>[],'files'=>[['name'=>'dsm.tif']]]];\n");
 fs.writeFileSync(stub+'/_tutorial_source.php',source);
 fs.appendFileSync(stub+'/run.php',"$b=fm_tutorial_fetch_source_bundle('tutorial_a','s@e.test','default');echo \"\\n\".$b['files'][0]['url'];");
 const run=spawnSync('php',[stub+'/run.php'],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);
 const [body,url]=run.stdout.trim().split('\n');
 assert.equal(JSON.parse(body).course_id,'full-house-drawing');assert.match(url,/course_id=full-house-drawing/);
 fs.rmSync(stub,{recursive:true,force:true});
});
