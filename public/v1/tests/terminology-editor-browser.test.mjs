import assert from 'node:assert/strict';import test from 'node:test';import {readFile,mkdir} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import {chromium} from 'playwright-core';
test('terminology editor saves only selected-language drafts, resets, searches and stays usable on mobile',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1280,height:850}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://terminology.test/**',async route=>{const url=new URL(route.request().url());if(url.pathname.startsWith('/libraries/platform-language/catalogs/'))return route.fulfill({contentType:'application/json',body:await readFile(new URL('../../'+url.pathname.slice(1),import.meta.url),'utf8')});return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><style>body{font:14px Arial;background:#f7f8fa;margin:24px}button,input,select,textarea{font:inherit}</style><nav>Custom fields　 Terminology　 Projects　 Celebrations　 Insights　 Apps</nav><main style="margin-top:20px"></main>'});});
 await page.goto('http://terminology.test/');
 for(const file of ['platform-language/platform-language.js','platform-terminology/platform-terminology.js','platform-terminology/editor.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/'+file,import.meta.url),'utf8')});
 await page.evaluate(async()=>{
  await window.PlatformLanguage.ensure(['terminology','projects','crew']);window.saved=[];window.persisted={labels:{projects:{project:'Project',projects:'Projects'}}};
  window.PlatformScheduling={loadBranchConfig:async()=>({mappings:structuredClone(window.persisted)})};
  window.PlatformAPI={branchModules:{get:async()=>({data:structuredClone(window.persisted)}),save:async(_o,_b,_m,value)=>{window.persisted=structuredClone(value);window.saved.push(value);}},terminologyAssistant:{createThread:async()=>({thread:{id:'thread'}}),send:async()=>({status:'success',assistant_message:{role:'assistant',content:'Prepared plural wording.'},renders:[{type:'terminology_draft',locale:'en-US',changes:[{key:'projects.projects',value:'Jobs'}]}]})}};
  await window.PlatformTerminologyEditor.mount(document.querySelector('main'),{orgId:'test',branchId:'default'});
 });
 await page.locator('[data-term="projects.project"]').fill('Job');await page.locator('[data-save]').click();await page.waitForFunction(()=>window.saved.length===1&&!document.querySelector('[data-save]').textContent.includes('Saving'));
 assert.equal(await page.evaluate(()=>window.saved[0].localized_labels['en-US'].projects.project),'Job');assert.equal(await page.evaluate(()=>window.PlatformTerminology.get('projects.project')),'Job');
 await page.locator('[data-locale]').selectOption('en-GB');assert.equal(await page.locator('[data-term="projects.project"]').inputValue(),'Project');
 await page.locator('[data-term="projects.project"]').fill('Contract');await page.locator('[data-save]').click();await page.waitForFunction(()=>window.saved.length===2&&!document.querySelector('[data-save]').textContent.includes('Saving'));
 assert.equal(await page.evaluate(()=>window.saved[1].localized_labels['en-US'].projects.project),'Job');assert.equal(await page.evaluate(()=>window.saved[1].localized_labels['en-GB'].projects.project),'Contract');
 await page.locator('[data-reset="projects.project"]').click();await page.locator('[data-save]').click();await page.waitForFunction(()=>window.saved.length===3&&!document.querySelector('[data-save]').textContent.includes('Saving'));
 assert.equal(await page.evaluate(()=>window.saved[2].localized_labels['en-GB'].projects.project),'');
 await page.locator('[data-locale]').selectOption('en-US');await page.locator('input[type=search]').fill('projects');assert.ok(await page.locator('[data-row]').count()<20);
 await page.locator('textarea').fill('Call projects jobs');await page.locator('button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('[data-term="projects.projects"]').value==='Jobs');assert.equal(await page.evaluate(()=>window.saved.length),3);assert.equal(await page.locator('[data-term="projects.portal_tab"]').inputValue(),'My Jobs');
 const output=new URL('../../../output/terminology-work/',import.meta.url);await mkdir(output,{recursive:true});await page.screenshot({path:fileURLToPath(new URL('desktop.png',output))});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:fileURLToPath(new URL('mobile.png',output)),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.locator('[data-chat-toggle]').click();assert.equal(await page.locator('.tm-assistant').isVisible(),true);assert.equal(await page.locator('.tm-list').isVisible(),false);await page.screenshot({path:fileURLToPath(new URL('mobile-assistant.png',output))});assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
