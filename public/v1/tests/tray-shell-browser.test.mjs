import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('tray shell shares header chrome and retains accessible tab panels',async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://assistant-tray.test/**',route=>route.fulfill({contentType:'text/html',body:'<style>body{margin:0;font:14px Arial}.main{position:relative;height:100vh}</style><main class="main"><header id="platformTopbar" style="height:50px"></header><div id="mainPanels"></div></main>'}));
    await page.goto('https://assistant-tray.test');
    await page.evaluate(()=>{
      window.__APP={userOrgId:'org',userId:'user'};window.Portal={};
      const thread={id:'main',title:'Main thread'};
      window.AssistantAPI={context:async()=>({main_thread:thread,threads:[thread],agents:[],dashboard:[]}),thread:async()=>({thread,messages:[]})};
    });
    for(const file of ['window-manager/window-manager.js','window-manager/window-shell.js','platform-assistant/platform-assistant.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/'+file,import.meta.url),'utf8')});
    assert.equal(await page.evaluate(()=>typeof window.PlatformAssistant?.open),'function',errors.join('; '));
    await page.evaluate(()=>PlatformAssistant.open());
    const assistant=page.locator('#platformAssistantDrawer');await assistant.waitFor();
    assert.equal(await assistant.locator('.fm-tray-tabs').isVisible(),false);
    assert.equal(await assistant.locator('[data-tray-panel=assistant] .fma-body').count(),1);
    assert.match(await assistant.locator('.fma-tray-identity').innerText(),/Assistant/);
    if(process.env.TRAY_SHELL_SCREENSHOTS)await page.screenshot({path:process.env.TRAY_SHELL_SCREENSHOTS+'/assistant.png'});
    await page.evaluate(()=>{
      const element=document.createElement('aside');element.id='sampleTray';
      const header=document.createElement('header'),title=document.createElement('div'),body=document.createElement('div');
      title.textContent='Sample';body.textContent='First panel draft';header.append(title);element.append(header,body);document.querySelector('.main').append(element);
      window.sampleTray=FirstMateWindowShell.trayWindow({element,header,title,body,tabs:[{id:'first',label:'First',element:body},{id:'second',label:'Second'}]});
      const second=sampleTray.panel('second');const input=document.createElement('input');input.value='Retained draft';second.append(input);
    });
    const sample=page.locator('#sampleTray');
    assert.equal(await sample.locator('.fm-tray-tabs').isVisible(),true);
    assert.equal(await sample.locator('[data-tray-tab=first]').getAttribute('aria-selected'),'true');
    await sample.locator('[data-tray-tab=first]').focus();await page.keyboard.press('ArrowRight');
    assert.equal(await sample.locator('[data-tray-tab=second]').getAttribute('aria-selected'),'true');
    assert.equal(await sample.locator('[data-tray-panel=first]').isVisible(),false);
    assert.equal(await sample.locator('[data-tray-panel=second] input').inputValue(),'Retained draft');
    await page.keyboard.press('Home');
    assert.equal(await sample.locator('[data-tray-panel=first]').isVisible(),true);
    await page.evaluate(()=>sampleTray.unregister('second'));
    assert.equal(await sample.locator('.fm-tray-tabs').isVisible(),false);
    assert.equal(await sample.locator('[data-tray-panel=first]').isVisible(),true);
    const sizes=await page.evaluate(()=>[document.querySelector('#platformAssistantDrawer .fm-tray-header'),document.querySelector('#sampleTray .fm-tray-header')].map(header=>Math.round(header.getBoundingClientRect().height)));
    assert.deepEqual(sizes,[44,44]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
