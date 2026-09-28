import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const root=new URL('../../libraries/platform-language/',import.meta.url);
const source=await fs.readFile(new URL('platform-language.js',root),'utf8');

test('browser loads shared and disabled-app catalogs, retries failures, and gates personal overrides',async()=>{
  const handlers=new Map(),events=[];
  let enabled=true,failOnce=true;
  const context={URL,Intl,console,location:{origin:'https://fixture.test'},document:{currentScript:{src:'https://fixture.test/libraries/platform-language/platform-language.js'},documentElement:{}},
    CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail;}},
    dispatchEvent:event=>events.push(event),addEventListener:(type,fn)=>handlers.set(type,fn),
    PlatformAPI:{localization:{get:async()=>({enabled,company:{locale:enabled?'en-GB':'en-US',measurement_system:'metric'},personal:{interface_locale:null}})}},
    fetch:async url=>{
      const file=new URL(url).pathname.split('/').pop();
      if(file.startsWith('equipment.')&&failOnce){failOnce=false;return {ok:false};}
      return {ok:true,json:async()=>JSON.parse(await fs.readFile(new URL('catalogs/'+file,root),'utf8'))};
    }};
  context.window=context;vm.runInNewContext(source,context);
  const language=context.PlatformLanguage;
  await language.refresh();
  assert.deepEqual(Array.from(language.supportedLanguages,pack=>pack.code),Array.from(language.supportedLocales));
  assert.ok(language.translationLanguages.some(language=>language.code==='en-US'));assert.ok(language.translationLanguages.some(language=>language.code==='en-GB'));
  assert.equal(language.companyContext().locale,'en-GB');
  assert.equal(context.document.documentElement.lang,'en-GB');
  await assert.rejects(language.ensure(['equipment']));
  await language.ensure(['equipment','crew','payroll','settings']);
  assert.ok(language.namespaces().includes('equipment'));assert.ok(language.namespaces().includes('crew'));assert.ok(language.namespaces().includes('payroll'));
  assert.equal(language.text('settings','m_6bb25348173069','Color palette'),'Colour palette');
  handlers.get('fm:user-preferences:updated')({detail:{preferences:{interface_locale:'en-US',language:'es'}}});
  assert.equal(language.context().locale,'en-US');assert.equal(language.context().measurement_system,'metric');
  enabled=false;await language.refresh();
  handlers.get('fm:user-preferences:updated')({detail:{preferences:{interface_locale:'en-GB'}}});
  assert.equal(language.context().locale,'en-US');
  assert.ok(events.some(event=>event.type==='fm:language:updated'));
});
