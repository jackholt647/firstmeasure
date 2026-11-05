// Embedded QA: a full-house PDF page has no full-house checklist (FM-345) and
// approves exactly like a roof page; approval waits for PDF renders in flight
// and names the newest revision the review produced. Runs the real
// report.js and qa.js code in an isolated browser (parent portal + editor iframe).
const {chromium}=require('../public/v1/node_modules/playwright-core');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'../public/measure/internal');
function slice(source,from,to,label){
 const start=source.indexOf(from),end=source.indexOf(to,start+from.length);
 assert.ok(start>=0&&end>start,`${label}: markers not found`);
 return source.slice(start,end);
}
function sliceFunction(source,name){
 const start=source.indexOf(`function ${name}(`);
 assert.ok(start>=0,`${name} not found`);
 const end=source.indexOf('\n}\n',start);
 return source.slice(start,end+3);
}
async function main(){
 const report=fs.readFileSync(path.join(root,'editor_scripts/report.js'),'utf8');
 const qa=fs.readFileSync(path.join(root,'portal_scripts/qa.js'),'utf8');
 const editorCode=[
  slice(report,'const QA_PDF_REVIEW_ITEMS = [','function resolveQaSubmissionSourceUrl(','review page'),
  sliceFunction(report,'postQaPdfDecision'),
  sliceFunction(report,'getQaPdfDecisionType'),
  sliceFunction(report,'setupQaPdfReviewControls'),
  sliceFunction(report,'escapeHtml')
 ].join('\n');
 const portalHandler=slice(qa,"      if (data.type === 'firstmeasure:qa_decision_request') {","      if (data.type !== 'firstmeasure:qa_threads_updated') return;",'qa handler');
 const portalSettle=slice(qa,'  let qaPdfRendersInFlight = 0;','  async function renderQaPdfPreviewNow(options){','qa settle');
 for(const [label,text] of [['QA',qa.slice(qa.indexOf('async function submitDecision('),qa.indexOf('async function verifyQaDecisionPersisted('))],['manager',qa.slice(qa.indexOf('async function submitManagerDecision('),qa.indexOf('// ----------------- SPLITTER'))]]){
  assert.doesNotMatch(text,/fullHouseReview|full_house_review/,`${label} decision neither gates on nor sends a full-house checklist`);
  assert.match(text,/settleQaReviewedPdfSync\(reviewedPdfSync\)/,`${label} approval settles the PDF revision`);
 }
 for(const gone of ['qaPdfFullHouseReview','QA_FULL_HOUSE_REVIEW_ITEMS','firstmeasure:qa_full_house_review','full_house_review'])
  assert.ok(!report.includes(gone),`report.js no longer has ${gone}`);

 const folder='exteriors_'+'b'.repeat(32);
 const editorHtml=(fullHouse)=>`<!doctype html><body><div id="page"></div><script>
  window.FIRSTMEASURE_CUSTOMER_FULL_HOUSE=${fullHouse};window.currentProjectId=${JSON.stringify(fullHouse?folder:'roofproject')};
  let reportConfigState=null;
  const blockReportFacetOverlapsForSubmission=()=>false,blockUnrealisticReportGeometryForSubmission=()=>false,addQaPdfReviewFailuresToThreads=async()=>[];
  window.DrafterQA={getThreads:()=>[]};
  ${editorCode}
  const state={folderId:window.currentProjectId};
  document.getElementById('page').innerHTML=renderQaPdfReviewHtml(state);
  setupQaPdfReviewControls(document.getElementById('page'),state,true);
  window.fixture={track:firstMeasureTrackPdfPreview};
 </script></body>`;
 const portalHtml=`<!doctype html><body><main id="qaInspectorActions" style="display:none"><div id="qaActionButtons"><button>Approve</button></div></main>
 <iframe id="qaEmbeddedEditorFrame" src="/editor-fullhouse" style="width:900px;height:500px"></iframe><script>
  let currentId=${JSON.stringify(folder)},currentManifest={measurement_scope:'full_house',pdf_sync:{latest_revision:'r1'}};
  let qaThreads=[],isManagerReviewMode=false,qaPdfPersistActive=false,qaPdfPreviewTimer=null,qaPdfLastSyncJobId='',qaPdfLastSyncRevision='';
  const mergeThreadDrafts=(a,b)=>b,renderChecklist=()=>{},updateActionButtons=()=>{},sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const getActiveQaEditorFrame=()=>document.getElementById('qaEmbeddedEditorFrame');
  const Portal={fmUrl:(p)=>'/v1/firstmeasure/'+p};
  window.alerts=[];window.alert=(m)=>window.alerts.push(m);window.decisions=[];window.messages=[];
  function submitDecision(status,sync){window.decisions.push({kind:'qa',status,sync});}
  function submitManagerDecision(status,sync){window.decisions.push({kind:'manager',status,sync});}
  ${portalSettle}
  async function renderQaPdfPreviewNow(){}
  const handle=new Function('data',${JSON.stringify(portalHandler)});
  window.addEventListener('message',(event)=>{const data=event.data||{};window.messages.push(data);handle(data);});
  window.fixture={settle:settleQaReviewedPdfSync,
   setOwn:(j,r)=>{qaPdfLastSyncJobId=j;qaPdfLastSyncRevision=r;},setManager:(on)=>{isManagerReviewMode=on;},setRender:(n)=>{qaPdfRendersInFlight=n;}};
 </script></body>`;

 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1000,height:700}});
  let latest={latest_job_id:'job2',latest_revision:'r2'};
  await page.route('http://fixture.test/**',async(route)=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/portal')return route.fulfill({contentType:'text/html',body:portalHtml});
   if(url.pathname==='/editor-fullhouse')return route.fulfill({contentType:'text/html',body:editorHtml(true)});
   if(url.pathname==='/editor-roof')return route.fulfill({contentType:'text/html',body:editorHtml(false)});
   if(url.pathname.startsWith('/v1/firstmeasure/projects/'))return route.fulfill({contentType:'application/json',body:JSON.stringify({project:{manifest:{pdf_sync:latest}}})});
   return route.fulfill({status:404,body:''});
  });
  await page.goto('http://fixture.test/portal');
  const editor=page.frameLocator('#qaEmbeddedEditorFrame');
  const frame=()=>page.frames().find(f=>f.url().endsWith('/editor-fullhouse'));
  await editor.locator('#qaPdfApproveBtn').waitFor();

  // The PDF page shows only the roof checks: no full-house checklist, and approval
  // is enabled once they pass, as on a roof report.
  assert.equal(await editor.locator('#qaPdfFullHouseReview, #qaPdfReviewPanel fieldset, #qaPdfReviewPanel input[type=checkbox]').count(),0);
  assert.doesNotMatch(await editor.locator('#qaPdfReviewPanel').innerText(),/Full-house review/i);
  assert.equal(await editor.locator('#qaPdfApproveBtn').isDisabled(),true,'approve waits for the roof checks');
  for(const pass of await editor.locator('.qa-pdf-mark.pass').all())await pass.click();
  assert.equal(await editor.locator('#qaPdfApproveBtn').isDisabled(),false);
  const out=path.join(__dirname,'../output/full-house-workflow-pdfs');fs.mkdirSync(out,{recursive:true});
  await page.screenshot({path:path.join(out,'qa-embedded-full-house.png')});

  // Approve while a preview render is in flight: the decision waits and names the newer revision.
  await frame().evaluate(()=>{window.finishRender=fixture.track();window.__lastFirstMeasureReviewedPdfSync=null;window.__lastFirstMeasurePdfSync={jobId:'job1',revision:'r1'};});
  await editor.locator('#qaPdfApproveBtn').click();
  await editor.locator('#qaPdfApproveBtn',{hasText:'Waiting for the PDF'}).waitFor();
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>decisions.length),0,'no decision while the PDF is rendering');
  await frame().evaluate(()=>{window.__lastFirstMeasureReviewedPdfSync={jobId:'job2',revision:'r2'};window.finishRender();});
  await page.waitForFunction(()=>decisions.length===1);
  const qaDecision=await page.evaluate(()=>decisions[0]);
  assert.equal(qaDecision.kind,'qa');assert.equal(qaDecision.status,'approved');
  assert.deepEqual(qaDecision.sync,{jobId:'job2',revision:'r2'});
  assert.ok(!(await page.evaluate(()=>messages.some(m=>'full_house_review' in m||m.type==='firstmeasure:qa_full_house_review'))),'the editor sends no full-house checklist');

  // Manager sign-off uses the same page.
  await page.evaluate(()=>fixture.setManager(true));
  await editor.locator('#qaPdfApproveBtn').click();
  await page.waitForFunction(()=>decisions.length===2);
  const managerDecision=await page.evaluate(()=>decisions[1]);
  assert.equal(managerDecision.kind,'manager');
  assert.equal(managerDecision.status,'approved');

  // Approval settles: waits for the inspector's render, adopts a newer revision this review made, ignores others.
  assert.deepEqual(await page.evaluate(()=>fixture.settle({jobId:'job2',revision:'r2'})),{jobId:'job2',revision:'r2'});
  latest={latest_job_id:'job3',latest_revision:'r3'};
  assert.deepEqual(await page.evaluate(()=>fixture.settle({jobId:'job2',revision:'r2'})),{jobId:'job2',revision:'r2'},'unknown revision is not adopted');
  await page.evaluate(()=>{fixture.setOwn('job3','r3');fixture.setRender(1);window.settled=null;fixture.settle({jobId:'job2',revision:'r2'}).then(v=>{window.settled=v;});});
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(()=>window.settled),null,'waits for the inspector render');
  await page.evaluate(()=>fixture.setRender(0));
  await page.waitForFunction(()=>window.settled);
  assert.deepEqual(await page.evaluate(()=>window.settled),{jobId:'job3',revision:'r3'},'adopts the newest revision this review synchronized');

  // A roof project's PDF page is unchanged.
  await page.evaluate(()=>{document.getElementById('qaEmbeddedEditorFrame').src='/editor-roof';});
  const roof=page.frameLocator('#qaEmbeddedEditorFrame');
  await roof.locator('#qaPdfApproveBtn').waitFor();
  assert.equal(await roof.locator('#qaPdfFullHouseReview').count(),0);
  for(const pass of await roof.locator('.qa-pdf-mark.pass').all())await pass.click();
  assert.equal(await roof.locator('#qaPdfApproveBtn').isDisabled(),false);
  console.log('Embedded QA checks passed: the full-house PDF page has no checklist and reaches the QA and manager decisions; approval waits for renders and adopts this review\'s newest revision; roof page unchanged.');
 }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
