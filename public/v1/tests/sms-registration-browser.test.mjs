import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const source = await readFile(process.env.SMS_SETTINGS_SOURCE || new URL('../../libraries/apps/settings/company.js', import.meta.url), 'utf8');
const workflow = source.slice(source.indexOf('    function formatPhoneUS(raw){'), source.indexOf('    function renderPricebook(){'));
const css = source.slice(source.indexOf('      .sms-card{'), source.indexOf('      .li-subtabs{'));
const wizard = await readFile(new URL('../../libraries/setup-wizard/setup-wizard.js', import.meta.url), 'utf8');

test('carrier registration remains a real wizard after simulated phone onboarding', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium'), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<style>body{font:14px Arial;background:#f3f4f6;margin:24px}main{background:white;padding:20px}${css}</style><main id="sms"></main>`);
    await page.addScriptTag({ content: wizard });
    await page.addScriptTag({ content: `
      window.__APP={userCompany:'Pioneer Puffin Test Co',userName:'Synthetic Owner',userEmail:'synthetic@example.test'};
      window.carrierMode=true;
      window.billingChecks=0;
      window.simulationChecks=0;
      window.saved=[];
      window.PlatformAPI={appFlags:{has:()=>true}};
      window.FirstMatePlatformBilling={setup:async()=>{window.billingChecks++;return true;}};
      window.Portal={currentUser:{name:'Synthetic Owner',email:'synthetic@example.test'},PhoneTray:{developmentSetup:async(el,callback)=>{window.simulationChecks++;callback?.({onboarded:true,destination:'+14259700671'});}}};
      const paneSms=document.querySelector('#sms');
      const state={};
      const canPlatformBilling=true;
      const currentOrgId=()=> 'org_pioneer';
      const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const readSettingsRoute=()=>({tab:'company_settings',sub:'sms'});
      const writeSettingsRoute=()=>{};
      const showToast=()=>{};
      const normalizeOrganizationBusinessAddress=()=>({});
      const organizationBusinessAddressFromState=()=>({});
      const formatOrganizationBusinessAddress=()=>'';
      const messagingRequest=async(url,options={})=>{
        if(url.endsWith('/sms/setup'))return {organization:{name:'Pioneer Puffin Test Co',contact:{email:'synthetic@example.test'}},profiles:[],telnyx:{configured:true,registration_live:window.carrierMode,live_mode:false}};
        window.saved.push({url,body:options.body});
        return {profile:{id:'draft_test',...options.body,events:[]}};
      };
      ${workflow}
      window.renderSmsFixture=renderSmsSettings;
      window.carrierDefaults=()=>mergeSmsProfile({});
    ` });
    await page.evaluate(() => window.renderSmsFixture());
    assert.equal(await page.evaluate(() => window.billingChecks), 0);
    assert.equal(await page.evaluate(() => window.simulationChecks), 0);
    assert.match(await page.locator('#sms').innerText(), /Carrier registration.*Low Volume Mixed/);
    await page.getByRole('button', { name: 'Set Up SMS Registration', exact: true }).click();
    await page.locator('[data-fm-wizard="sms-workflow"]').waitFor();
    assert.equal(await page.locator('[data-sms-field="brand.companyName"]').inputValue(), '');
    assert.equal(await page.locator('[data-sms-field="brand.displayName"]').inputValue(), '');
    assert.equal(await page.evaluate(() => window.carrierDefaults().campaign.usecase), 'LOW_VOLUME');
    assert.equal(await page.getByText('Fully onboarded for development').count(), 0);
    await mkdir('../../output/sms-registration', { recursive: true });
    await page.screenshot({ path: '../../output/sms-registration/desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    const pane = page.locator('[data-fm-wizard="sms-workflow"]');
    const box = await pane.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390);
    assert.equal(await page.locator('.fm-wizard-main').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    const nextButton = await page.getByRole('button', { name: 'Next', exact: true }).boundingBox();
    assert.ok(nextButton.x >= 0 && nextButton.x + nextButton.width <= 390);
    await page.screenshot({ path: '../../output/sms-registration/mobile.png' });
    await page.locator('[data-fm-step="contact"]').click();
    assert.equal(await page.locator('[data-sms-field="brand.email"]').inputValue(), '');
    await page.evaluate(() => { document.querySelector('.fm-wizard-backdrop')?.remove(); window.carrierMode=false; });
    await page.evaluate(() => window.renderSmsFixture());
    assert.equal(await page.evaluate(() => window.billingChecks), 1, 'the usual subscription setup still applies to other organizations');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
