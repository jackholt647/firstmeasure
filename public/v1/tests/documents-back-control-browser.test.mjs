import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// The phone's back control in a document (FM-579): Android's back and iOS's swipe walk WebView history, so what is on
// screen keeps one history entry each (Portal.navigation.steps, FM-554). A back press closes a dialog, then Preview,
// then goes back a step, and from the first step leaves the document for the list: never another project tab.
const lib=file=>readFile(new URL('../../libraries/'+file,import.meta.url),'utf8');
const source=await lib('apps/documents/project.js');
const between=(from,to)=>{const a=source.indexOf(from),b=source.indexOf(to,a+from.length);assert.ok(a>=0&&b>a,`slice ${from}`);return source.slice(a,b);};
const backCode=between('    // ====================================================== back control','    const orgId = () =>');
// The dialog kit, with the open-dialog list the back control reads.
const modalCode=between('  function openModal(','    return { el: menu, close };\n  }')+'    return { el: menu, close };\n  }';

const PAGE=`<!doctype html><html><head><style>body{margin:0;font:14px Arial}.fmdx-modal-back{position:fixed;inset:0;background:#0006}.fmdx-preview-overlay{position:fixed;inset:0;background:#111}</style></head><body>
  <button id="open" type="button">Open document</button><button id="preview" type="button">Preview</button><button id="send" type="button">Send</button>
  <div id="host"></div>
  <script>window.__APP={userOrgId:'o'};</script>
  <script src="/libraries/navigation/portal-navigation.js"></script>
  <script src="/libraries/doc-workflow/firstmate-doc-workflow.js"></script>
  <script>
    window.routeApplies=[];window.log=[];
    Portal.navigation.registerHandler('test',{apply:(route,context)=>{window.routeApplies.push(context.source+':'+(route.projectTab||''));}});
  </script></body></html>`;

/** The Documents tab's back control with its real dialogs and the real stepper; the rest of the tab is stood in for. */
function harness({backCode,modalCode}){
  const esc=value=>String(value??'');
  const isPhone=()=>false;
  const workflow={id:'wf',name:'Proposal',steps:['One','Two','Three'].map((title,i)=>({id:'s'+i,title,items:[]}))};
  const run=new Function('esc','isPhone','workflow',`
    ${modalCode}
    const state={destroyed:false,view:'list',docView:'editor',docWorkflow:null,workflowHandle:null,previewCleanup:null,doc:null};
    const isReadOnlyStatus=status=>status==='signed';
    const embedded=false,embed={};
    ${backCode}
    function setDocView(view){state.docView=view;window.log.push('view:'+view);syncBack();}
    function closeDocScreen(){state.workflowHandle?.destroy();state.workflowHandle=null;state.view='list';state.doc=null;state.docWorkflow=null;window.log.push('closed');syncBack();}
    document.querySelector('#open').addEventListener('click',()=>{
      state.view='editor';state.docView='workflow';state.doc={id:'d1',status:'draft'};state.docWorkflow={definition:workflow};
      state.workflowHandle=FMDocWorkflow.mount(document.querySelector('#host'),{workflow,onStepState:()=>syncBack()});
      syncBack();
    });
    document.querySelector('#preview').addEventListener('click',()=>{
      const overlay=document.createElement('div');overlay.className='fmdx-preview-overlay';document.body.append(overlay);
      const close=()=>{overlay.remove();if(state.previewCleanup===close)state.previewCleanup=null;syncBack();};
      state.previewCleanup=close;syncBack();
    });
    document.querySelector('#send').addEventListener('click',()=>openModal('<h2>Send</h2>'));
    return {state,step:()=>state.workflowHandle?.position().index,manual:()=>{state.docView='editor';syncBack();}};
  `);
  window.docs=run(esc,isPhone,workflow);
}

const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const depth=tab=>tab.evaluate(()=>history.state?.fmSteps?.depth??0);
const settled=(tab,n)=>tab.waitForFunction(n=>(history.state?.fmSteps?.depth??0)===n,n);
const step=tab=>tab.evaluate(()=>window.docs.step());
const back=async(tab,n)=>{await tab.evaluate(()=>history.back());await settled(tab,n);await tab.waitForTimeout(150);};

async function open(browser){
  const tab=await browser.newPage({viewport:{width:390,height:800},hasTouch:true,isMobile:true}),errors=[];
  tab.on('pageerror',error=>errors.push(error.message));
  await tab.route('https://fm.test/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'text/javascript',body:await lib(url.pathname.slice(11))});
    if(url.pathname==='/portal/')return route.fulfill({contentType:'text/html',body:PAGE});
    return route.fulfill({status:404,body:''});
  });
  await tab.goto('https://fm.test/portal/?project=p1&projectTab=docs');
  await tab.evaluate(harness,{backCode,modalCode});
  return {tab,errors};
}

test('back closes Preview and a dialog, goes back a step, and leaves the document from its first step',async()=>{
  const browser=await launch();
  try{
    const {tab,errors}=await open(browser);
    // A route entry for the tab before it, as the project's tabs push: back must never reach it while a document is open.
    await tab.evaluate(()=>Portal.navigation.push({projectTab:'photos'},{source:'test'}));
    await tab.evaluate(()=>Portal.navigation.push({projectTab:'docs'},{source:'test'}));
    const before=await tab.evaluate(()=>history.length);
    await tab.click('#open');
    await settled(tab,1);
    assert.equal(await step(tab),0);
    await tab.click('[data-fmdw-continue]');
    await settled(tab,2);
    await tab.click('[data-fmdw-continue]');
    await settled(tab,3);
    assert.equal(await step(tab),2);
    // Preview over the third step, a dialog over Preview: one entry each.
    await tab.click('#preview');
    await settled(tab,4);
    // A tap on Preview (the input an entry needs) that opens a dialog over it, as Send does.
    await tab.mouse.click(200,400);
    await tab.evaluate(()=>document.querySelector('#send').click());
    await settled(tab,5);
    assert.equal(await tab.evaluate(()=>history.length),before+5);

    await back(tab,4);
    assert.equal(await tab.locator('.fmdx-modal-back').count(),0,'back closes the dialog');
    assert.equal(await tab.locator('.fmdx-preview-overlay').count(),1,'Preview is still open');
    await back(tab,3);
    assert.equal(await tab.locator('.fmdx-preview-overlay').count(),0,'back closes Preview');
    assert.equal(await step(tab),2,'on the step it was opened from');
    await back(tab,2);
    assert.equal(await step(tab),1,'back goes to the previous step');
    // The step's own Back takes its entry off too.
    await tab.click('[data-fmdw-back]');
    await settled(tab,1);
    assert.equal(await step(tab),0);
    await tab.waitForTimeout(150);
    await tab.evaluate(()=>history.back());
    await tab.waitForFunction(()=>window.log.includes('closed'));
    await settled(tab,0);
    assert.equal(await tab.evaluate(()=>window.docs.state.view),'list','the first step leaves the document for the list');
    assert.equal(await tab.evaluate(()=>new URL(location.href).searchParams.get('projectTab')),'docs');
    assert.deepEqual(await tab.evaluate(()=>window.routeApplies.filter(entry=>entry.startsWith('popstate'))),[],'no back press changed tab');

    // With the document closed, back is the project's own navigation again.
    await tab.evaluate(()=>history.back());
    await tab.waitForFunction(()=>window.routeApplies.includes('popstate:photos'));
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('from "Edit manually" back returns to the steps, and a locked document has no steps behind it',async()=>{
  const browser=await launch();
  try{
    const {tab,errors}=await open(browser);
    await tab.click('#open');
    await settled(tab,1);
    await tab.click('[data-fmdw-continue]');
    await settled(tab,2);
    await tab.evaluate(()=>window.docs.manual());
    await tab.mouse.click(5,700);
    await settled(tab,3);
    await back(tab,2);
    assert.equal(await tab.evaluate(()=>window.docs.state.docView),'workflow');
    assert.equal(await step(tab),1,'the steps keep their place');

    await tab.evaluate(()=>{window.docs.state.doc.status='signed';window.docs.manual();});
    await tab.waitForTimeout(150);
    assert.equal(await depth(tab),1,'a locked document only leaves');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('every surface the back control counts says when it opens and closes',()=>{
  const preview=between('    async function openPreview(','    async function openFullEditor(');
  assert.equal((preview.match(/syncBack\(\)/g)||[]).length,2,'Preview: open and close');
  // "Edit manually" is the full editor (GP-169), counted by docBackDepth.
  assert.match(between('    async function openFullEditor(','\n    }'),/setDocView\('editor'\)/);
  assert.match(source,/id: 'edit_manually'[^\n]*run: \(\) => openFullEditor\(\)/);
  assert.doesNotMatch(source,/FMDocSentEditor|sentEditor/,'the separate as-sent editor is retired');
  assert.match(between('    function updateModeToggle(){','    }'),/syncBack\(\)/,'view and workflow changes');
  assert.match(source,/onStepState: \(stepState\) => \{[^\n]*syncBack\(\);/,'step changes');
  assert.match(between('    function closeDocScreen(){','\n    }'),/syncBack\(\)/);
  assert.match(source,/modalWatchers\.delete\(syncBack\);\s*backHistory\?\.release\(\);/,'destroy takes the entries off');
});
