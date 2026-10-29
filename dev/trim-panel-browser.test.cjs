// The Trim menu (roof_trim_editor.js): Selection, Trim settings with one Apply, Default colours.
const test=require('node:test'),assert=require('node:assert/strict');
const SCRIPTS='public/measure/internal/editor_scripts/';
async function browser(t){const {chromium}=require('../public/v1/node_modules/playwright-core');const b=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox','--use-angle=swiftshader']});t.after(()=>b.close());return b;}
const p=(x,y,z)=>({x,y,z}),a=p(0,0,3),b=p(6,0,3),c=p(6,2,4),d=p(0,2,4),e=p(6,4,3),f=p(0,4,3),roof={points:[a,b,c,d,e,f],connections:[[0,1,'eave'],[1,2,'rake'],[2,4,'rake'],[4,5,'eave'],[5,3,'rake'],[3,0,'rake'],[3,2,'ridge']].map(([startIdx,endIdx,type])=>({startIdx,endIdx,type})),faces:[{points:[a,b,c,d]},{points:[d,c,e,f]}]};
async function menu(t){
 const page=await (await browser(t)).newPage();
 await page.setContent('<body class="wall-mode-active"><div id="exterior-main-toolbar"><div aria-label="Rebuild building"></div></div></body>');
 for(const file of ['exterior_geometry.js','roof_trim.js','wall_trim.js','roof_trim_editor.js'])await page.addScriptTag({path:SCRIPTS+file});
 await page.evaluate(roof=>{window.calls=[];window.settings={};window.defaults={wall:'#f5f3ef',roof:'#f5f3ef',window:'#111111',door:'#222222',garage:'#333333'};
  window.menu=createRoofTrimEditor({settings:()=>settings,set:v=>settings=v,commit:()=>calls.push(['commit']),enabled:()=>true,visible:()=>true,redraw(){},openChanged:open=>calls.push(['open',open]),
   wallMaterials:()=>['siding','brick'],wallWidth:()=>6,selectWallTrim:(kind,materials)=>calls.push(['walls',kind,...materials]),selectOpeningTrim:type=>calls.push(['openings',type]),
   trimDefaults:()=>defaults,setTrimDefault:(kind,color)=>{defaults={...defaults,[kind]:color};calls.push(['default',kind,color]);}});
  menu.refresh(roof);},roof);
 return page;
}
const edges=page=>page.evaluate(()=>Object.values(settings.edges||{}).filter(e=>e.height>0).map(e=>[Math.round(e.height/.0254*100)/100,e.finishColor||null]));
const calls=page=>page.evaluate(()=>calls.splice(0));
test('Trim opens with three sections and tells its host; picks add to one selection',async t=>{
 const page=await menu(t);await page.click('#roof-trim-tool');assert.deepEqual(await calls(page),[['open',true]]);
 for(const name of ['Selection','Trim settings','Default trim colours'])assert.ok(await page.getByRole('region',{name}).isVisible(),name);
 assert.equal(await page.textContent('#trim-selection-count'),'Nothing selected');assert.equal(await page.isDisabled('#trim-apply'),true);
 await page.click('#roof-trim-eaves');assert.match(await page.textContent('#trim-selection-count'),/^2 selected · 2 eaves$/);
 await page.click('#roof-trim-rakes');assert.match(await page.textContent('#trim-selection-count'),/^6 selected · 2 eaves · 4 rakes$/,'Rakes adds to Eaves');
 await page.getByRole('button',{name:'Windows'}).click();await page.click('#wall-trim-select');await page.click('#trim-material-all');await page.click('#wall-trim-ground-untrimmed');
 assert.deepEqual(await calls(page),[['openings','window'],['walls','walls','siding'],['walls','ground-untrimmed','siding','brick']],'openings and walls pick through the host, with the chosen materials');
 assert.deepEqual(await edges(page),[],'nothing changes before Apply');
 await page.click('#roof-trim-tool');assert.deepEqual((await calls(page)).filter(c=>c[0]==='open'),[['open',false]]);
});
test('Apply sets width and colour for the selection in one step; untouched settings keep each piece\'s own',async t=>{
 const page=await menu(t);await page.click('#roof-trim-tool');await page.click('#roof-trim-eaves');
 assert.equal(await page.isDisabled('#trim-apply'),false,'pieces without trim can be trimmed straight away');
 await page.getByRole('group',{name:'Trim width'}).getByRole('button',{name:'3',exact:true}).click();
 await page.locator('#trim-selection-color').evaluate(el=>{el.value='#aabbcc';el.dispatchEvent(new Event('input',{bubbles:true}));});
 assert.deepEqual(await edges(page),[],'still nothing before Apply');
 await page.click('#trim-apply');assert.deepEqual(await edges(page),[[3,'#aabbcc'],[3,'#aabbcc']]);assert.deepEqual((await calls(page)).filter(c=>c[0]==='commit').length,1,'one undo step');
 // A width alone keeps each piece's colour.
 await page.fill('#trim-selection-custom','4.5');await page.press('#trim-selection-custom','Enter');assert.deepEqual(await edges(page),[[4.5,'#aabbcc'],[4.5,'#aabbcc']],'Enter in the width box applies');
 // Default puts the colour back to the roof trim default.
 await page.click('#trim-color-default');assert.equal(await page.textContent('#trim-selection-color-state'),'Default colours');await page.click('#trim-apply');assert.deepEqual(await edges(page),[[4.5,null],[4.5,null]]);
 // Rakes added later get the eave width only if asked; on their own they get the roof default of 6 in.
 await page.click('#roof-trim-rakes');await page.click('#trim-apply');const now=await edges(page);assert.equal(now.length,6);assert.equal(now.filter(([w])=>w===6).length,4);assert.equal(now.filter(([w])=>w===4.5).length,2,'trimmed eaves keep their width');
 await page.click('#trim-selection-remove');assert.deepEqual(await edges(page),[]);
});
test('Default colours show the Wall materials defaults and change them',async t=>{
 const page=await menu(t);await page.click('#roof-trim-tool');
 assert.equal(await page.getByLabel('Default windows trim color').inputValue(),'#111111');
 await page.getByLabel('Default roof trim color').evaluate(el=>{el.value='#445566';el.dispatchEvent(new Event('change',{bubbles:true}));});
 assert.deepEqual((await calls(page)).filter(c=>c[0]==='default'),[['default','roof','#445566']]);
});
