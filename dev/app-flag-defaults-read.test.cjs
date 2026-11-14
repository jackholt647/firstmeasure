// The console's new-organization flag defaults come from the config library through
// GET /v1/internal/admin/app-flag-defaults (FM-284); the JSON file is read only when that request fails.
// Runs the real functions from public/measure/internal/index.php under PHP with the internal API stubbed.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const SOURCE=fs.readFileSync(path.join(__dirname,'../public/measure/internal/index.php'),'utf8');
const hasPhp=spawnSync('php',['-v']).status===0;
function extract(name){
 const start=SOURCE.indexOf(`function ${name}(`);assert.ok(start>=0,`${name} is defined`);
 let depth=0,i=SOURCE.indexOf('{',start);
 for(;i<SOURCE.length;i++){if(SOURCE[i]==='{')depth++;else if(SOURCE[i]==='}'&&--depth===0)break;}
 return SOURCE.slice(start,i+1);
}
const FUNCTIONS=['portalFeatureFlagRegistry','portalFeatureFlagDefaults','portalFeatureFlagNormalizeFlags','portalFeatureFlagReadJson','portalFeatureFlagDefaultConfigPath','portalFeatureFlagReadDefaultRecord','portalFeatureFlagDefaultRecordFromStored','portalFeatureFlagReadDefaultRecordViaInternalApi'];
function run(response,file){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fm-284-'));
 if(file){fs.mkdirSync(path.join(root,'config'));fs.writeFileSync(path.join(root,'config/app_flag_defaults.json'),JSON.stringify(file));}
 const script=`<?php
$GLOBALS['calls']=[];
function portalPlatformStorageRoot(){return ${JSON.stringify(root)};}
function portalNodeInternalRequest($method,$path,$body=null){$GLOBALS['calls'][]=$method.' '.$path;return json_decode(${JSON.stringify(JSON.stringify(response))},true);}
${FUNCTIONS.map(extract).join('\n')}
echo json_encode(['record'=>portalFeatureFlagReadDefaultRecord(),'calls'=>$GLOBALS['calls']]);`;
 const out=spawnSync('php',['-d','display_errors=stderr'],{input:script,encoding:'utf8'});
 fs.rmSync(root,{recursive:true,force:true});
 assert.equal(out.status,0,out.stderr);
 return JSON.parse(out.stdout);
}
const LIBRARY={ok:true,status:200,json:{ok:true,success:true,defaults:{schema_version:1,id:'app_flag_defaults',data:{app_flags:{firstmeasure:{instant_reports:true}}},revision:3,updated_at:'2026-10-28T08:00:00.000Z',updated_by:'ops@example.com'}},body:'',error:''};
const MIRROR={schema_version:1,id:'app_flag_defaults',data:{app_flags:{firstmeasure:{referral_program_banner:true}}},updated_at:'2026-10-01T00:00:00Z',updated_by:'old@example.com'};
test('new user defaults are read from the config library through the internal API, not the file',{skip:!hasPhp&&'php is not installed'},()=>{
 const {record,calls}=run(LIBRARY,MIRROR);
 assert.deepEqual(calls,['GET admin/app-flag-defaults']);
 assert.equal(record.id,'app_flag_defaults');assert.equal(record.source,'config_library');assert.equal(record.saved,true);
 assert.equal(record.flags.firstmeasure.instant_reports,true);assert.equal(record.flags.firstmeasure.referral_program_banner,false);
 assert.equal(record.updated_at,'2026-10-28T08:00:00.000Z');assert.equal(record.updated_by,'ops@example.com');
});
test('a library entry that was never saved reads as unsaved code defaults',{skip:!hasPhp&&'php is not installed'},()=>{
 const empty={...LIBRARY,json:{ok:true,defaults:{schema_version:1,id:'app_flag_defaults',data:{app_flags:{}},revision:0,updated_at:'',updated_by:''}}};
 const {record}=run(empty,MIRROR);
 assert.equal(record.source,'config_library');assert.equal(record.saved,false);assert.equal(record.flags.firstmeasure.referral_program_banner,false);
});
test('when the internal API fails the mirrored file is read and the failure is reported',{skip:!hasPhp&&'php is not installed'},()=>{
 const {record}=run({ok:false,status:503,json:{error:'unavailable'},body:'',error:''},MIRROR);
 assert.equal(record.source,'file');assert.equal(record.saved,true);assert.match(record.source_error,/503.*unavailable/);
 assert.equal(record.flags.firstmeasure.referral_program_banner,true);assert.equal(record.updated_by,'old@example.com');
 const none=run({ok:false,status:0,json:null,body:'',error:'connect failed'},null).record;
 assert.equal(none.source,'file');assert.equal(none.saved,false);assert.match(none.source_error,/connect failed/);
});
