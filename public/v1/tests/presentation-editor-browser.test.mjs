import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

// Drives the presentation editor harness (libraries/doc-present/dev-presentation-editor.html):
// the roofing deck in FMPresentationEditor with the sample state.
const libraries=new URL('../../libraries/',import.meta.url);
const shots=new URL('../../../output/presentation-editor-20261007/',import.meta.url);
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const types={js:'application/javascript; charset=utf-8',html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',svg:'image/svg+xml'};

async function open(browser,query=''){
 const page=await browser.newPage({viewport:{width:1600,height:900}}),errors=[],dialogs=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('dialog',async dialog=>{dialogs.push(dialog.message());if(page.acceptDialogs)await dialog.accept();else await dialog.dismiss();});
 await page.route('http://present.test/**',async route=>{const pathname=new URL(route.request().url()).pathname;
  try{return await route.fulfill({contentType:types[pathname.split('.').pop()]||'text/plain',body:await readFile(new URL(pathname.slice('/libraries/'.length),libraries))});}
  catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto('http://present.test/libraries/doc-present/dev-presentation-editor.html'+query);
 await page.waitForFunction(()=>window.editor&&document.querySelector('.fmde-stage .fmdoc-page[data-fmde-current]')&&document.querySelectorAll('.fmwe-ch-pagecard .stage .fmdoc-page').length>=10);
 return {page,errors,dialogs};
}
const shown=page=>page.evaluate(()=>Array.from(document.querySelectorAll('.fmde-stage .fmdoc-page')).filter(el=>el.offsetWidth>0).map(el=>el.dataset.pageId));
const slide=(page,id)=>page.evaluate(id=>editor.getDocument().pages.find(entry=>entry.id===id),id);
const ghosted=page=>page.evaluate(()=>Array.from(document.querySelectorAll('.fmde-stage [data-fmpe-ghost]')).map(el=>el.dataset.nodeId).sort());
const frame=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const selectNode=async(page,id)=>{await page.evaluate(id=>editor.select([id]),id);await frame(page);};

test('the canvas shows one slide, the strip switches and reorders slides, and Present returns to the editor',async()=>{
 const browser=await launch();try{
  const {page,errors}=await open(browser);
  assert.deepEqual(await shown(page),['cover'],'only the current slide is on the canvas');
  const canvas=await page.locator('.fmde-canvas').boundingBox(),box=await page.locator('.fmde-stage .fmdoc-page[data-fmde-current]').boundingBox();
  assert.ok(Math.abs((box.x+box.width/2)-(canvas.x+canvas.width/2))<3&&Math.abs((box.y+box.height/2)-(canvas.y+canvas.height/2))<3,'the slide is centered');
  assert.ok(box.width<=canvas.width&&box.height<=canvas.height&&Math.abs(box.width/box.height-16/9)<0.01,'and fits whole at 16:9');
  assert.equal(await page.locator('.fmwe-ch-pagecard[data-ch-page-card]').count(),10);
  await page.locator('[data-ch-page-card="anatomy"]').click();
  await frame(page);
  assert.deepEqual(await shown(page),['anatomy']);
  assert.equal(await page.locator('[data-ch-page-card="anatomy"].active').count(),1);
  assert.equal(await page.locator('[data-ch-page-card="anatomy"] .fmpe-chip').count(),5,'the current slide lists its steps: before, then one chip per step');
  assert.equal(await page.locator('[data-ch-pages-label]').textContent(),'Slides 4/10');
  // The + offers a blank slide or a duplicate (how Match & move is authored).
  await page.locator('[data-ch-page-new]').click();
  assert.match(await page.locator('.fmpe-menu').textContent(),/Blank slide[\s\S]*Duplicate this slide[\s\S]*Match & move/);
  await page.locator('.fmpe-menu [data-fmpe-menu="duplicate"]').click();
  await frame(page);
  const pages=await page.evaluate(()=>editor.getDocument().pages.map(entry=>({id:entry.id,name:entry.name,steps:(entry.steps||[]).length})));
  assert.equal(pages.length,11);assert.equal(pages[4].name,'Anatomy of a roof copy');assert.equal(pages[4].steps,4);
  assert.deepEqual(await shown(page),[pages[4].id],'the copy opens');
  const copied=await page.evaluate(()=>{const d=editor.getDocument(),p=d.pages[4],ids=new Set();FMDocModel.walkNodes({...d,pages:[p]},n=>{ids.add(n.id);});return p.steps.every(step=>step.actions.every(action=>ids.has(action.node)));});
  assert.equal(copied,true,'its steps animate its own elements');
  // Drag the copy in front of the slide it came from.
  await page.locator(`[data-ch-page-card="${pages[4].id}"]`).dragTo(page.locator('[data-ch-page-card="anatomy"]'),{targetPosition:{x:8,y:30}});
  await frame(page);
  assert.equal(await page.evaluate(()=>editor.getDocument().pages[3].name),'Anatomy of a roof copy');
  await page.evaluate(()=>{editor.undo();editor.undo();});
  await frame(page);
  assert.equal(await page.evaluate(()=>editor.getDocument().pages.length),10,'undo takes the move and the copy back');
  // Present plays from the slide on screen and comes back to where the audience was.
  await page.evaluate(()=>editor.showSlide('choose_shingles'));
  await page.locator('[data-fmde-action="present"]').click();
  await page.waitForFunction(()=>editor.player()&&document.querySelector('[data-fmpe-present] .fmdoc-page[data-fmdp-on]'));
  assert.equal(await page.evaluate(()=>editor.player().position().page_id),'choose_shingles');
  await page.evaluate(()=>editor.player().goTo(8,0,{animate:false}));
  await page.evaluate(()=>editor.closePresent());
  assert.equal(await page.locator('[data-fmpe-present]').count(),0);
  assert.deepEqual(await shown(page),['estimate'],'closing returns to the editor on the slide that was showing');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('Animate adds an entrance as a step, undo removes it, step chips ghost what is not there yet, and a transition is set',async()=>{
 const browser=await launch();try{
  const {page,errors}=await open(browser,'?slide=good_roof');
  await page.getByRole('button',{name:'Animate',exact:true}).click();
  assert.match(await page.locator('[data-fmpe-animate]').textContent(),/Slide transition/);
  assert.equal(await page.locator('[data-fmpe-stepcard]').count(),3);
  await selectNode(page,'good_title');
  assert.equal(await page.getByRole('button',{name:'Animate',exact:true}).evaluate(el=>el.classList.contains('active')),true,'selecting keeps Animate open');
  assert.match(await page.locator('.fmpe-target').textContent(),/Title[\s\S]*Not animated/);
  await page.locator('[data-fmpe-add="slide_in"]').click();
  await frame(page);
  let steps=(await slide(page,'good_roof')).steps;
  assert.equal(steps.length,4);
  assert.deepEqual(steps[3].actions,[{node:'good_title',effect:'slide_in',direction:'left'}]);
  assert.equal(await page.locator('[data-fmpe-mine]').count(),1);
  // Direction, duration and "with previous step" are edits of the same action.
  await page.locator('[data-fmpe-mine] [data-dir="up"]').click();
  await frame(page);
  await page.locator('[data-fmpe-key="duration:3:0"]').fill('900');
  await page.locator('[data-fmpe-key="duration:3:0"]').press('Enter');
  await frame(page);
  steps=(await slide(page,'good_roof')).steps;
  assert.deepEqual(steps[3].actions,[{node:'good_title',effect:'slide_in',direction:'up',duration_ms:900}]);
  await page.locator('[data-fmpe-addto="last"]').click();
  await page.locator('[data-fmpe-add="pulse"]').click();
  await frame(page);
  steps=(await slide(page,'good_roof')).steps;
  assert.equal(steps.length,4);assert.deepEqual(steps[3].actions.map(action=>action.effect),['slide_in','pulse']);
  await page.evaluate(()=>{editor.undo();editor.undo();editor.undo();editor.undo();});
  await frame(page);
  assert.equal((await slide(page,'good_roof')).steps.length,3,'undo removes the step');
  assert.equal(await page.locator('[data-fmpe-mine]').count(),0);
  // Step chips: the slide as it looks after that step, with the rest ghosted (still selectable).
  await page.evaluate(()=>editor.select([]));
  assert.deepEqual(await ghosted(page),[]);
  await page.locator('[data-ch-page-card="good_roof"] [data-fmpe-step="1"]').click();
  assert.deepEqual(await ghosted(page),['good_2','good_3']);
  assert.match(await page.locator('.fmpe-banner').textContent(),/After step 1[\s\S]*Water/);
  await page.locator('[data-ch-page-card="good_roof"] [data-fmpe-step="0"]').click();
  assert.deepEqual(await ghosted(page),['good_1','good_2','good_3']);
  const opacity=await page.evaluate(()=>Number(getComputedStyle(document.querySelector('.fmde-stage [data-node-id="good_1"]')).opacity));
  assert.ok(opacity>0&&opacity<0.3,'ghosted, not invisible: '+opacity);
  await page.locator('[data-fmpe-preview-off]').click();
  assert.deepEqual(await ghosted(page),[]);
  // Steps: rename, play automatically, play in place, delete.
  await page.locator('[data-fmpe-name="1"]').fill('Air');
  await page.locator('[data-fmpe-name="1"]').press('Enter');
  await page.locator('[data-fmpe-auto="1"]').click();
  await frame(page);
  steps=(await slide(page,'good_roof')).steps;
  assert.equal(steps[1].name,'Air');assert.equal(steps[1].auto,true);
  await page.locator('[data-fmpe-stepcard="0"] [data-fmpe-play]').click();
  await page.waitForSelector('.fmpe-play .fmdoc-page[data-fmdp-on]');
  await page.waitForSelector('.fmpe-play',{state:'detached',timeout:5000});
  // The slide's transition.
  await page.locator('[data-fmpe-transition="slide"]').click();
  await frame(page);
  await page.locator('[data-fmpe-tdir="up"]').click();
  await frame(page);
  await page.locator('[data-fmpe-key="tduration"]').fill('450');
  await page.locator('[data-fmpe-key="tduration"]').press('Enter');
  await frame(page);
  assert.deepEqual((await slide(page,'good_roof')).transition,{type:'slide',direction:'up',duration_ms:450});
  await page.locator('[data-fmpe-transition="none"]').click();
  await frame(page);
  assert.equal((await slide(page,'good_roof')).transition,null);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('a widget is inserted with its assembly and pieces; a required piece is marked and cannot be deleted alone',async()=>{
 const browser=await launch();try{
  const {page,errors,dialogs}=await open(browser,'?slide=about');
  const before=await page.evaluate(()=>Object.keys(editor.getDocument().assemblies).length);
  await page.locator('[data-ch-tab="interactive"]').click();
  const listed=await page.evaluate(()=>FMDocParts.list().reduce((sum,type)=>sum+type.presets.length,0));
  assert.equal(await page.locator('[data-fmpe-preset]').count(),listed,'every preset of every assembly type is offered');
  await page.waitForFunction(()=>document.querySelector('[data-fmpe-preset="choice_selection:list"] .fmdoc-page'));
  await page.locator('[data-fmpe-preset="choice_selection:list"]').click();
  await frame(page);
  const made=await page.evaluate(()=>{const d=editor.getDocument(),id=Object.keys(d.assemblies).pop(),entry=d.assemblies[id],parts=FMDocModel.assemblyParts(d,id,[]);
   return {count:Object.keys(d.assemblies).length,id,entry,roles:parts.map(part=>part.role),pages:Array.from(new Set(parts.map(part=>part.page.id))),missing:FMDocModel.assemblyMissingParts(entry,parts),selected:editor.selection()};});
  assert.equal(made.count,before+1);
  assert.equal(made.entry.type,'choice_selection');assert.deepEqual(made.entry.config.source,{kind:'group',id:'shingle_profile'});
  assert.deepEqual(made.pages,['about'],'on the slide that is showing');
  assert.equal(made.roles.filter(role=>role==='option').length,3);assert.deepEqual(made.missing,[]);
  assert.equal(made.selected.length,1,'the new widget is selected');
  // Its data source is edited from Design.
  await page.getByRole('button',{name:'Design',exact:true}).click();
  await page.locator('[data-fmpe-source]').selectOption('addons');
  await frame(page);
  assert.deepEqual(await page.evaluate(id=>editor.getDocument().assemblies[id].config.source,made.id),{kind:'addons'});
  // A required piece: its own outline color, a role chip, and a badge in Layers.
  const price=await page.evaluate(id=>FMDocModel.assemblyParts(editor.getDocument(),id,[]).find(part=>part.role==='option.price'&&part.key==='0').node.id,made.id);
  await selectNode(page,price);
  assert.equal(await page.locator('.fmde-selbox.fmde-selbox-part .fmde-partchip.required').textContent(),'Option price \u00b7 required');
  assert.equal(await page.locator('[data-fmpe-required="yes"]').count(),1);
  await page.locator('[data-ch-tab="layers"]').click();
  assert.equal(await page.locator(`[data-fmpe-layer="${price}"] [data-fmpe-layer-part="required"]`).count(),1);
  // Deleting it asks about the whole widget; without a yes nothing is deleted.
  await page.evaluate(()=>document.querySelector('.fmde-root').focus());
  await page.keyboard.press('Delete');
  assert.equal(dialogs.length,1);assert.match(dialogs[0],/needs this piece\. Delete the whole widget\?/);
  assert.equal(await page.evaluate(id=>!!FMDocModel.findNode(editor.getDocument(),id),price),true);
  assert.equal(await page.evaluate(id=>editor.apply({type:'node.remove',node_id:id}).reason,price),'required_part:'+made.id);
  // It still moves freely.
  assert.equal(await page.evaluate(id=>editor.apply({type:'node.set',node_id:id,prop:'frame.x',value:12}).ok,price),true);
  // With a yes the whole widget goes, declaration included.
  page.acceptDialogs=true;
  await page.keyboard.press('Delete');
  await frame(page);
  assert.equal(await page.evaluate(id=>id in editor.getDocument().assemblies,made.id),false);
  assert.equal(await page.evaluate(id=>FMDocModel.assemblyParts(editor.getDocument(),id,[]).length,made.id),0);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('any element gets a click action, buttons come ready, and the slide has a background and a size',async()=>{
 const browser=await launch();try{
  const {page,errors}=await open(browser,'?slide=about');
  await selectNode(page,'about_photo');
  await page.locator('[data-fmpe-action]').selectOption('goto');
  await frame(page);
  await page.locator('[data-fmpe-action-page]').selectOption('estimate');
  await frame(page);
  assert.deepEqual(await page.evaluate(()=>FMDocModel.findNode(editor.getDocument(),'about_photo').node.props.action),{type:'goto',page:'estimate'});
  await page.locator('[data-fmpe-action]').selectOption('custom');
  await frame(page);
  await page.locator('[data-fmpe-action-name]').fill('send');
  await page.locator('[data-fmpe-action-name]').press('Enter');
  await frame(page);
  assert.deepEqual(await page.evaluate(()=>FMDocModel.findNode(editor.getDocument(),'about_photo').node.props.action),{type:'custom',name:'send'});
  await page.locator('[data-fmpe-action]').selectOption('next');
  await frame(page);
  // The action works while presenting.
  await page.locator('[data-fmde-action="present"]').click();
  await page.waitForFunction(()=>editor.player()&&document.querySelector('[data-fmpe-present] [data-node-id="about_photo"][data-part-action="next"]'));
  await page.locator('[data-fmpe-present] [data-node-id="about_photo"]').click();
  assert.equal(await page.evaluate(()=>editor.player().position().step),1);
  await page.evaluate(()=>editor.closePresent());
  await page.evaluate(()=>editor.undo());
  await frame(page);
  assert.equal(await page.evaluate(()=>FMDocModel.findNode(editor.getDocument(),'about_photo').node.props.action.type),'custom');
  // Ready-made buttons.
  await page.locator('[data-ch-tab="interactive"]').click();
  await page.locator('[data-fmpe-button="next"]').click();
  await frame(page);
  const button=await page.evaluate(()=>{const node=FMDocModel.findNode(editor.getDocument(),editor.selection()[0]);return {page:node.page.id,action:node.node.props.action,label:node.node.children[0].props.blocks[0].runs[0].text};});
  assert.deepEqual(button,{page:'about',action:{type:'next'},label:'Next'});
  await page.locator('[data-fmpe-button="back"]').click();
  await frame(page);
  assert.deepEqual(await page.evaluate(()=>FMDocModel.findNode(editor.getDocument(),editor.selection()[0]).node.props.action),{type:'back'});
  // Nothing selected: the slide. Its background is the full-bleed "Background" rectangle.
  await page.evaluate(()=>editor.select([]));
  await frame(page);
  assert.match(await page.locator('.fmde-insp-inspect .fmde-inspector-head').textContent(),/Slide 2 of 10/);
  // A drag that starts on the empty part of the slide does not carry the background off.
  const area=await page.locator('.fmde-stage .fmdoc-page[data-fmde-current]').boundingBox();
  await page.mouse.move(area.x+area.width*0.5,area.y+area.height*0.93);await page.mouse.down();
  await page.mouse.move(area.x+area.width*0.62,area.y+area.height*0.8,{steps:6});await page.mouse.up();
  await frame(page);
  assert.deepEqual(await page.evaluate(()=>{const f=editor.getDocument().pages[1].children[0].frame;return [f.x,f.y,f.w,f.h];}),[0,0,960,540]);
  await page.evaluate(()=>editor.select([]));
  await frame(page);
  await page.locator('.fmde-insp-inspect .fmde-color-text').first().fill('#fff7ed');
  await page.locator('.fmde-insp-inspect .fmde-color-text').first().dispatchEvent('change');
  await frame(page);
  assert.equal(await page.evaluate(()=>editor.getDocument().pages[1].children[0].style.fill.color),'#fff7ed');
  await page.locator('[data-fmpe-size="slide_4_3"]').click();
  await frame(page);
  const sized=await page.evaluate(()=>{const d=editor.getDocument();return {size:d.settings.paper.size,backgrounds:d.pages.map(entry=>entry.children[0].frame.h)};});
  assert.equal(sized.size,'slide_4_3');assert.ok(sized.backgrounds.every(h=>h===720),'backgrounds follow the slide');
  const box=await page.locator('.fmde-stage .fmdoc-page[data-fmde-current]').boundingBox();
  assert.ok(Math.abs(box.width/box.height-4/3)<0.01);
  await page.evaluate(()=>editor.undo());
  await frame(page);
  assert.equal(await page.evaluate(()=>editor.getDocument().settings.paper.size),'slide');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('the Docs host loads a module layout, publishes an edited one as a new version, and protects unsaved changes',async()=>{
 const browser=await launch();try{
  const page=await browser.newPage({viewport:{width:1600,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://present.test/**',async route=>{const pathname=new URL(route.request().url()).pathname;
   try{return await route.fulfill({contentType:types[pathname.split('.').pop()]||'text/plain',body:await readFile(new URL(pathname.slice('/libraries/'.length),libraries))});}
   catch{return route.fulfill({status:404,body:''});}
  });
  await page.goto('http://present.test/libraries/doc-present/dev-presentation-editor.html?host=1');
  await page.waitForSelector('[data-fm-presentation-editor] .fmde-stage .fmdoc-page[data-fmde-current]');
  assert.deepEqual(await page.evaluate(()=>requests.map(entry=>entry.method+' '+entry.path)),['GET /modules/preset_presentation_roofing']);
  assert.equal(await page.evaluate(()=>FMPresentationEditorHost.isOpen()),true);
  // An edit, then Close: the editor asks before losing it.
  await page.getByRole('button',{name:'Animate',exact:true}).click();
  await page.locator('[data-fmpe-transition="zoom"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-fmpe-transition="zoom"].on'));
  await page.locator('[data-fmde-action="close"]').click();
  assert.match(await page.locator('.fmpeh-ask').textContent(),/Save your changes\?[\s\S]*Roof presentation/);
  await page.locator('[data-fmpeh="stay"]').click();
  assert.equal(await page.locator('.fmpeh-ask').count(),0);
  assert.equal(await page.locator('[data-fm-presentation-editor]').count(),1,'still editing');
  // Save publishes the same definition with the edited layout, to the same module.
  await page.locator('[data-fmde-action="save"]').click();
  await page.waitForFunction(()=>requests.length===2);
  const post=await page.evaluate(()=>{const entry=requests[1];return {call:entry.method+' '+entry.path,moduleId:entry.body.moduleId,kind:entry.body.definition.kind,name:entry.body.definition.name,spec:entry.body.definition.presentation,transition:entry.body.definition.renderer.pages[0].transition,pages:entry.body.definition.renderer.pages.length};});
  assert.deepEqual(post,{call:'POST /presentation-modules',moduleId:'preset_presentation_roofing',kind:'presentation',name:'Roof presentation',spec:{pricing:'scope'},transition:{type:'zoom'},pages:10});
  // Saved: Close closes without asking and reports what was published.
  await page.waitForFunction(()=>!document.querySelector('[data-fmde-action="save"]').disabled);
  await page.locator('[data-fmde-action="close"]').click();
  await page.waitForFunction(()=>window.closedWith);
  assert.deepEqual(await page.evaluate(()=>closedWith),{saved:true,module:{id:'preset_presentation_roofing',name:'Roof presentation',kind:'presentation',version:'v2'}});
  assert.equal(await page.locator('[data-fm-presentation-editor]').count(),0);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('screenshots for review',async()=>{
 const browser=await launch();try{
  await mkdir(shots,{recursive:true});
  const {page,errors}=await open(browser,'?slide=choose_shingles');
  const settle=()=>page.waitForTimeout(700);
  await page.getByRole('button',{name:'Animate',exact:true}).click();
  await selectNode(page,'choose_shingles_lead');
  await settle();
  await page.screenshot({path:fileURLToPath(new URL('animate-shingle-choice.png',shots))});
  await page.evaluate(()=>editor.select([]));
  await page.locator('[data-ch-tab="interactive"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-fmpe-preset] .fmdoc-page').length===document.querySelectorAll('[data-fmpe-preset]').length);
  await settle();
  await page.screenshot({path:fileURLToPath(new URL('widget-insert-panel.png',shots))});
  await page.locator('[data-ch-tab="layers"]').click();
  await page.getByRole('button',{name:'Design',exact:true}).click();
  const price=await page.evaluate(()=>FMDocModel.assemblyParts(editor.getDocument(),'asm_shingles',[]).find(part=>part.role==='option.price'&&part.key==='1').node.id);
  await selectNode(page,price);
  await settle();
  await page.screenshot({path:fileURLToPath(new URL('required-part-selected.png',shots))});
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
