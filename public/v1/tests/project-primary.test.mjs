import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source=readFileSync('../libraries/platform-api/platform-api.js','utf8');
const context=vm.createContext({window:{__APP:{platformApiBase:'/v1/platform'}},location:{hostname:'localhost',href:'http://localhost/'},URL,URLSearchParams,console});
vm.runInContext(source,context);
const library=context.window.PlatformAPI.projectMedia;
const options={orgId:'org',firstMeasureUrlBuilder:path=>'/v1/firstmeasure/'+path};
const project={id:'project',measurement_project_id:'roof',photos:[{id:'front',media_id:'front',src:'/front.jpg',thumb:'/front-thumb.jpg',media_type:'image'},{id:'video',media_id:'video',media_type:'video'}]};

test('primary defaults to satellite and ignores stale thumbnail aliases after clearing',()=>{
  const base={...project,thumbnail_photo_id:'front',thumbnail_photo:project.photos[0]};
  assert.equal(library.primaryPhoto(base,options).id,'top_down_thumbnail');
  const covered={...base,custom_field_values:{cover_photo:{media_id:'front'}}};
  assert.equal(library.hydrateProjectPhotos(covered,options).thumbnail_photo_id,'front');
  const cleared={...covered,custom_field_values:{cover_photo:null}};
  assert.equal(library.hydrateProjectPhotos(cleared,options).thumbnail_photo_id,'top_down_thumbnail');
  assert.equal(library.hydrateProjectPhotos(covered,options).photos.filter(p=>p.is_top_down_thumbnail).length,1);
});
test('primary resolves unloaded media references and falls back for video or trashed selections',()=>{
  const cover=id=>({...project,custom_field_values:{cover_photo:{media_id:id}}});
  assert.match(library.primaryPhoto(cover('unloaded'),options).thumb,/media\/unloaded\/file.*thumb_320/);
  assert.equal(library.primaryPhoto(cover('video'),options).id,'top_down_thumbnail');
  assert.equal(library.primaryPhoto({...cover('front'),photos:[{...project.photos[0],in_trash:true}]},options).id,'top_down_thumbnail');
});
test('project viewer candidates prefer cover and restore satellite even with stale cached URLs',()=>{
  const viewer=readFileSync('../libraries/apps/projects/viewer.js','utf8');
  const fn=viewer.slice(viewer.indexOf('  function preferredThumbnailUrls('),viewer.indexOf('  function normalizeProjectRecord(',viewer.indexOf('  function preferredThumbnailUrls(')));
  Object.assign(context,{firstMeasureProjectId:p=>p.measurement_project_id,buildThumbnailUrl:(id,file)=>`/satellite/${id}/${file}`,buildArtifactUrl:(id,file)=>`/artifact/${id}/${file}`,isQuadThumbnailUrl:()=>false,dedupeUrls:urls=>[...new Set(urls)],googleStaticMapThumbnailUrl:()=>'/static-satellite'});
  context.window.__APP.userOrgId='org';vm.runInContext(fn,context);
  context.p={...project,custom_fields:{cover_photo:{media_id:'front'}}};
  assert.equal(vm.runInContext('preferredThumbnailUrls(p)[0]',context),'/front-thumb.jpg');
  context.p={...project,custom_fields:{cover_photo:null},thumbnail:'/front.jpg',thumbnail_photo:project.photos[0]};
  const urls=vm.runInContext('preferredThumbnailUrls(p)',context);
  assert.match(urls[0],/^\/satellite\//);assert.ok(!urls.includes('/front.jpg'));
});
test('public portal primary uses only already shared images and keeps the satellite separate',()=>{
  const api=readFileSync('platform/api.ts','utf8');
  const start=api.indexOf('function publicProjectView('),end=api.indexOf('function projectScheduleEventType(',start);
  Object.assign(context,{cleanText:v=>String(v??'').trim(),asObject:v=>v&&typeof v==='object'?v:{},projectPrimaryContact:()=>({}),projectDisplayTitle:()=>'',portalDisplayName:()=>'',publicProjectTopDownThumbnail:()=>({id:'satellite',src:'/satellite'})});
  vm.runInContext(ts.transpileModule(api.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  context.p={custom_field_values:{cover_photo:{media_id:'private'}}};context.shared=[{media_id:'shared',kind:'image',src:'/public/shared'}];
  assert.equal(vm.runInContext('publicProjectView(p,"",shared).thumbnail_photo.id',context),'satellite');
  context.p.custom_field_values.cover_photo.media_id='shared';
  assert.equal(vm.runInContext('publicProjectView(p,"",shared).thumbnail_photo.src',context),'/public/shared');
  assert.equal(vm.runInContext('publicProjectView(p,"",shared).top_down_thumbnail.id',context),'satellite');
  context.shared[0].kind='video';
  assert.equal(vm.runInContext('publicProjectView(p,"",shared).thumbnail_photo.id',context),'satellite');
});
test('a project with blank coordinates gets no satellite map of 0,0, and a stale one saved for it is dropped (FM-422)',()=>{
  const keyed={orgId:'org',googleMapsApiKey:'k'};
  assert.equal(library.googleStaticMapPhoto({lat:'',lng:'',pins:[],address:''},keyed),null);
  assert.equal(library.googleStaticMapPhoto({lat:0,lng:0},keyed),null);
  assert.match(library.googleStaticMapPhoto({lat:'',lng:'',address:'1 Main St, Austin, TX'},keyed).src,/center=1\+Main/);
  assert.match(library.googleStaticMapPhoto({lat:'30.26',lng:'-97.74'},keyed).src,/center=30\.26%2C-97\.74/);
  const stale={id:'top_down_thumbnail',kind:'external_image',source:'google_static_map',designator:'top_down_thumbnail',is_top_down_thumbnail:true,src:'https://maps.googleapis.com/maps/api/staticmap?center=0%2C0'};
  const own={id:'m1',media_id:'m1',src:'/m1.jpg',media_type:'image'};
  const blank={lat:'',lng:'',address:'',photos:[stale,own],thumbnail_photo_id:'top_down_thumbnail'};
  assert.deepEqual(Array.from(library.withFirstMeasureTopDown(blank,{orgId:'org'}),p=>p.id),['m1']);
  assert.equal(library.primaryPhoto(blank,{orgId:'org'}).id,'m1');
  assert.equal(library.withFirstMeasureTopDown({...blank,address:'1 Main St'},{orgId:'org'}).length,2,'with a location the saved map stays');
});
