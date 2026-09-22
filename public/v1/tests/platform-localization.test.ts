import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { IntlMessageFormat } from "intl-messageformat";
import { createLanguage, resolveContext } from "../platform/localization/core.js";
import { serverLanguage } from "../platform/localization/server.js";

test("interface override leaves company units, currency and message language independent", () => {
  assert.deepEqual(resolveContext(), { locale:"en-US", measurement_system:"imperial" });
  assert.deepEqual(resolveContext({ locale:"en-GB",measurement_system:"metric",currency:"USD" }, {interface_locale:"en-US",language:"es"}), {locale:"en-US",measurement_system:"metric",currency:"USD"});
  assert.equal(resolveContext({locale:"en-GB"},{interface_locale:null}).locale,"en-GB");
  assert.equal(resolveContext({locale:"unsupported"}).locale,"en-US");
});

test("ICU plurals, values, fallback and tenant isolation", () => {
  const missing:string[]=[];
  const gb=createLanguage(resolveContext({locale:"en-GB"}), key=>missing.push(key));
  const us=createLanguage();
  const bundle={version:"0123456789abcdef",namespaces:{shared:{"en-US":{name:"Color",count:{format:"icu" as const,message:"{count, plural, =0 {No items} one {# item} other {# items}}"},m_test:{format:"icu" as const,message:"Saved {value}"}},"en-GB":{name:"Colour"}}}};
  gb.register(bundle);us.register(bundle);
  assert.equal(gb.text("shared","name"),"Colour");assert.equal(us.text("shared","name"),"Color");
  assert.equal(gb.text("shared","count","",{count:0}),"No items");assert.equal(gb.text("shared","count","",{count:2}),"2 items");
  assert.equal(gb.text("shared","m_test","",{value:false}),"Saved false");
  assert.equal(gb.text("shared","m_test","",{value:"Color <img> {count}"}),"Saved Color <img> {count}");
  assert.equal(gb.text("shared","absent","fallback"),"fallback");gb.text("shared","absent","fallback");assert.equal(missing.length,1);
  assert.equal(gb.text("shared","count","safe fallback"),"safe fallback");
});

test("terminology remains scoped to locale and snapshots are detached", () => {
  const mappings={labels:{ui:{projects:"Jobs"}},localized_labels:{"en-GB":{ui:{projects:"Works"}}}};
  const gb=createLanguage(resolveContext({locale:"en-GB"})),us=createLanguage();
  assert.equal(gb.term("ui.projects","Projects",mappings),"Works");assert.equal(us.term("ui.projects","Projects",mappings),"Jobs");
  const saved=gb.snapshot(mappings);mappings.localized_labels["en-GB"].ui.projects="Changed";
  assert.equal(saved.terminology.localized_labels?.["en-GB"]?.ui?.projects,"Works");
  assert.equal(gb.money(12,"USD"),new Intl.NumberFormat("en-GB",{style:"currency",currency:"USD"}).format(12));
  assert.equal(gb.date("2026-09-21T12:00:00Z",{timeZone:"UTC"}),"21/09/2026");
});

test("every shipped message parses, English baselines are exact, frozen server catalogs survive preference changes", async () => {
  const root=new URL("../../libraries/platform-language/catalogs/",import.meta.url);
  const manifest=JSON.parse(await readFile(new URL("manifest.json",root),"utf8"));
  let count=0;
  const parameters=(message:any):string[]=>{
    if(typeof message==='string')return [];
    const names=new Set<string>();
    const visit=(nodes:any[])=>nodes.forEach(node=>{if(node.type>=1&&node.type<=6)names.add(node.value);if(node.options)Object.values(node.options).forEach((option:any)=>visit(option.value));if(node.children)visit(node.children);});
    visit(new IntlMessageFormat(message.message,'en-US',undefined,{ignoreTag:true}).getAst());return [...names].sort();
  };
  for(const [namespace,file] of Object.entries(manifest.namespaces)){
    const bundle=JSON.parse(await readFile(new URL(String(file),root),"utf8"));
    const engine=createLanguage();engine.register(bundle);
    for(const [locale,catalog] of Object.entries(bundle.namespaces[namespace])){
      for(const [key,message] of Object.entries(catalog as any)){
        if(locale!=='en-US')assert.deepEqual(parameters(message),parameters(bundle.namespaces[namespace]['en-US'][key]),`Translation parameters: ${namespace}.${key}`);
        assert.doesNotMatch(typeof message==='string'?message:(message as any).message, /(?:font-size|background|display):/, 'Styles must never become translatable text');
        if(typeof message==='string'){ if(locale==='en-US')assert.equal(engine.text(namespace,key),message); }
        else new IntlMessageFormat((message as any).message,locale,undefined,{ignoreTag:true});
        count++;
      }
    }
  }
  assert.ok(count>7000);
  const gb=await serverLanguage(resolveContext({locale:"en-GB"}),["reports"]);
  const frozen=gb.snapshot();
  assert.equal((await serverLanguage(resolveContext(),["reports"],frozen)).text("reports","color"),"colour");
  await assert.rejects(serverLanguage(resolveContext(),["../secrets"]));
});

test("document harness embeds frozen language before widgets and preserves US and authored content", async () => {
  const { buildRenderHarnessHtml } = await import("../documents/render.js");
  const input = { resolved_definition:{pages:[]}, theme:{}, themeContext:{}, widgetData:{}, scope:{ customer:"Color Center <script>alert(1)</script>" }, title:"Fixture" };
  const baseline = await buildRenderHarnessHtml(input);
  const us = (await serverLanguage(resolveContext(), ["doc-widgets", "doc-renderer"])).snapshot();
  assert.equal(await buildRenderHarnessHtml({...input,language_snapshot:us}), baseline);
  const gb = (await serverLanguage(resolveContext({locale:"en-GB"}), ["doc-widgets", "doc-renderer"])).snapshot();
  const localized = await buildRenderHarnessHtml({...input,language_snapshot:gb});
  assert.ok(localized.includes('PlatformLanguage.configure({context:'));
  assert.ok(localized.includes('"locale":"en-GB"'));
  assert.ok(localized.includes('Color Center \\u003cscript>'));
  assert.ok(!localized.includes('<script>alert(1)</script>'));
  assert.ok(localized.indexOf('PlatformLanguage.configure({context:') < localized.indexOf(' * FirstMate doc-widgets'));
});
