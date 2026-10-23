const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {submissionUploads}=require('../public/measure/internal/editor_scripts/project_resources.js');
// Sources & Notes (report configuration) lists the tech's own uploads, never frames saved from videos.
test('Sources & Notes takes tech uploads and leaves out saved video frames and other derived files',()=>{
 const upload={name:'internal-resource-v2-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-street.png',original_name:'Street view.png',role:'tech'};
 const legacyUpload={name:'internal-resource-1700000000-site.jpg',original_name:'Site.jpg'};
 const frame={name:'internal-resource-v2-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-walk-frame-3.20s.png',original_name:'walk frame 0:03.png',role:'tech',source_video:{name:'internal-resource-v2-cccccccc-cccc-cccc-cccc-cccccccccccc-walk.mp4',time:3.2}};
 const olderFrame={name:'internal-resource-v2-dddddddd-dddd-dddd-dddd-dddddddddddd-walk-frame-9.00s.png',original_name:'Front door.png',role:'tech'};
 const generated={name:'internal-resource-v2-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee-ai.png',role:'tech',generated:true};
 const customer={name:'internal-resource-v2-ffffffff-ffff-ffff-ffff-ffffffffffff-photo.jpg',role:'customer'};
 const records=[{version:1,label:'Front door',frame:olderFrame.name,source:'internal-resource-v2-cccccccc-cccc-cccc-cccc-cccccccccccc-walk.mp4',time:9}];
 const files=[upload,legacyUpload,frame,olderFrame,generated,customer,{name:'internal-markup-favorite-1.json'}];
 const {uploads,derived}=submissionUploads(files,records);
 assert.deepEqual(uploads.map(f=>f.name),[upload.name,legacyUpload.name]);
 for(const f of [frame,olderFrame,generated])assert.ok(derived.has(f.name),f.name+' is derived');
 assert.ok(!derived.has(upload.name));
});
test('the Resources file list carries the frame marker the server writes, and the merge drops frames merged before',()=>{
 const php=fs.readFileSync('public/measure/internal/project_resources.php','latin1'),frames=fs.readFileSync('public/measure/internal/_resource_frames.php','utf8');
 assert.match(frames,/'source_video' => \['name' => \$job\['source'\]/,'frame jobs record the source video');
 assert.match(php,/\['original_name', 'uploaded_at', 'role', 'elevation_view', 'source', 'source_video'\] as \$field/,'the listing passes source_video to the browser');
 const js=fs.readFileSync('public/measure/internal/editor_scripts/project_resources.js','utf8'),merge=js.slice(js.indexOf('async mergeSubmission'));
 assert.match(merge,/submissionUploads\(/);assert.match(merge,/derived\.has\(i\.resource_name\)/,'frames merged by earlier versions are removed');assert.match(merge,/markup\?\.sourceVideo/,'captures marked with their video are left out');
});
