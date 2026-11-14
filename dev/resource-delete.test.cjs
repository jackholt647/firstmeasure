// Resources: a file the team uploaded or saved (a frame, a marked-up copy) can be deleted from More actions.
// Runs the real script against mocked storage; the server's own rules are in project_resources.php.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('../public/v1/node_modules/playwright-core');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
test('Delete this file removes a saved copy after a confirmation; a customer reference cannot be deleted',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:1300,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const original='internal-resource-v2-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-front.png',copy='internal-resource-v2-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-front-ratio.png',customer='internal-resource-v2-cccccccc-cccc-cccc-cccc-cccccccccccc-customer.png',markup='internal-markup-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-1.json';
  let files=[{name:original,original_name:'Front.png',role:'tech'},{name:copy,original_name:'Front ratio.png',role:'tech'},{name:customer,original_name:'Customer.png',role:'customer',source:'customer-order'},{name:markup}];
  const deletes=[];
  const script=fs.readFileSync('public/measure/internal/editor_scripts/project_resources.js','utf8'),css=fs.readFileSync('public/measure/internal/editor_scripts/project_resources.css','utf8');
  await page.route('**/*',route=>{const u=new URL(route.request().url()),name=u.searchParams.get('name');
   if(u.pathname.endsWith('project_resources.php')){
    if(route.request().method()==='POST'){
     if(u.searchParams.get('action')==='delete'){deletes.push({name,header:route.request().headers()['x-resource-request']});
      // As the server does: the file and the markup saved on it leave the list.
      const id=name.slice(21,57);files=files.filter(f=>f.name!==name&&!f.name.startsWith('internal-markup-'+id+'-'));return route.fulfill({json:{ok:true,deleted:name}});}
     return route.fulfill({json:{ok:true}});}
    if(name&&name.endsWith('.json'))return route.fulfill({json:{marks:[],notes:''}});
    if(name)return route.fulfill({contentType:'image/png',body:PNG});
    return route.fulfill({json:{files}});}
   if(u.searchParams.has('action'))return route.fulfill({json:{manifest:{}}});
   return route.fulfill({contentType:'text/html',body:`<style>#google-earth-wrapper{position:relative;width:1000px;height:700px}${css}</style><div id="google-earth-wrapper"><div class="map-view-tabs"></div></div><script>currentProjectId='fixture';switchMapLayer=()=>{};</script><script>${script}</script>`});});
  await page.goto('https://delete.test/editor.php');await page.getByRole('button',{name:'Resources',exact:true}).click();
  const more=page.getByRole('button',{name:'More resource actions'}),remove=page.locator('[data-action="deleteFile"]'),listed=name=>page.getByRole('button',{name,exact:true}).count();
  // Nothing open: nothing to delete.
  await more.click();assert.equal(await remove.isVisible(),true,'Delete sits in the More menu');assert.equal(await remove.textContent(),'Delete this file');assert.equal(await remove.isDisabled(),true);
  const order=await page.locator('.resource-more button').allTextContents();assert.deepEqual(order,['Download original','Refresh project files','Delete this file']);
  await page.keyboard.press('Escape');
  // A customer's own reference cannot be deleted.
  await page.getByRole('button',{name:'Resources',exact:true}).click().catch(()=>{});
  if(!await page.getByRole('button',{name:'Customer.png',exact:true}).isVisible())await page.locator('[data-action="files"]').click();
  await page.getByRole('button',{name:'Customer.png',exact:true}).click();await page.locator('canvas').waitFor({state:'visible'});
  await more.click();assert.equal(await remove.isDisabled(),true,'a customer reference is not deletable');await more.click();
  // The saved copy: declining the confirmation deletes nothing.
  await page.getByRole('button',{name:'Front ratio.png',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.resource-filename')?.textContent.includes('Front ratio.png'));
  const asked=[];let answer=false;page.on('dialog',d=>{asked.push(d.message());answer?d.accept():d.dismiss();});
  await more.click();assert.equal(await remove.isDisabled(),false);await remove.click();
  assert.equal(asked.length,1);assert.ok(asked[0].includes('Front ratio.png'),asked[0]);assert.equal(deletes.length,0,'declined: nothing is sent');assert.equal(await listed('Front ratio.png'),1);
  // Accepted: one delete request for that file, it leaves the list, the viewer is emptied, the others stay.
  answer=true;await more.click();await remove.click();
  await page.waitForFunction(()=>![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Front ratio.png'));
  assert.deepEqual(deletes,[{name:copy,header:'1'}]);assert.equal(await listed('Front.png'),1);assert.equal(await listed('Customer.png'),1);
  assert.equal(await page.locator('canvas').isVisible(),false,'the deleted file is no longer shown');
  assert.ok(!(await page.locator('.resource-filename').textContent()).includes('Front ratio.png'));
  await more.click();assert.equal(await remove.isDisabled(),true);
  await page.setViewportSize({width:1300,height:900});await page.screenshot({path:process.env.RESOURCE_DELETE_SHOT||'output/resource-delete.png'}).catch(()=>{});
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
