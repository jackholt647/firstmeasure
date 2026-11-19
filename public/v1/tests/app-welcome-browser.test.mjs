import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { libraryEntries } from '../config-library/library.ts';
// Every app's welcome, as the library holds it (kind app_welcome).
const APP_WELCOMES = Object.fromEntries(libraryEntries('app_welcome').map(entry => [entry.id, structuredClone(entry.data)]));

const source=(await readFile(new URL('../../libraries/app-runtime/app-welcome.js',import.meta.url),'utf8')).replaceAll('export function','function');
const output=new URL('../../../output/app-welcome-tests/',import.meta.url);
await mkdir(output,{recursive:true});

test('activation refreshes guides before the host mounts and fades the advertisement away',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage();
    await page.setContent('<main id="root" style="height:600px"></main>');
    await page.addScriptTag({content:source+'\nwindow.mountWelcome=mountWelcome;'});
    await page.evaluate(welcome=>{
      window.__APP={userOrgId:'org_test'};window.steps=[];
      window.PlatformAPI={request:async()=>{steps.push('activate');return {};},capabilities:{load:async()=>{}},appFlags:{load:async()=>{}}};
      window.FirstMateGuides={refresh:async()=>{steps.push('guides');}};
      window.Portal={auth:{syncPlatformSession:async()=>{
        steps.push('mount');window.handle.destroy();
        document.getElementById('root').innerHTML='<section id="actual-app">Ready</section>';
        window.dispatchEvent(new CustomEvent('fm:embeddable-apps:app-mounted',{detail:{appId:'project.photos',context:{entitlement:{offered:false}}}}));
      }}};
      window.handle=window.mountWelcome({appId:'project.photos',orgId:'org_test',roots:{main:document.getElementById('root')},entitlement:{welcome},preload:async()=>{steps.push('preload');}});
    },APP_WELCOMES['project.photos']);
    await page.waitForFunction(()=>steps.includes('preload'));
    await page.getByRole('button',{name:'Get Started'}).click();
    await page.waitForSelector('#actual-app');
    await page.waitForFunction(()=>!document.querySelector('.fm-app-welcome'));
    assert.deepEqual(await page.evaluate(()=>steps),['preload','activate','guides','mount']);
  }finally{await browser.close();}
});

test('an app with no welcome of its own shows the placeholder (FM-468)',async()=>{
  const { placeholderWelcome } = await import('../platform/app-experience/offers.ts');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1100,height:760}});
    await page.setContent('<main id="root" style="height:700px"></main>');
    await page.addScriptTag({content:source+'\nwindow.mountWelcome=mountWelcome;'});
    await page.evaluate(welcome=>{window.handle=window.mountWelcome({appId:'portal.stats',orgId:'org_test',roots:{main:document.getElementById('root')},entitlement:{welcome}});},
      placeholderWelcome({id:'portal.stats',title:'Stats'}));
    assert.equal(await page.locator('.fm-app-welcome').getAttribute('data-theme'),'generic');
    assert.equal(await page.locator('.fm-app-welcome h1').textContent(),'Stats');
    assert.equal(await page.locator('.faw-free').count(),0,'a placeholder makes no promise about price');
    assert.equal(await page.locator('.faw-benefits li').count(),3);
    await page.getByRole('button',{name:'Get Started'}).waitFor();
    await page.screenshot({path:new URL('placeholder.png',output).pathname});
  }finally{await browser.close();}
});

test('designed welcome screens fit phones and desktops and only activate on Get Started',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    for(const width of [360,1100]) for(const [appId,welcome] of Object.entries(APP_WELCOMES)){
      const page=await browser.newPage({viewport:{width,height:850}});
      await page.setContent('<html><body style="margin:0"><main id="root" style="height:100vh"></main></body></html>');
      await page.evaluate(()=>{
        window.__APP={userOrgId:'org_test'};window.activations=0;window.startedEvents=0;window.failStart=true;
        window.PlatformAPI={request:async()=>{window.activations++;if(window.failStart)throw Error('Please try again.');return {ok:true};},capabilities:{load:async()=>({})},appFlags:{load:async()=>({})}};
        window.Portal={auth:{syncPlatformSession:async()=>({})}};
        window.addEventListener('fm:app-offer:started',()=>window.startedEvents++);
      });
      await page.addScriptTag({content:source+'\nwindow.mountWelcome=mountWelcome;'});
      await page.evaluate(({appId,welcome})=>window.handle=window.mountWelcome({appId,orgId:'org_test',roots:{main:document.getElementById('root')},entitlement:{offered:true,welcome}}),{appId,welcome});
      assert.equal(await page.locator('h1').textContent(),welcome.headline.text);
      assert.equal(await page.locator('.faw-benefits li').count(),3);
      if(!welcome.setup)assert.equal(await page.locator('.faw-free').textContent(),'Free Forever','the pill never suggests a trial (FM-364)');
      assert.equal(await page.evaluate(()=>window.activations),0,'reading the advertisement never activates the app');
      assert.equal(await page.evaluate(()=>document.querySelector('.fm-app-welcome').scrollWidth<=innerWidth),true);
      await page.screenshot({path:new URL(`${welcome.theme}-${width}.png`,output).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
      await page.getByRole('button',{name:'Get Started'}).click();
      await page.waitForFunction(()=>document.querySelector('.faw-error').textContent);
      assert.equal(await page.locator('.faw-start').isEnabled(),true);
      assert.equal(await page.evaluate(()=>window.startedEvents),0);
      await page.evaluate(()=>window.failStart=false);
      await page.getByRole('button',{name:'Get Started'}).click();
      await page.waitForFunction(()=>window.startedEvents===1);
      assert.equal(await page.evaluate(()=>window.activations),2);
      await page.close();
    }
  }finally{await browser.close();}
});

test('the runtime mounts only the welcome and keeps New without starting a tutorial',async()=>{
  const runtime=await readFile(new URL('../../libraries/app-runtime/firstmate-embeddable-apps.js',import.meta.url),'utf8');
  const guides=await readFile(new URL('../../libraries/tab-guides/tab-guides.js',import.meta.url),'utf8');
  const module=await readFile(new URL('../../libraries/app-runtime/app-welcome.js',import.meta.url),'utf8');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage();
    await page.route('https://welcome.test/**',route=>{
      const url=new URL(route.request().url());
      const body=url.pathname.endsWith('photos.js')?`window.bundleLoads=(window.bundleLoads||0)+1;FirstMateEmbeddableApps.registerApp({id:'project.photos',surfaces:['project_modal'],enabled:()=>false,access:{capability:'platform.project_photos'},mount(){window.operationalMounts++;}});`:url.pathname.endsWith('app-welcome.js')?module:url.pathname.endsWith('runtime.js')?runtime:'<html><body><main id="root"></main></body></html>';
      return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':'text/html',body});
    });
    await page.goto('https://welcome.test/');
    await page.evaluate(welcome=>{
      window.operationalMounts=0;window.openEvents=0;
      window.Portal={currentUser:{identity:{preferences:{seen_tabs:['project.photos']}},appEntitlements:[{id:'project.photos',allowed:true,offered:true,welcome,visible:{desktop:true,mobile:true}}]}};
      window.addEventListener('fm:project-tab:opened',()=>window.openEvents++);
    },APP_WELCOMES['project.photos']);
    await page.addScriptTag({url:'https://welcome.test/runtime.js'});
    await page.addScriptTag({content:guides});
    const result=await page.evaluate(async()=>{
      FirstMateEmbeddableApps.registerManifest({id:'project.photos',surfaces:['project_modal'],bundles:['https://welcome.test/photos.js']});
      FirstMateEmbeddableApps.registerApp({id:'project.photos',surfaces:['project_modal']});
      const listed=FirstMateEmbeddableApps.listApps({surface:'project_modal'});
      await FirstMateEmbeddableApps.mount(document.getElementById('root'),'project.photos',{surface:'project_modal',orgId:'test'});
      FirstMateTabGuides.opened({appId:'project.photos'});
      return {count:listed.length,mounts:window.operationalMounts,events:window.openEvents,pill:FirstMateTabGuides.pill('project.photos')?.kind};
    });
    assert.deepEqual(result,{count:1,mounts:0,events:0,pill:'new'});
    assert.equal(await page.getByRole('button',{name:'Get Started'}).count(),1);
    await page.waitForFunction(()=>window.bundleLoads===1);
    assert.equal(await page.evaluate(()=>window.operationalMounts),0,'preloading registers code without mounting the offered app');
  }finally{await browser.close();}
});

// The project window keeps one handle per tab: Get Started must leave nothing of the advertisement behind, whether
// the host remounts the root (the runtime replaces the welcome), mounts the real app over it without destroying the
// welcome, or drops the panel. A tour waits for the cover (FirstMateAppWelcome.settled).
test('the advertisement is gone once the real app mounts, and the cover ends if its panel leaves the page',async()=>{
  const runtime=await readFile(new URL('../../libraries/app-runtime/firstmate-embeddable-apps.js',import.meta.url),'utf8');
  const module=await readFile(new URL('../../libraries/app-runtime/app-welcome.js',import.meta.url),'utf8');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    for(const mode of ['remount','overwrite','detached']){
      const page=await browser.newPage();
      await page.route('https://welcome.test/**',route=>{
        const url=new URL(route.request().url());
        const body=url.pathname.endsWith('app-welcome.js')?module:url.pathname.endsWith('runtime.js')?runtime:'<html><body><div id="panel"><main id="root" style="height:500px"></main></div></body></html>';
        return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':'text/html',body});
      });
      await page.goto('https://welcome.test/');
      await page.evaluate(({welcome,mode})=>{
        window.__APP={userOrgId:'org_test'};
        const entitlement=offered=>({id:'project.photos',allowed:true,offered,...(offered?{welcome}:{}),visible:{desktop:true,mobile:true}});
        window.PlatformAPI={request:async()=>({}),capabilities:{load:async()=>{}},appFlags:{load:async()=>{}}};
        window.Portal={currentUser:{appEntitlements:[entitlement(true)]},auth:{syncPlatformSession:async()=>{
          window.Portal.currentUser.appEntitlements=[entitlement(false)];
          const root=document.getElementById('root');
          if(mode==='remount')await FirstMateEmbeddableApps.mount(root,'project.photos',{surface:'project_modal',orgId:'org_test'});
          if(mode==='overwrite'){root.insertAdjacentHTML('beforeend','<section id="actual-app">Ready</section>');window.dispatchEvent(new CustomEvent('fm:embeddable-apps:app-mounted',{detail:{appId:'project.photos',context:{roots:{main:root},entitlement:{offered:false}}}}));}
          if(mode==='detached')document.getElementById('panel').remove();
        }}};
      },{welcome:APP_WELCOMES['project.photos'],mode});
      await page.addScriptTag({url:'https://welcome.test/runtime.js'});
      await page.evaluate(async()=>{
        FirstMateEmbeddableApps.registerApp({id:'project.photos',surfaces:['project_modal'],mount(context){context.roots.main.insertAdjacentHTML('beforeend','<section id="actual-app">Ready</section>');return {destroy(){}};}});
        await FirstMateEmbeddableApps.mount(document.getElementById('root'),'project.photos',{surface:'project_modal',orgId:'org_test'});
      });
      await page.getByRole('button',{name:'Get Started'}).click();
      await page.waitForFunction(()=>window.FirstMateAppWelcome&&!window.FirstMateAppWelcome.pending()&&!document.querySelector('.fm-app-welcome-cover'),null,{timeout:3000});
      assert.equal(await page.locator('.fm-app-welcome').count(),0,`${mode}: no advertisement is left`);
      if(mode!=='detached')assert.equal(await page.locator('#actual-app').count(),1,`${mode}: the real app shows`);
      assert.equal(await page.evaluate(()=>document.querySelector('.fm-app-welcome-host')),null);
      await page.close();
    }
  }finally{await browser.close();}
});

// FM-481: on a phone the advertisement is the whole portal tab (no shell padding around it, one scroller), and an app
// that adds its page beside the host's "Loading…" placeholder never sits under it.
test('on a phone the advertisement fills the portal tab and no app is left under the loading placeholder',async()=>{
  const runtime=await readFile(new URL('../../libraries/app-runtime/firstmate-embeddable-apps.js',import.meta.url),'utf8');
  const module=await readFile(new URL('../../libraries/app-runtime/app-welcome.js',import.meta.url),'utf8');
  const shell='<html><body style="margin:0"><style>.main-panels{height:100vh;box-sizing:border-box;overflow:auto;padding:22px}@media(max-width:820px){.main-panels{padding:12px}}.fm-tabpanel{display:none}.fm-tabpanel.active{display:block;height:100%}.fm-tab-loading{height:100%;min-height:220px}</style>'
    +'<div class="main-panels" id="mainPanels"><div class="fm-tabpanel active" id="tab_feedback"><div class="fm-tab-loading" role="status">Loading Feedback…</div></div></div></body></html>';
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    for(const offered of [true,false]) for(const width of [412,1100]){
      const page=await browser.newPage({viewport:{width,height:800}});
      await page.route('https://welcome.test/**',route=>{
        const url=new URL(route.request().url());
        const body=url.pathname.endsWith('app-welcome.js')?module:url.pathname.endsWith('runtime.js')?runtime:shell;
        return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':'text/html',body});
      });
      await page.goto('https://welcome.test/');
      await page.evaluate(({welcome,offered})=>{
        window.__APP={userOrgId:'org_test'};
        window.PlatformAPI={request:async()=>({}),capabilities:{load:async()=>{}},appFlags:{load:async()=>{}}};
        window.Portal={currentUser:{appEntitlements:[{id:'portal.feedback',allowed:true,offered,...(offered?{welcome}:{}),visible:{desktop:true,mobile:true}}]},auth:{syncPlatformSession:async()=>{}}};
      },{welcome:APP_WELCOMES['project.photos'],offered});
      await page.addScriptTag({url:'https://welcome.test/runtime.js'});
      await page.evaluate(async()=>{
        FirstMateEmbeddableApps.registerApp({id:'portal.feedback',surfaces:['portal_tab'],mount(context){const host=document.createElement('div');host.id='actual-app';host.textContent='Ready';context.roots.main.appendChild(host);return {destroy(){host.remove();}};}});
        await FirstMateEmbeddableApps.mount(document.getElementById('tab_feedback'),'portal.feedback',{surface:'portal_tab',orgId:'org_test'});
      });
      const label=`${offered?'offered':'started'} at ${width}px`;
      assert.equal(await page.locator('.fm-tab-loading').count(),0,`${label}: the loading placeholder is gone`);
      if(!offered){assert.equal(await page.locator('#actual-app').count(),1,`${label}: the app shows`);await page.close();continue;}
      const layout=await page.evaluate(()=>{const panels=document.getElementById('mainPanels'),rect=document.querySelector('.fm-app-welcome').getBoundingClientRect();return {left:rect.left,right:rect.right,top:rect.top,padding:getComputedStyle(panels).paddingLeft,scrolls:panels.scrollHeight>panels.clientHeight};});
      assert.equal(layout.scrolls,false,`${label}: the advertisement scrolls itself; the shell never adds a second scroll`);
      if(width<=820)assert.deepEqual([layout.left,layout.top,layout.right,layout.padding],[0,0,width,'0px'],`${label}: edge to edge`);
      else assert.equal(layout.padding,'22px',`${label}: the desktop shell keeps its padding`);
      await page.close();
    }
  }finally{await browser.close();}
});

// GP-39: the advertisement is white and drawn in the organization's colours: the primary leads (Get Started, the FirstMate
// mark, drawn from an inline mask so it never waits for an image), the secondary, darkened until it reads on white, is the
// accent (eyebrow, checks). "Free Forever" stays green.
test('the advertisement is white and in the organization\'s primary and secondary colours',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:433,height:870}});
    await page.setContent('<html style="--primary:#2f4fb5;--primary-readable:#2f4fb5;--on-primary:#ffffff;--secondary:#f2a900"><body style="margin:0"><main id="root" style="height:100vh"></main></body></html>');
    await page.addScriptTag({content:source+'\nwindow.mountWelcome=mountWelcome;'});
    await page.evaluate(welcome=>{window.handle=window.mountWelcome({appId:'project.materials',orgId:'org_test',roots:{main:document.getElementById('root')},entitlement:{offered:true,welcome}});},APP_WELCOMES['project.materials']);
    const colours=()=>page.evaluate(()=>{
      const article=document.querySelector('.fm-app-welcome'),style=element=>getComputedStyle(article.querySelector(element));
      const second=getComputedStyle(article).getPropertyValue('--offer-second').match(/\d+/g).map(Number);
      const lum=second.map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
      return {background:getComputedStyle(article).backgroundColor,eyebrow:style('.faw-eyebrow').color,check:style('.faw-benefits svg').stroke,secondary:`rgb(${second.join(', ')})`,button:style('.faw-start').backgroundColor,
        logo:style('.faw-logo').backgroundColor,mask:style('.faw-logo').maskImage,images:article.querySelectorAll('.faw-brand img').length,
        free:style('.faw-free').backgroundColor,contrast:1.05/(lum+.05),art:style('.faw-art').backgroundImage};
    });
    const before=await colours();
    assert.equal(before.background,'rgb(255, 255, 255)','white, never cream');
    assert.equal(before.eyebrow,before.secondary,'the secondary is the accent');
    assert.equal(before.check,before.secondary);
    assert.equal(before.button,'rgb(47, 79, 181)');
    assert.equal(before.logo,'rgb(47, 79, 181)','the FirstMate mark takes the organization\'s colour');
    assert.match(before.mask,/^url\("data:image\/png;base64,/);
    assert.equal(before.images,0);
    assert.equal(before.free,'rgb(230, 242, 233)','Free Forever stays green');
    assert.ok(before.contrast>=4.5,`a light secondary is darkened until it reads on white (${before.contrast})`);
    await page.evaluate(()=>{document.documentElement.style.setProperty('--secondary','#7a1fa2');window.dispatchEvent(new CustomEvent('fm:theme:updated'));});
    const after=await colours();
    assert.notEqual(after.eyebrow,before.eyebrow,'a theme change repaints the secondary');
    await page.screenshot({path:new URL('org-colours-433.png',output).pathname});
    assert.match(await page.evaluate(()=>getComputedStyle(document.querySelector('.fm-app-welcome')).getPropertyValue('--offer-second')),/rgb\(122,\s*31,\s*162\)/);
  }finally{await browser.close();}
});
