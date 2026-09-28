import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

test('frozen report dictionaries retain a new pack locale for text and numbers',async()=>{
  const root={};vm.runInNewContext(await readFile(new URL('../../libraries/report-units.js',import.meta.url),'utf8'),{window:root});
  const units=root.ReportUnits.create({report_language:'fr-FR',measurement_system:'metric',language_snapshot:{locale:'fr-FR',report_dictionary:{color:'couleur'}}});
  assert.equal(units.text('color'),'couleur');
  assert.equal(units.number(10,'ft',2),new Intl.NumberFormat('fr-FR',{maximumFractionDigits:2}).format(3.048));
});

test('settings share installed choices, broader translation targets and an accessible help icon',async()=>{
  const {chromium}=await import('playwright-core');
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),headless:true});
  const source=await readFile(new URL('../../libraries/apps/settings/company.js',import.meta.url),'utf8');
  const helper=source.slice(source.indexOf('  function languageOptions('),source.indexOf('  const DEFAULT_LOGO'));
  const begin=source.indexOf('<section class="company-settings-card" aria-labelledby="csLocalizationHeading">');
  const card=source.slice(begin,source.indexOf('</section>',begin)+10);
  const registry=JSON.parse(await readFile(new URL('../platform/localization/languages.json',import.meta.url),'utf8'));
  const output=fileURLToPath(new URL('../../../output/language-settings-ui/',import.meta.url));await mkdir(output,{recursive:true});
  try{
    const page=await browser.newPage({viewport:{width:900,height:600}});
    await page.setContent('<style>body{font:15px Arial;background:#f7f8fa;padding:20px}.company-settings-card{background:white;border:1px solid #ddd;border-radius:14px;max-width:640px}.company-settings-card-head{display:flex;justify-content:space-between;align-items:center;padding:16px}.company-settings-card-help{font-style:normal;cursor:help}.company-settings-card-help:before{content:"ⓘ"}.company-settings-card-body{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px}.cs-field{display:grid;gap:8px}select{padding:10px;min-width:0;width:100%}@media(max-width:500px){.company-settings-card-body{grid-template-columns:1fr}}</style><main></main><label>Interface language<select id="interface"></select></label><label>Message translation<select id="translation"></select></label>');
    await page.evaluate(({registry,helper,card})=>{
      window.PlatformLanguage={supportedLanguages:registry.packs,translationLanguages:registry.translation_targets,companyContext:()=>({locale:'en-GB'}),text:(_ns,_key,fallback)=>fallback};
      const escapeHtml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const options=new Function('window','escapeHtml',helper+';return languageOptions;')(window,escapeHtml);
      document.querySelector('main').innerHTML=new Function('window','state','escapeHtml','languageOptions','return `'+card+'`;')(window,{report_preferences:{report_language:'en-GB'}},escapeHtml,options);
      document.querySelector('#interface').innerHTML=options(null,{inherit:true});
      document.querySelector('#translation').innerHTML=options(null,{inherit:true,translation:true});
    },{registry,helper,card});
    const choices=await page.evaluate(()=>Object.fromEntries(['csReportLanguage','interface','translation'].map(id=>[id,[...document.getElementById(id).options].map(o=>o.value)])));
    assert.deepEqual(choices.csReportLanguage,choices.interface.filter(Boolean));
    assert.deepEqual(choices.csReportLanguage,['en-US','en-GB']);
    assert.ok(choices.translation.includes('fr')&&choices.translation.includes('es'));
    assert.ok(choices.translation.includes('en-US')&&choices.translation.includes('en-GB'));
    assert.equal(await page.locator('#translation').inputValue(),'');
    assert.match(await page.locator('#translation option:checked').innerText(),/company language.*English \(UK\)/);
    assert.equal(await page.locator('main .cs-note').count(),0);
    await page.locator('[aria-label="About company language and measurements"]').focus();
    assert.match(await page.locator('[data-fm-tooltip]').getAttribute('data-fm-tooltip'),/documents, PDFs and FirstMeasure reports/);
    for(const width of [900,390]){await page.setViewportSize({width,height:600});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(output,`settings-${width}.png`)});}
  }finally{await browser.close();}
});
