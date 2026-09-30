import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

test('Doc Studio shares logo editing, fonts and serialized autosaves in a responsive Brand Kit', async () => {
  const source = await readFile(new URL('../../libraries/apps/documents/studio.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('    async function loadBrandKit(){'), source.indexOf('    function renderLists(){'));
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1050,height:800}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('http://brand.test/**',route=>route.request().url()==='http://brand.test/' ? route.fulfill({contentType:'text/html',body:'<html></html>'}) : route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#992244"/></svg>'}));
    await page.goto('http://brand.test/');
    await page.setContent('<html><body style="font-family:Arial"><main id="brand"></main></body></html>');
    await page.addStyleTag({content:await readFile(new URL('../../libraries/brand-kit/brand-kit.css',import.meta.url),'utf8')});
    await page.addStyleTag({content:await readFile(new URL('../../libraries/apps/documents/documents.css',import.meta.url),'utf8')});
    await page.evaluate(()=>{
      const branding={logo:'legacy.png',logo_node_url:'http://brand.test/primary.svg',colors:{primary:'#992244',secondary:'#123456'},typography:{document_font_family:'Lato'},logo_display:{shape:'circle'}};
      window.branch={branding,unrelated:'preserved'};window.style={branding:{}};window.toasts=[];window.saves=[];
      window.PlatformAPI={
        orgs:{portalState:async()=>({global:{data:{branding:{}}},organization:{data:{branding:{}}}}),patchGlobal:async()=>({ok:true})},
        branches:{get:async()=>({data:structuredClone(window.branch)}),save:async(_org,_branch,data)=>{window.branch=structuredClone(data);window.saves.push(data);}},
        branchModules:{get:async()=>({data:structuredClone(window.style)}),save:async(_org,_branch,_module,data)=>{window.style=structuredClone(data);}},
        brandingMedia:{list:async()=>({media:[{id:'alt',slot:'alternate_logo',src:'http://brand.test/alt.svg'}]}),imageRef:(_org,item)=>({src:item.src,thumb:item.src,media_id:item.id,label:'Alternate'})}
      };
    });
    await page.addScriptTag({content:await readFile(new URL('../../libraries/brand-kit/brand-kit.js',import.meta.url),'utf8')});
    await page.addScriptTag({content:await readFile(new URL('../../libraries/color-picker/firstmate-color-picker.js',import.meta.url),'utf8')});
    await page.addScriptTag({content:`
      const state={brandKit:null,destroyed:true,tab:'brand-kit'};
      const orgId=()=> 'org',brandBranchId=()=> 'default';
      const objectValue=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{},arrayValue=v=>Array.isArray(v)?v:[];
      const firstText=(...v)=>v.find(x=>typeof x==='string'&&x.trim())||'';
      const brandHex=(v,f)=>/^#[0-9a-f]{6}$/i.test(v||'')?v.toUpperCase():f;
      const errorMessage=(e,f)=>e?.message||f,showToast=(...v)=>window.toasts.push(v),render=()=>{};
      ${functions}
      window.applyBrandFonts=applyFontToBlankDocument;
      window.ready=loadBrandKit().then(()=>renderBrandKit(document.querySelector('#brand')));
    `});
    await page.evaluate(()=>window.ready);
    await page.waitForSelector('[data-brand-primary]');
    assert.equal(await page.locator('#dsLogoPreviewImg').getAttribute('src'),'http://brand.test/primary.svg');
    assert.equal(await page.locator('#dsLogoAdvanced').getAttribute('open'),'');
    assert.equal(await page.locator('[data-brand-save]').count(),0);
    await page.locator('#dsBrandFont').selectOption('Inter');
    await page.locator('#dsSeparateTitleFont').check();
    await page.locator('#dsTitleFont').selectOption('Poppins');
    await page.locator('#dsPrimaryHex').fill('224466');
    await page.locator('#dsPrimaryHex').dispatchEvent('change');
    await page.waitForFunction(()=>window.branch.branding.typography?.display_font_family==='Poppins');
    assert.equal(await page.evaluate(()=>window.branch.branding.colors.primary),'#224466');
    assert.equal(await page.evaluate(()=>window.branch.unrelated),'preserved');
    await page.locator('[data-brand-primary]').click();
    await page.waitForFunction(()=>window.branch.branding.logo==='http://brand.test/alt.svg');
    assert.equal(await page.locator('#dsLogoPreviewImg').getAttribute('src'),'http://brand.test/alt.svg');
    await page.locator('#dsGeneratePalette').click();
    await page.waitForFunction(()=>window.branch.branding.colors.palette.includes('#A0283C'));
    const styled=await page.evaluate(()=>window.applyBrandFonts({styles:{'Normal text':{},Title:{},'Heading 1':{}}}));
    assert.equal(styled.styles.Title.font.family,'Poppins');
    assert.equal(styled.styles['Normal text'].font.family,'Inter');
    const boxes=await page.evaluate(()=>['.company-brand-stack','.company-brand-row>.company-settings-card'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {height:r.height,top:r.top};}));
    assert.ok(Math.abs(boxes[0].height-boxes[1].height)<2);
    await mkdir(new URL('../../../output/brand-kit/',import.meta.url),{recursive:true});
    await page.screenshot({path:new URL('../../../output/brand-kit/desktop.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
    await page.setViewportSize({width:390,height:800});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:new URL('../../../output/brand-kit/mobile.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
    await page.locator('[data-palette-direct="3"]').click();
    await page.locator('.fm-color-picker [data-hex]').fill('#556677');
    await page.locator('.fm-color-picker [data-hex]').fill('#667788');
    await page.waitForFunction(()=>window.branch.branding.colors.palette[3]==='#667788');
    await page.screenshot({path:new URL('../../../output/brand-kit/color-picker.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
    await page.locator('.fm-color-done').click();
    await page.locator('#dsSeparateTitleFont').uncheck();
    await page.waitForFunction(()=>window.branch.branding.typography.display_font_family==='');
    const unified=await page.evaluate(()=>window.applyBrandFonts({styles:{Title:{}}}));
    assert.equal(unified.styles.Title.font.family,'Inter');
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
