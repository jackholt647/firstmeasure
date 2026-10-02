import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('only residential offers full structure; scope help stays over the map and leaves both choices clickable',async()=>{
 const source=await readFile(new URL('../../libraries/apps/project-request/app.js',import.meta.url),'utf8');
 const help=source.slice(source.indexOf('  function addonInfoPopout(){'),source.indexOf('  function closeAddonInfoModal(){'));
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent(`<style>body{margin:0}#rMapWrap{position:relative;margin:40px;width:1080px;height:700px;display:flex}.r-overview-details{width:400px;flex:none}#rMap{margin-top:30px;width:680px;height:600px;background:#ddd}.r-addon-info-popout{position:absolute;display:none;padding:16px;background:white;z-index:34}.r-addon-info-popout.visible{display:block}.ext-choice-wrap{display:inline-block}.ext-choice{height:70px;width:155px}.ext-choice-info{width:30px;height:30px}</style><div id="rOverlay"><div id="rMapWrap"><div class="r-overview-details"><div id="rStepType"></div></div><div id="rMap"></div><div class="r-addon-info-popout" id="rAddonInfoPopout"></div></div></div>`);
  await page.addScriptTag({content:`let addonInfoHideTimer;const isMobileProjectOrder=()=>false,reportAddonInfoHtml=key=>'<h4>'+key+'</h4><p>Report information</p><a href="#sample">Sample</a>',closeAddonInfoModal=()=>{};${help}
    window.PlatformCommerce={credit:n=>String(n)};window.Portal={cfg:{},capabilities:{value:()=>true},util:{escapeHtml:s=>s,injectCSS(){},postAction:async()=>({data:{success:true,base_price:30,options:[{key:'exteriors_standard',amount:30}]}})}};`});
  await page.addScriptTag({path:new URL('../../libraries/apps/firstmeasure/order/exteriors.js',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')});
  await page.evaluate(()=>{window.context={type:'residential',count:1,pins:[],ordered:false,orderWorkflow:true,addressSelected:true,refresh:()=>Portal.ExteriorOrder.sync(context),hoverInfo:showAddonInfoPopout,hideInfo:()=>hideAddonInfoPopout(),showInfo:()=>{}};Portal.ExteriorOrder.sync(context);});
  for(const key of ['roof','full_house']){
   await page.locator(`[data-scope="${key}"]`).hover();assert.equal(await page.locator('#rAddonInfoPopout').isVisible(),false);
   await page.locator(`[data-details="${key}"].ext-choice-info`).hover();assert.equal(await page.locator('#rAddonInfoPopout').isVisible(),true);
   const pop=await page.locator('#rAddonInfoPopout').boundingBox(),map=await page.locator('#rMap').boundingBox();assert.ok(pop.x>=map.x&&pop.x+pop.width<=map.x+map.width);
   await page.locator(`[data-scope="${key}"]`).click();assert.equal(await page.evaluate(()=>Portal.ExteriorOrder.selectedScope('residential')),key);
  }
  for(const type of ['commercial','multifamily']){
   await page.evaluate(type=>{context.type=type;Portal.ExteriorOrder.sync(context);},type);
   assert.equal(await page.locator('#rExteriorOrder').isVisible(),false);
   assert.deepEqual(await page.evaluate(type=>({choice:Portal.ExteriorOrder.needsChoice(),active:Portal.ExteriorOrder.active(),scope:Portal.ExteriorOrder.selectedScope(type),payload:Portal.ExteriorOrder.payload()}),type),{choice:false,active:false,scope:'roof',payload:{}});
  }
  await page.evaluate(()=>{context.type='residential';Portal.ExteriorOrder.sync(context);});assert.equal(await page.evaluate(()=>Portal.ExteriorOrder.needsChoice()),true);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
