import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('portal includes Feed settings and an older shell loads the missing component with retry', async () => {
  const portal=await readFile(new URL('../../portal/index.php',import.meta.url),'utf8');
  const feedTag=portal.indexOf('<script src="../libraries/apps/settings/feed.js?');
  assert.ok(feedTag>=0 && feedTag<portal.indexOf('<script src="../libraries/apps/settings/company.js?'),'portal loads Feed settings before Company settings');
  const company=await readFile(new URL('../../libraries/apps/settings/company.js',import.meta.url),'utf8');
  const start=company.indexOf('    async function renderFeedSettings(){');
  const renderer=company.slice(start,company.indexOf('    function renderChannelsSettings()',start));
  const feed=await readFile(new URL('../../libraries/apps/settings/feed.js',import.meta.url),'utf8');
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    const page=await browser.newPage();
    let attempts=0;
    await page.route('https://feed-settings.test/**',async route=>{
      if(new URL(route.request().url()).pathname==='/libraries/apps/settings/feed.js') {
        if(++attempts===1)return route.abort('failed');
        return route.fulfill({contentType:'text/javascript',body:feed});
      }
      return route.fulfill({contentType:'text/html',body:'<main id="feed"></main>'});
    });
    await page.goto('https://feed-settings.test/');
    await page.evaluate(()=>{
      window.ChannelsAPI={feed:{settings:async()=>({settings:{revision:0,company_activity_types:null,department_activity_types:{}},departments:[],activity_options:[{type:'proposal.signed',label:'Proposal signed'}],default_activity_types:[]})}};
    });
    await page.addScriptTag({content:`const paneFeed=document.querySelector('#feed');const currentOrgId=()=> 'fixture';${renderer}window.openFeedSettings=renderFeedSettings;`});
    await page.evaluate(()=>window.openFeedSettings());
    await page.getByRole('button',{name:'Retry',exact:true}).waitFor();
    assert.equal(await page.locator('#feed').getAttribute('data-feed-mounted'),null);
    await page.getByRole('button',{name:'Retry',exact:true}).click();
    await page.getByRole('heading',{name:'Automatic posts',exact:true}).waitFor();
    assert.equal(attempts,2);
    assert.equal(await page.getByRole('button',{name:'Save settings',exact:true}).count(),0);
    await page.evaluate(()=>window.openFeedSettings());
    assert.equal(attempts,2,'opening an already mounted Feed does not reload its script');
  } finally {await browser.close();}
});

test('feed settings auto-save defaults, queue rapid edits, preserve other audiences on conflict and retry failures', async () => {
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1200,height:1000}}), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const company=await readFile(new URL('../../libraries/apps/settings/company.js',import.meta.url),'utf8');
    const switches=company.slice(company.indexOf('      .li-switch{'),company.indexOf('      .li-switch{')+1200).split('\n').filter(line=>/^\s*\.li-(switch|slider)/.test(line)).join('\n');
    await page.setContent(`<style>body{font:14px Arial;background:#f8fafc;padding:20px}.cs-btn{border:1px solid #d0d5dd;border-radius:8px;background:white;color:#344054;padding:8px 12px;cursor:pointer}${switches}</style><main id="settings"></main>`);
    await page.evaluate(()=>{
      window.savedSettings={company_activity_types:null,department_activity_types:{},revision:0};
      window.calls=[]; window.delay=0; window.fail=false; window.conflict=false;
      const types=['work.plan.started','work.plan.completed','work.node.completed','proposal.signed','contract.signed','project.event.completed','media.uploaded','media.shared','note.created','project.created','project.event_scheduled','crew.clock.in','crew.checklist.completed','payment.received','invoice.sent','communication.received','document.sent'];
      const labels={'proposal.signed':'Proposal signed','contract.signed':'Contract signed','project.event.completed':'Scheduled event completed','work.plan.started':'Scope started','work.plan.completed':'Scope completed','work.node.completed':'Task or stage completed'};
      const descriptions={'work.plan.started':'A scope instance started.','work.plan.completed':'A scope instance finished — every stage reached a terminal state.','work.node.completed':'A work item was completed.','project.event.completed':"A scheduled project event's window ended.",'document.sent':'A document was sent to the customer.'};
      window.fakeFeed={
        settings:async()=>({settings:structuredClone(window.savedSettings),departments:[{id:'sales',label:'Sales'},{id:'roofing',label:'Roofing'}],activity_options:types.map(type=>({type,label:labels[type] || type.replace(/[._]/g,' ').replace(/^./,char=>char.toUpperCase()),description:descriptions[type] || ''})),default_activity_types:['media.uploaded','note.created','project.created','project.event_scheduled','crew.checklist.completed','payment.received']}),
        saveSettings:async(_org,input)=>{
          window.calls.push(structuredClone(input));
          if(window.delay)await new Promise(resolve=>setTimeout(resolve,window.delay));
          if(window.fail)throw new Error('Connection interrupted. Try again.');
          if(window.conflict){window.conflict=false;window.savedSettings.department_activity_types.roofing=['invoice.sent'];window.savedSettings.revision++;throw new Error('Feed settings changed. Reload before saving.');}
          assertRevision(input.revision,window.savedSettings.revision);
          window.savedSettings={...structuredClone(input),revision:input.revision+1};
          return {settings:structuredClone(window.savedSettings)};
        }
      };
      function assertRevision(actual,expected){if(actual!==expected)throw new Error(`Unexpected revision ${actual}; expected ${expected}`);}
    });
    await page.addScriptTag({content:await readFile(process.env.FEED_SETTINGS_BROWSER_SCRIPT || new URL('../../libraries/apps/settings/feed.js',import.meta.url),'utf8')});
    await page.evaluate(()=>window.FirstMateFeedSettings.mount(document.querySelector('#settings'),{orgId:'org',api:window.fakeFeed}));
    assert.equal(await page.getByRole('button',{name:/Save settings/i}).count(),0);
    assert.equal(await page.getByText('All changes saved',{exact:true}).count(),0);
    assert.match(await page.locator('.cs-feed-heading').textContent(),/Feed permissions are managed in Users/);
    assert.doesNotMatch(await page.locator('.cs-feed-footer').textContent(),/Feed permissions/);
    for (const type of ['proposal.signed','contract.signed','project.event.completed']) assert.equal(await page.locator(`[data-feed-activity][value="${type}"]`).isChecked(),false);
    await mkdir('output',{recursive:true});
    await page.screenshot({path:'output/feed-settings-desktop.png',fullPage:true});
    await page.evaluate(()=>window.delay=650);
    await page.locator('[data-feed-activity][value="proposal.signed"]').locator('xpath=../..').click();
    await page.waitForFunction(()=>window.calls.length===1);
    await page.locator('[data-feed-activity][value="contract.signed"]').locator('xpath=../..').click();
    await page.locator('[data-feed-board]').selectOption('sales');
    await page.locator('[data-feed-activity][value="project.event.completed"]').locator('xpath=../..').click();
    await page.waitForFunction(()=>window.savedSettings.company_activity_types?.includes('contract.signed') && window.savedSettings.department_activity_types.sales?.includes('project.event.completed'));
    assert.equal(await page.locator('[data-feed-save-error]').isVisible(),false);
    assert.equal(await page.evaluate(()=>window.calls[1].revision),1,'queued edits use the returned revision');
    await page.evaluate(()=>{window.delay=0;window.conflict=true;});
    await page.locator('[data-feed-activity][value="proposal.signed"]').locator('xpath=../..').click();
    await page.waitForFunction(()=>window.savedSettings.department_activity_types.sales?.includes('proposal.signed'));
    assert.deepEqual(await page.evaluate(()=>window.savedSettings.department_activity_types.roofing),['invoice.sent'],'untouched audiences preserve another manager’s changes');
    await page.evaluate(()=>window.fail=true);
    await page.locator('[data-feed-activity][value="contract.signed"]').locator('xpath=../..').click();
    await page.getByRole('button',{name:'Retry',exact:true}).waitFor();
    assert.match(await page.locator('[data-feed-status]').textContent(),/Connection interrupted/);
    await page.evaluate(()=>window.fail=false);
    await page.getByRole('button',{name:'Retry',exact:true}).click();
    await page.waitForFunction(()=>window.savedSettings.department_activity_types.sales?.includes('contract.signed'));
    await page.getByRole('button',{name:'Use defaults',exact:true}).click();
    await page.waitForFunction(()=>!window.savedSettings.department_activity_types.sales.includes('contract.signed'));
    await page.getByRole('searchbox',{name:'Find activity'}).fill('contract signed');
    assert.equal(await page.locator('[data-feed-activity]').count(),1);
    await page.locator('[data-feed-activity][value="contract.signed"]').locator('xpath=../..').click();
    await page.waitForFunction(()=>window.savedSettings.department_activity_types.sales.includes('contract.signed'));
    assert.ok(await page.evaluate(()=>window.savedSettings.department_activity_types.sales.includes('media.uploaded')),'filtered edits preserve enabled activity outside the search');
    await page.getByRole('searchbox',{name:'Find activity'}).fill('no such activity');
    await page.getByText('No matching activity',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Clear search',exact:true}).click();
    await page.locator('[data-feed-category="documents"]').click();
    assert.equal(await page.locator('[data-feed-activity][value="media.uploaded"]').count(),0);
    assert.ok(await page.locator('[data-feed-activity][value="contract.signed"]').isChecked());
    await page.locator('[data-feed-category="all"]').click();
    await page.getByRole('button',{name:'Use defaults',exact:true}).click();
    await page.waitForFunction(()=>!window.savedSettings.department_activity_types.sales.includes('contract.signed'));
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:'output/feed-settings-mobile.png',fullPage:true});
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});
