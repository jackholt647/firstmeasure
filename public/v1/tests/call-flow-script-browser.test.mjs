import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// Call scripts are flows (docs/architecture/flows.md, "The call surface"). The call panel plays the call's run in the
// flow player, keeps that player across its own redraws, shows observers a read-only summary, pre-fills the wrap-up
// from the run's outcome, and offers the lead's open run before a call starts.
test('the call panel plays its flow run, keeps the player across redraws, and pre-fills the wrap-up from the outcome',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
    page.on('pageerror',e=>errors.push(e.stack||e.message));
    await page.route('https://calls.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><style>body{margin:0;font-family:Arial}</style><main></main>'}));
    await page.goto('https://calls.test');
    await page.evaluate(()=>{
      window.__APP={orgId:'org-test',userId:'user-test'};
      window.Portal={appFlags:{has:()=>true},modules:{},navigation:{registerSchema(){},registerHandler(){},push(){}}};
      window.mounts=[];window.destroyed=0;window.posts=[];
      const outcome={run_id:'flowrun_1',flow_id:'inbound',outcome_id:'later',label:'Call back later',color:'#f59e0b',disposition:'callback',next_action:'none'};
      const call=(id,owner)=>({id,owner_user_id:owner,mode:'external',direction:'outbound',state:'ended',wrap_up_state:'draft',revision:3,customer_name:'Ada',customer_number:'+12065550100',project_id:'project-one',
        notes:'',metadata:{flow_run_id:'flowrun_1',flow:{id:'inbound',version:1,name:'Inbound script'}},result:{flow_outcome:outcome}});
      window.calls={'call-1':call('call-1','user-test'),'call-2':call('call-2','someone-else')};
      const summary={id:'flowrun_1',name:'Inbound script',status:'done',step:{id:'result',title:'How did it go?'},answers:[{key:'need',label:'What do you need?',value:'A repair'}],outcome:{id:'later',label:'Call back later',color:'#f59e0b'}};
      window.CommsAPI={customer:async(_org,path,body)=>{
        if(path==='voice/status')return {settings:{enabled:false,require_disposition:true},permissions:{}};
        if(path.startsWith('call-context'))return {projects:[{contacts:[]}]};
        if(path==='calls'&&body){window.posts.push(body);return {call:{...window.calls['call-1'],id:'call-new',state:'created',metadata:{flow_run_id:body.flow_run_id||''},result:{}}};}
        const match=path.match(/^calls\/([^/?]+)$/);
        if(match)return {call:window.calls[match[1]]||window.calls['call-1'],flow_run:summary,participants:[],operations:[],permissions:{}};
        if(/^calls\/[^/]+\/follow-up-options$/.test(path))return {outcomes:[],suggestions:{}};
        return {};
      },customerUrl:(_org,path)=>`https://calls.test/${path}`};
      window.FirstMateFlows={
        api:async path=>path==='/flows'?{flows:[{id:'inbound',name:'Inbound script',kind:'call',published_version:1,latest_version:1,archived:false},{id:'draft',name:'Draft script',kind:'call',published_version:0,latest_version:1,archived:false}]}
          :path.startsWith('/runs?project_id=project-one')?{runs:[{id:'flowrun_open',flow_id:'inbound',status:'open',project_id:'project-one'}]}:{},
        mount:(el,options)=>{window.mounts.push({runId:options.runId,surface:options.surface});el.innerHTML='<div class="fmf" data-player><textarea data-key="notes"></textarea></div>';return {destroy(){window.destroyed++;}};}
      };
    });
    for(const file of ['communications-ui.js','calling-runtime.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/comms/'+file,import.meta.url),'utf8')});
    await page.addStyleTag({content:await readFile(new URL('../../libraries/apps/comms/communications.css',import.meta.url),'utf8')});

    await page.evaluate(()=>Portal.CustomerPhone.open({call_id:'call-1'}));
    await page.waitForSelector('[data-flow-slot] [data-player]');
    assert.deepEqual(await page.evaluate(()=>window.mounts),[{runId:'flowrun_1',surface:'call'}],'the owner plays the run in the call surface');
    assert.equal(await page.locator('[name=disposition]').inputValue(),'callback','the wrap-up is pre-filled from the outcome');
    assert.match(await page.locator('[data-flow-outcome]').innerText(),/Call back later/);
    await page.evaluate(()=>{document.querySelector('[data-player]').dataset.same='yes';});
    await page.locator('[data-player] textarea').fill('About the roof');
    assert.equal(await page.evaluate(()=>Portal.CustomerPhone.state.notes),'','an answer in the script never becomes the call notes');
    await page.evaluate(()=>Portal.CustomerPhone.open({call_id:'call-1'}));
    assert.equal(await page.locator('[data-flow-slot] [data-player][data-same=yes]').count(),1,'the same player survives the redraw');
    assert.equal(await page.evaluate(()=>window.mounts.length),1);
    await page.locator('[name=disposition]').selectOption('answered');
    await page.evaluate(()=>Portal.CustomerPhone.open({call_id:'call-1'}));
    assert.equal(await page.locator('[name=disposition]').inputValue(),'answered','a person\'s change to the pre-filled outcome is kept');

    // An observer reads the script: no player, a summary of where it is and what was answered.
    await page.evaluate(()=>{Portal.CustomerPhone.state.call.wrap_up_state='saved';});
    await page.evaluate(()=>Portal.CustomerPhone.open({call_id:'call-2'}));
    await page.waitForSelector('[data-flow-summary]');
    assert.equal(await page.evaluate(()=>window.mounts.length),1);
    assert.equal(await page.evaluate(()=>window.destroyed),1,'the previous call\'s player is closed');
    assert.match(await page.locator('[data-flow-summary]').innerText(),/Inbound script[\s\S]*Call back later[\s\S]*What do you need\?\s*A repair/);

    // Before a call: the lead's open run is offered first (published call flows after it); starting carries it on.
    await page.evaluate(()=>{Portal.CustomerPhone.state.call.wrap_up_state='saved';});
    await page.evaluate(()=>Portal.CustomerPhone.open({project_id:'project-one',customer_number:'+12065550100',customer_name:'Ada'}));
    await page.waitForFunction(()=>document.querySelector('[name=flow_choice] option[value="run:flowrun_open"]'));
    assert.equal(await page.locator('[name=flow_choice]').inputValue(),'run:flowrun_open');
    assert.deepEqual(await page.locator('[name=flow_choice] option').allTextContents(),['No script','Continue: Inbound script','Inbound script']);
    await page.locator('[data-phone=start]').click();
    await page.waitForFunction(()=>window.posts.length===1);
    assert.equal(await page.evaluate(()=>window.posts[0].flow_run_id),'flowrun_open');
    assert.equal(await page.evaluate(()=>window.posts[0].flow_id),undefined);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
