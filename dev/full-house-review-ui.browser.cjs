// Exercises the real conditional QA review controls in an isolated browser.
const {chromium}=require('../public/v1/node_modules/playwright-core');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
async function main(){
 const source=fs.readFileSync(path.join(__dirname,'../public/measure/internal/portal_scripts/qa.js'),'utf8');
 const start=source.indexOf('  const fullHouseReviewFields ='),end=source.indexOf('  function updateActionButtons(){',start);
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
  await page.setContent('<main style="font:14px Arial;width:340px;padding:20px"><div id="qaActionButtons"><button>Approve</button></div></main>');
  await page.addScriptTag({content:'let currentId="roof",currentManifest={};\n'+source.slice(start,end)+'\nwindow.fixture={render:renderFullHouseReview,payload:fullHouseReviewPayload,set:(id,revision)=>{currentId=id;currentManifest={pdf_sync:{latest_revision:revision}};renderFullHouseReview();}};'});
  const roofBefore=await page.locator('main').innerHTML();
  await page.evaluate(()=>fixture.render());
  assert.equal(await page.locator('main').innerHTML(),roofBefore,'roof DOM stays identical');
  await page.evaluate(()=>fixture.set('exteriors_'+'a'.repeat(32),'first'));
  assert.equal(await page.locator('#qaFullHouseReview input').count(),7);
  for(const box of await page.locator('#qaFullHouseReview input').all())await box.check();
  assert.equal(await page.evaluate(()=>Object.values(fixture.payload().full_house_review).every(Boolean)),true);
  await page.evaluate(()=>fixture.render());
  assert.equal(await page.locator('#qaFullHouseReview input:checked').count(),7,'refresh retains current review');
  await page.evaluate(()=>fixture.set('exteriors_'+'a'.repeat(32),'revised'));
  assert.equal(await page.locator('#qaFullHouseReview input:checked').count(),0,'new PDF revision requires fresh review');
  const out=path.join(__dirname,'../output/full-house-workflow-pdfs');fs.mkdirSync(out,{recursive:true});
  await page.screenshot({path:path.join(out,'qa-full-house.png')});
  await page.evaluate(()=>fixture.set('roof','roof-revision'));
  assert.equal(await page.locator('main').innerHTML(),roofBefore,'switching back removes full-house controls');
  console.log('QA browser checks passed: roof DOM unchanged, seven full-house checks, revision reset and return to roof.');
 }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
