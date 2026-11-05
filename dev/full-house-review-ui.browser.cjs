// Full-house QA has no checklist (FM-345): qa.js neither shows nor sends one, and
// still labels the project 'Full house'. Also exercises the full-house preview wait.
const {chromium}=require('../public/v1/node_modules/playwright-core');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
async function main(){
 const source=fs.readFileSync(path.join(__dirname,'../public/measure/internal/portal_scripts/qa.js'),'utf8');
 for(const gone of ['qaFullHouseReview','fullHouseReviewReady','fullHouseReviewPayload','firstmeasure:qa_full_house_review','full_house_review'])
  assert.ok(!source.includes(gone),`qa.js no longer has ${gone}`);
 const start=source.indexOf('  function isFullHouseReview(){'),end=source.indexOf('  function updateActionButtons(){',start);
 assert.ok(start>0&&end>start);
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:800}});
  const report=fs.readFileSync(path.join(__dirname,'../public/measure/internal/editor_scripts/report.js'),'utf8');
  const waitStart=report.indexOf("            if (window.FIRSTMEASURE_CUSTOMER_FULL_HOUSE === true) {\n                setPreviewStatus('Waiting for the full-house PDF");
  const waitEnd=report.indexOf('            const mainOutput =',waitStart);
  assert.ok(waitStart>0&&waitEnd>waitStart);
  const waitCode=report.slice(waitStart,waitEnd);
  await page.evaluate(async(code)=>{
    const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
    const wait=new AsyncFunction('generated','setPreviewStatus',code);
    window.FIRSTMEASURE_CUSTOMER_FULL_HOUSE=true;
    let complete,ready=false;
    const pending=wait({monitorPromise:new Promise(resolve=>{complete=resolve;})},()=>{}).then(()=>{ready=true;});
    await Promise.resolve();
    if(ready)throw new Error('Full-house preview became ready before synchronization');
    complete({status:'completed'});await pending;
    let failed=false;
    try{await wait({monitorPromise:Promise.resolve({status:'failed'})},()=>{});}catch{failed=true;}
    if(!failed)throw new Error('Failed synchronization should block full-house preview');
    window.FIRSTMEASURE_CUSTOMER_FULL_HOUSE=false;
    await wait({get monitorPromise(){throw new Error('Roof must not wait for synchronization');}},()=>{});
  },waitCode);
  await page.addScriptTag({content:'let currentId="exteriors_'+'a'.repeat(32)+'",currentManifest={};\n'+source.slice(start,end)+'\nwindow.fixture={fullHouse:isFullHouseReview};'});
  assert.equal(await page.evaluate(()=>fixture.fullHouse()),true,'the Full house type label still recognizes the project');
  console.log('QA browser checks passed: full-house preview waits for its PDF; QA shows no full-house checklist.');
 }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
