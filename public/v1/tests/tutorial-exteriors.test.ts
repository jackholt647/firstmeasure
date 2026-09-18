import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';

test('exterior curriculum defaults, isolated PHP editing/resources, completion and access boundaries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fm-training-exterior-'));
  const secret = 'isolated-training-test-secret';
  Object.assign(process.env, { V1_LOG_LEVEL:'silent', FIRSTMATE_ENV:'test', FIRSTMEASURE_DATABASE_MODE:'sqlite', FIRSTMEASURE_STORAGE_ROOT:path.join(root,'projects'),
    FIRSTMEASURE_INDEX_DB_PATH:path.join(root,'index.sqlite'), INTERNAL_STORAGE_ROOT:path.join(root,'internal'), PLATFORM_STORAGE_ROOT:path.join(root,'platform'),
    CRM_STORAGE_ROOT:path.join(root,'crm'), MEASURE_INTERNAL_TUTORIALS_ROOT:path.join(root,'tutorials'), FIRSTMEASURE_JOB_WORKERS:'0', PLATFORM_HEARTBEAT_DISABLED:'1',
    FIRSTMEASURE_FULL_HOUSE_ENABLED:'1', FIRSTMEASURE_FULL_HOUSE_EMAILS:'manager@example.test', FIRSTMEASURE_INTERNAL_API_SECRET:secret });
  const {buildApp} = await import('../src/app.js');
  const {saveInternalUser} = await import('../internal/storage.js');
  const storage = await import('../firstmeasure/storage.js');
  const {exteriorTrainingCapability} = await import('../internal/tutorial_exteriors.js');
  await saveInternalUser({email:'manager@example.test',role:'admin',status:'active'});
  await saveInternalUser({email:'student@example.test',role:'trainee',status:'active'});
  await saveInternalUser({email:'other@example.test',role:'trainee',status:'active'});
  const source = 'fullhouse_' + 'a'.repeat(32), incomplete = 'fullhouse_' + 'b'.repeat(32);
  for (const id of [source,incomplete]) {
    await storage.createProject({id,address:'Synthetic training house',measurement_scope:'full_house'}, {fullHouse:true});
    await storage.saveArtifact(id,'google.png','synthetic image'); await storage.saveArtifact(id,'dsm.tif','synthetic height');
  }
  await storage.saveAppMetadata(source,{geometry:{points:[{id:'answer-point'}]},exteriorsWalls:{answer:'not copied'}});
  const referenceNames:string[]=[];
  for (const [i,side] of ['front','back','left','right'].entries()) {
    const id = `12345678-1234-4234-8234-${String(i).padStart(12,'0')}`;
    const part = `internal-markup-part-${id}-00000000.bin`, name = `internal-resource-v2-${id}-${side}.jpg`;
    await storage.saveArtifact(source,part,'photo');
    await storage.saveArtifact(source,name,JSON.stringify({format:'firstmeasure-resource-chunks-v1',id,size:5,chunkSize:8*1024*1024,parts:1,elevation_view:side,role:'customer',original_name:side+'.jpg'}));
    referenceNames.push(name);
  }
  assert.equal((await exteriorTrainingCapability(source)).available,true);
  assert.deepEqual((await exteriorTrainingCapability(incomplete)).missing,['front','back','left','right']);
  const curriculumFile=path.join(root,'tutorials/master/curriculum.json');await mkdir(path.dirname(curriculumFile),{recursive:true});
  const entries=[{project_id:source,curriculum_project_id:'auto'}, {project_id:source,curriculum_project_id:'roof',measurement_scope:'roof'}, {project_id:incomplete,curriculum_project_id:'missing'}];
  await writeFile(curriculumFile,JSON.stringify({chapters:[{projects:entries}]}));
  const app=await buildApp(); await app.listen({host:'127.0.0.1',port:0});
  const nodePort=(app.server.address() as {port:number}).port;
  const signed=(body:object,email='student@example.test') => {
    const time=String(Math.floor(Date.now()/1000));
    return app.inject({method:'POST',url:'/v1/internal/tutorial-exteriors',payload:body,headers:{'x-tutorial-user':email,'x-tutorial-time':time,'x-tutorial-signature':createHmac('sha256',secret).update(`${email}\n${time}\n${JSON.stringify(body)}`).digest('hex')}});
  };
  let php: ReturnType<typeof spawn> | undefined;
  try {
    assert.equal((await app.inject({method:'POST',url:'/v1/internal/tutorial-exteriors',payload:{operation:'list',actor:{role:'admin'}}})).statusCode,403);
    assert.equal((await signed({operation:'capability',source})).statusCode,403);
    assert.equal((await signed({operation:'capability',source},'manager@example.test')).json().capability.available,true);
    const start=async (entry:string,src=source) => {
      const response=await signed({operation:'start',source:src,chapter_id:1,curriculum_project_id:entry});
      assert.equal(response.statusCode,200,response.body);return response.json().tutorial_id as string;
    };
    const exterior=await start('auto'), roof=await start('roof'), missing=await start('missing',incomplete);
    const dir=(id:string)=>path.join(root,'tutorials/users/student@example.test/courses/default/projects',id);
    const manifest=async(id:string)=>JSON.parse(await readFile(path.join(dir(id),'manifest.json'),'utf8'));
    assert.equal((await manifest(exterior)).measurement_scope,'full_house');
    assert.equal((await manifest(exterior)).tutorial_grading_enabled,false);
    assert.equal((await manifest(roof)).measurement_scope,'roof');
    assert.equal((await manifest(missing)).measurement_scope,'roof');
    assert.equal((await signed({operation:'start',source,chapter_id:2})).statusCode,403);
    assert.equal((await signed({operation:'source',tutorial_id:exterior,student_email:'student@example.test',name:'google.png'},'other@example.test')).statusCode,403);
    assert.equal((await signed({operation:'source',tutorial_id:exterior,name:'app_metadata.json'})).statusCode,403);
    assert.equal((await signed({operation:'source',tutorial_id:exterior,name:'google.png'})).body,'synthetic image');
    assert.equal((await app.inject({url:`/v1/firstmeasure/projects/${source}/editor`})).statusCode,404,'source remains private outside training');
    entries[2]!.measurement_scope='full_house';await writeFile(curriculumFile,JSON.stringify({chapters:[{projects:entries}]}));
    assert.equal((await signed({operation:'start',source:incomplete,chapter_id:1,curriculum_project_id:'missing'})).statusCode,409,'explicit exterior selection cannot silently lose scope');

    const reservation=createServer();await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));const phpPort=(reservation.address() as {port:number}).port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
    const internal=path.resolve('../measure/internal').replace(/\\/g,'/');
    const router=path.join(root,'router.php');
    await writeFile(router,`<?php session_save_path(${JSON.stringify(root.replace(/\\/g,'/'))}); session_id('training-test'); session_start(); $_SESSION=['user_email'=>($_SERVER['HTTP_X_TEST_USER'] ?? 'student@example.test')]; session_write_close(); $file=basename(parse_url($_SERVER['REQUEST_URI'],PHP_URL_PATH)); if(!in_array($file,['tutorial_sources.php','editor.php','project_resources.php'])){http_response_code(404);exit;} require ${JSON.stringify(internal)}.'/'.$file;`);
    const binary=spawnSync('php',['-r','echo PHP_BINARY;'],{encoding:'utf8'}).stdout.trim();assert.ok(binary,'PHP is required for this integration test');
    const extensions=process.platform==='win32'?['-d',`extension_dir=${path.join(path.dirname(binary),'ext')}`,'-d','extension=curl']:[];
    php=spawn(binary,[...extensions,'-S',`127.0.0.1:${phpPort}`,router],{env:{...process.env,FIRSTMEASURE_API_BASE:`http://127.0.0.1:${nodePort}/v1/firstmeasure`,FIRSTMEASURE_FULL_HOUSE_SIGNING_SECRET:secret},stdio:'ignore'});
    const base=`http://127.0.0.1:${phpPort}`;
    for(let tries=0;;tries++){try{await fetch(base);break;}catch{if(tries===50)throw Error('PHP failed to start');await new Promise(r=>setTimeout(r,50));}}
    const bridge=await fetch(base+'/tutorial_sources.php',{method:'POST',headers:{'Content-Type':'application/json','X-Tutorial-Request':'1','X-Test-User':'manager@example.test'},body:JSON.stringify({operation:'capability',source})});
    assert.equal(bridge.status,200,await bridge.clone().text());assert.equal((await bridge.json()).capability.available,true,'real PHP signing matches Node');
    const editor=await(await fetch(base+`/editor.php?tutorial=1&folder=${exterior}`)).text();
    assert.ok(editor.includes('editor_scripts/wall_mode.js'),'training loads wall modules');
    const roofEditor=await(await fetch(base+`/editor.php?tutorial=1&folder=${roof}`)).text();assert.ok(!roofEditor.includes('editor_scripts/wall_mode.js'));
    const bundle=await(await fetch(base+`/editor.php?action=tutorial_project_bundle&tutorial_id=${exterior}`)).json();
    assert.equal(bundle.app_metadata.geometry,null);assert.equal(bundle.app_metadata.exteriorsWalls,undefined,'answer walls do not leak into starter');
    assert.ok(bundle.assets.google.includes('tutorial_sources.php'));
    const patched=await(await fetch(base+`/editor.php?action=tutorial_project_patch&tutorial_id=${exterior}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_project_id:incomplete,original_master_id:incomplete,measurement_scope:'roof',tutorial_grading_enabled:true,owner_email:'other@example.test'})})).json();
    assert.equal(patched.success,true);assert.equal((await manifest(exterior)).source_project_id,source);assert.equal((await manifest(exterior)).measurement_scope,'full_house');
    assert.equal((await manifest(exterior)).owner_email,'student@example.test','editor patches cannot retarget source access');
    const resources=base+`/project_resources.php?project=${exterior}`;
    const listing=await(await fetch(resources)).json();assert.equal(listing.files.length,4);
    assert.equal(await(await fetch(resources+'&name='+referenceNames[0])).text(),'photo');
    assert.equal((await fetch(resources+'&name='+referenceNames[0],{method:'POST',headers:{'X-Resource-Request':'1'},body:(await storage.readArtifact(source,referenceNames[0]!)).content.toString('utf8')})).status,403);
    assert.equal((await fetch(resources+'&name=internal-resource-student.jpg',{method:'POST',headers:{'X-Resource-Request':'1'},body:'student photo'})).status,200);
    assert.equal((await storage.listProjectFiles(source)).some(f=>f.name==='internal-resource-student.jpg'),false);
    const saved={geometry:{points:[]},exteriorsWalls:{version:1,walls:[{id:'student-wall'}]},exteriorsRoofTrim:{student:true},exteriorsView:{enabled:true}};
    const save=await fetch(base+`/editor.php?action=tutorial_project_save&tutorial_id=${exterior}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({metadata:saved,pdf_state:{exteriorReport:{walls:[{id:'student-wall'}]}}})});
    assert.equal((await save.json()).success,true);
    const reopened=await(await fetch(base+`/editor.php?action=tutorial_project_bundle&tutorial_id=${exterior}`)).json();assert.deepEqual(reopened.app_metadata.exteriorsWalls,saved.exteriorsWalls);
    const complete=await(await fetch(base+`/editor.php?action=tutorial_project_status&tutorial_id=${exterior}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"status":"completed"}'})).json();
    assert.equal(complete.success,true);assert.equal(complete.score_status,'not_graded');assert.equal(complete.score,null);
    assert.equal((await manifest(exterior)).status,'tutorial_completed');
    const teacherBundle=await(await fetch(base+`/editor.php?action=tutorial_project_bundle&tutorial_id=${exterior}&student_email=student@example.test`,{headers:{'X-Test-User':'manager@example.test'}})).json();
    assert.deepEqual(teacherBundle.app_metadata.exteriorsWalls,saved.exteriorsWalls,'instructors can review saved exterior work');
    assert.deepEqual((await storage.getProjectDetail(source)).app_metadata,{geometry:{points:[{id:'answer-point'}]},exteriorsWalls:{answer:'not copied'}});
    assert.equal((await fetch(resources,{headers:{'X-Test-User':'other@example.test'}})).status,404);
    process.env.FIRSTMEASURE_FULL_HOUSE_ENABLED='0';
    assert.equal((await signed({operation:'source',tutorial_id:exterior,name:'google.png'})).statusCode,403);
  } finally { php?.kill(); await app.close(); }
});
