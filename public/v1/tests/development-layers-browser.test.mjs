import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
// The dev console's Software layers, Synthetic data and Leads sections (libraries/dev-console) on desktop and a phone.
test('dev console: scope-filtered nested contracts and synthetic data fit desktop and mobile',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1400,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const leadPosts=[];const layers={items:[{id:'projects.profile',layer:'data',origin:'Projects',declarationScope:'global',scopes:['project'],details:{schema:{type:'object',properties:{address:{type:'object',properties:{city:{type:'string'}}}}}}},{id:'custom-fields-project.roof',layer:'data',origin:'Custom fields',declarationScope:'organization',scopes:['project'],details:{schema:{type:'number'}}},{id:'doc.audio',layer:'widgets',origin:'Documents',declarationScope:'global',scopes:['project'],details:{schema:{type:'object'}}},{id:'doc.video',layer:'widgets',origin:'Documents',declarationScope:'global',scopes:['project'],details:{schema:{type:'object'}}},{id:'doc.media.gallery',layer:'widgets',origin:'Documents',declarationScope:'global',scopes:['project'],details:{schema:{type:'object'}}}],projects:[{id:'project',label:'Roof project'}],notes:['Declarations only.']};
  await page.route('http://development.test/**',async route=>{const url=new URL(route.request().url()),p=url.pathname,json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,...data})});
   if(p.startsWith('/libraries/'))return route.fulfill({contentType:p.endsWith('.css')?'text/css':'application/javascript',body:await readFile(new URL('../../libraries/'+p.slice(11),import.meta.url),'utf8')});
   if(p==='/v1/signup-sandbox/development/console')return json({sections:{test_run:false,synthetic_data:true,synthetic_leads:true,software_layers:true,guided:false,live:false}});
   if(p==='/v1/signup-sandbox/development/software-layers')return json(url.searchParams.get('projectId')?{...layers,items:layers.items.filter(item=>item.declarationScope==='organization')}:layers);
   if(p==='/v1/signup-sandbox/development/synthetic-leads'){
    if(route.request().method()==='GET')return json({max:25,fields:[{id:'name',label:'Name',icon:'fa-user',default:true},{id:'phone',label:'Phone',icon:'fa-phone',default:true},{id:'source',label:'Source',icon:'fa-bullhorn',default:true},{id:'note',label:'Note',icon:'fa-comment',default:false}],sources:[{id:'google',label:'Paid › Google Ads',channel:'paid'}]});
    leadPosts.push(route.request().postDataJSON());
    return json({created:2,skipped:0,leads:[{project_id:'p1',name:'Avery Chen',phone:'(312) 555-0142',email:'',address:'',source:'',matched:false},{project_id:'p2',name:'Quinn Ward',phone:'(415) 555-0107',email:'',address:'',source:'',matched:true}]});
   }
   if(p==='/v1/signup-sandbox/development')return json({companies:[{id:'roofing',label:'Roofing'}],categories:[{id:'projects',label:'Projects',icon:'fa-house'}]});
   return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><style>body{margin:0;font:14px Verdana,sans-serif}</style><main>App</main>'});
  });
  await page.goto('http://development.test');
  await page.evaluate(async()=>{await(await import('/libraries/dev-console/dev-console.js')).mount();});
  await page.locator('.fm-dc-strip').click();
  await page.locator('[data-dc-section="layers"]').click();await page.getByText('5 of 5 declarations',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-namespace="doc"]').count(),1);
  assert.equal(await page.getByText('doc.audio',{exact:true}).count(),0);
  await page.locator('[data-namespace="doc"]>summary').click();await page.getByText('doc.audio',{exact:true}).waitFor();
  assert.equal(await page.getByText('doc.media.gallery',{exact:true}).count(),0);
  await page.locator('[data-namespace="doc.media"]>summary').click();await page.getByText('doc.media.gallery',{exact:true}).waitFor();
  await page.locator('[data-namespace="projects"]>summary').click();
  await page.locator('[data-namespace="projects"] .fm-dev-layer-row>summary').click();await page.getByText('schema {2}',{exact:true}).click();await page.getByText('properties {1}',{exact:true}).click();await page.getByText('address {2}',{exact:true}).waitFor();
  // The console takes the page's font.
  const family=await page.evaluate(()=>getComputedStyle(document.body).fontFamily);
  for(const selector of ['.fm-dc-head h2','[data-layer]','[data-search]','.fm-dev-layer-contract','.fm-dev-json summary'])assert.equal(await page.locator(selector).first().evaluate(el=>getComputedStyle(el).fontFamily),family,selector);
  await page.locator('[data-search]').fill('city');assert.equal(await page.locator('.fm-dev-namespace').count(),1);await page.locator('[data-search]').fill('');await page.locator('[data-scope]').selectOption('organization');assert.equal(await page.locator('.fm-dev-namespace').count(),1);
  await page.locator('[data-project]').selectOption('project');await page.getByText('1 of 1 declarations',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.locator('.fm-dc').evaluate(el=>{const r=el.getBoundingClientRect();return r.left===0&&r.right===innerWidth;}),'across the phone');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no sideways scroll');
  await page.locator('[data-dc-section="synthetic"]').click();await page.locator('[data-dev-generate]').waitFor({state:'visible'});
  assert.equal(await page.locator('[data-dev-category="projects"]').isChecked(),true);
  // Leads (FM-552): near the top, count defaults to 1, the chosen fields and source are sent, the leads are listed.
  assert.deepEqual(await page.locator('[data-dc-section]').evaluateAll(els=>els.slice(0,2).map(el=>el.dataset.dcSection)),['leads','org-state']);
  await page.locator('[data-dc-section="leads"]').click();await page.locator('[data-dev-lead-add]').waitFor({state:'visible'});
  assert.equal(await page.locator('[data-dev-lead-count]').inputValue(),'1');
  assert.equal(await page.locator('[data-dev-lead-add]').innerText(),'Add a lead');
  assert.equal(await page.locator('[data-dev-lead-field="note"]').isChecked(),false);
  await page.locator('[data-dev-lead-source]').selectOption('google');
  await page.locator('[data-dev-lead-count]').fill('2');assert.equal(await page.locator('[data-dev-lead-add]').innerText(),'Add 2 leads');
  await page.locator('[data-dev-lead-count]').fill('0');assert.equal(await page.locator('[data-dev-lead-add]').isDisabled(),true);
  await page.locator('[data-dev-lead-count]').fill('2');
  for(const id of ['name','phone'])await page.locator(`[data-dev-lead-field="${id}"]`).uncheck({force:true});
  assert.equal(await page.locator('[data-dev-lead-add]').isDisabled(),true,'a lead needs something besides a source');
  await page.locator('[data-dev-lead-field="phone"]').check({force:true});
  await page.locator('[data-dev-lead-add]').click();await page.getByText('2 leads added',{exact:true}).waitFor();
  assert.equal(leadPosts.length,1);
  assert.deepEqual({...leadPosts[0],request_id:typeof leadPosts[0].request_id},{count:2,fields:{name:false,phone:true,source:true,note:false},source_id:'google',request_id:'string'});
  await page.getByText('Quinn Ward').waitFor();await page.getByText(/matched an existing contact/).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no sideways scroll in Leads');
  await page.screenshot({path:process.env.LEADS_SCREENSHOT||'/dev/null'}).catch(()=>{});
  await page.locator('.fm-dc-fold').click();assert.equal(await page.locator('.fm-dc').isVisible(),false);assert.equal(await page.locator('.fm-dc-strip').isVisible(),false,'a phone has no strip: a shake opens the dev tray');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
