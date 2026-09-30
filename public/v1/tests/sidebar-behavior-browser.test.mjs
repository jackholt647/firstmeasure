import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const core = await readFile(new URL('../../portal/scripts/core.js', import.meta.url), 'utf8');
const index = await readFile(new URL('../../portal/index.php', import.meta.url), 'utf8');
const code = core.slice(core.indexOf('  const SIDEBAR_WIDTH_DEFAULT'), core.indexOf('  function syncVisualViewportVars'));
const styles = [...index.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n') + (core.match(/@media\(min-width:821px\)\{\.sidebar\.sidebar-compact:not\(\.sidebar-manual\)[^\n]+/)?.[0] || '');
test('hover collapse, locked positions, and forced sidebar modes', async () => {
 const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true});
 try {
  const page = await browser.newPage({viewport:{width:1280,height:850}});
  await page.setContent(`<style>${styles}\n:root{--sidebar:250px;--sidebar-compact:48px}.sidebar{position:absolute;left:0;top:0;height:700px;transition:none!important}</style><aside class="sidebar apps-list-enabled" id="mainSidebar"><div class="sidebar-resize-edge" id="sidebarResizeEdge"></div><button class="sidebar-compact-toggle" id="sidebarCompactToggle"><i></i></button><div class="sidebar-panel" id="sidebarAppsPanel" hidden><button>Apps</button></div><div class="sidebar-panel active" id="sidebarChannelsPanel"><button>Channels</button></div></aside>`);
  await page.addScriptTag({content:`const APP={userId:'user',orgId:'org'};window.Portal={currentUser:{identity:{preferences:{left_column_auto_collapse:{apps:true},resizable_left_column:true}}}};window.savedPatches=[];window.PlatformAPI={preferences:{patch:async patch=>{savedPatches.push(patch);return {preferences:{...Portal.currentUser.identity.preferences,...patch}};}}};function setSidebarPanel(){}function applySidebarFeatureFlags(){applySidebarLayoutFeatureFlags();}${code}\napplySidebarLayoutFeatureFlags();`});
  const width=()=>page.locator('#mainSidebar').evaluate(n=>Math.round(n.getBoundingClientRect().width));
  const prefs=patch=>page.evaluate(patch=>window.dispatchEvent(new CustomEvent('fm:user-preferences:updated',{detail:{preferences:{...Portal.currentUser.identity.preferences,...patch}}})),patch);
  assert.equal(await width(),48);
  assert.equal(await page.locator('#sidebarAppsPanel').isVisible(),true);
  assert.equal(await page.locator('#sidebarChannelsPanel').isVisible(),false);
  await page.mouse.move(20,100);assert.equal(await width(),250);
  await page.evaluate(()=>Portal.sidebarMode.setExpanded(true));
  await page.locator('#sidebarCompactToggle').click();assert.equal(await width(),48,'collapse overrides hover');
  await page.mouse.move(700,100);await page.mouse.move(20,100);assert.equal(await width(),250);
  await prefs({left_column_behavior:'locked',left_column_locked_expanded:false});assert.equal(await width(),48);
  await page.mouse.move(700,100);await page.mouse.move(20,100);assert.equal(await width(),48);
  await page.locator('#sidebarCompactToggle').click();assert.equal(await width(),250);
  await page.mouse.move(700,100);assert.equal(await width(),250);
  await page.locator('#sidebarCompactToggle').click();assert.equal(await width(),48);
  await page.waitForFunction(()=>savedPatches.length===2);
  assert.deepEqual(await page.evaluate(()=>savedPatches),[{left_column_locked_expanded:true},{left_column_locked_expanded:false}]);
  await prefs({left_column_behavior:'locked',left_column_locked_expanded:true});
  await page.evaluate(()=>{
   const patch=PlatformAPI.preferences.patch;
   PlatformAPI.preferences.patch=async value=>{
    if(value.sidebar_width){window.widthSaveStarted=true;return new Promise(resolve=>{window.finishWidthSave=()=>resolve({preferences:{...Portal.currentUser.identity.preferences,left_column_locked_expanded:true,sidebar_width:value.sidebar_width}});});}
    return patch(value);
   };
  });
  await page.mouse.move(250,100);await page.mouse.down();await page.mouse.move(300,100);await page.mouse.up();
  await page.waitForFunction(()=>window.widthSaveStarted);
  await page.locator('#sidebarCompactToggle').focus();await page.keyboard.press('Enter');assert.equal(await width(),48);
  await page.evaluate(()=>window.finishWidthSave());
  await page.waitForFunction(()=>savedPatches.length>=3 && savedPatches.at(-1).left_column_locked_expanded===false);
  await page.waitForFunction(()=>Portal.currentUser.identity.preferences.sidebar_width===300);
  assert.equal(await width(),48,'late resize response must preserve the newer locked-closed choice');
  for(const [behavior,expected] of [['forced_collapsed',48],['forced_expanded',300]]){
   await prefs({left_column_behavior:behavior});await page.mouse.move(700,100);await page.mouse.move(20,100);
   await page.evaluate(()=>{Portal.sidebarMode.setExpanded(true);Portal.sidebarMode.requestCompact('editor');document.getElementById('mainSidebar').classList.add('sidebar-advanced-apps-open');});
   assert.equal(await width(),expected);
   assert.equal(await page.locator('#sidebarAppsPanel').isVisible(),behavior==='forced_collapsed');
   assert.equal(await page.locator('#sidebarCompactToggle').isVisible(),false);
   assert.equal(await page.locator('#sidebarResizeEdge').isVisible(),false);
  }
 }finally{await browser.close();}
});
