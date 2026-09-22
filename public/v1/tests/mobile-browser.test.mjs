import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const executable=process.env.CHROME_PATH || (process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/google-chrome');
test('download settings and file selection work at desktop and phone widths',async()=>{
  const browser=await chromium.launch({executablePath:executable,headless:true});
  try {
    for(const width of [1440,390]) {
      const page=await browser.newPage({viewport:{width,height:900}});
      let developer=false;
      await page.route('https://mobile.test/**',async route=>{
        const url=new URL(route.request().url());
        if(url.pathname.endsWith('/config'))return route.fulfill({json:{stores:{android:'https://play.google.com/store/apps/details?id=example',ios:'https://apps.apple.com/app/example'},developer:developer?{android:'/v1/mobile/organizations/test/downloads/android',ios:null}:null}});
        if(url.pathname.endsWith('.js'))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(new URL('../../libraries/phone-features/'+url.pathname.split('/').pop(),import.meta.url),'utf8')});
        return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="download"></main><button id="photos" onclick="PhoneFeatures.pickFiles({multiple:true}).then(f=>document.querySelector(\'#result\').textContent=f.map(x=>x.name).join(\',\'))">Choose photos</button><output id="result"></output><script src="/phone-features.js"></script><script src="/app-download.js"></script><script>FirstMeasureAppDownload.mount(document.querySelector(\'#download\'),{orgId:\'test\'});</script>'});
      });
      await page.goto('https://mobile.test/');
      await page.getByRole('link',{name:'Google Play',exact:true}).waitFor();
      assert.equal(await page.getByText('Developer testing',{exact:true}).count(),0);
      assert.equal(await page.evaluate(()=>document.documentElement.hasAttribute('data-native-app')),false);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Choose photos'}).click();
      await(await chooser).setFiles([{name:'front.png',mimeType:'image/png',buffer:Buffer.from('photo fixture')},{name:'rear.png',mimeType:'image/png',buffer:Buffer.from('photo fixture')}]);
      await page.getByText('front.png,rear.png',{exact:true}).waitFor();
      developer=true;await page.reload();await page.getByRole('link',{name:'Download Android test build',exact:true}).waitFor();
      assert.equal(await page.getByRole('link',{name:'Download Android test build',exact:true}).getAttribute('href'),'/v1/mobile/organizations/test/downloads/android');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.close();
    }
  } finally {await browser.close();}
});
