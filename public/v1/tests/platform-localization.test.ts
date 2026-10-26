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

test("a fallback is interpolated exactly as the same catalog message would be", () => {
  const message="Create a new project for {address}";
  const withCatalog=createLanguage(),withoutCatalog=createLanguage();
  withCatalog.register({version:"0123456789abcdef",namespaces:{projects:{"en-US":{create_for:{format:"icu",message},photo_count:{format:"icu",message:"{count, plural, one {# photo} other {# photos}}"},m_saved:{format:"icu",message:"Saved {value}"}}}}});
  const cases:[string,string,Record<string,any>][]=[
    ["create_for",message,{address:"12 O'Brien St {unit}"}],
    ["photo_count","{count, plural, one {# photo} other {# photos}}",{count:1}],
    ["photo_count","{count, plural, one {# photo} other {# photos}}",{count:1200}],
    ["m_saved","Saved {value}",{value:1200}],
    ["create_for",message,{}],
    ["create_for",message,{other:"x"}]
  ];
  for(const [key,fallback,values] of cases){
    assert.equal(withoutCatalog.text("projects",key,fallback,values),withCatalog.text("projects",key,fallback,values),`text ${key} ${JSON.stringify(values)}`);
    assert.equal(withoutCatalog.htmlText("projects",key,fallback,values),withCatalog.htmlText("projects",key,fallback,values),`htmlText ${key} ${JSON.stringify(values)}`);
  }
  assert.equal(withoutCatalog.text("projects","create_for",message,{address:"12 Main St"}),"Create a new project for 12 Main St");
  assert.equal(withoutCatalog.text("projects","photo_count","{count, plural, one {# photo} other {# photos}}",{count:3}),"3 photos");
  assert.equal(withoutCatalog.text("projects","m_saved","Saved {value}",{value:1200}),"Saved 1200");
  // A missing value leaves the message as written on both paths.
  assert.equal(withoutCatalog.text("projects","create_for",message,{other:"x"}),message);
  // No values, or a fallback that is not a message, is returned unchanged.
  assert.equal(withoutCatalog.text("projects","absent","Use {braces"),"Use {braces");
  assert.equal(withoutCatalog.text("projects","absent","Use {braces",{braces:1}),"Use {braces");
  assert.equal(withoutCatalog.text("projects","absent","Zoom {level}"),"Zoom {level}");
  assert.equal(withoutCatalog.text("projects","absent","Zoom {level}",{level:"2x"}),"Zoom 2x");
});

test("htmlText escapes terminology, never supplied values, on both paths", () => {
  const terms={localized_labels:{"en-US":{projects:{project:"R&D <Job>"}}}};
  const withCatalog=createLanguage(),withoutCatalog=createLanguage();
  for(const language of [withCatalog,withoutCatalog]){
    language.register({version:"t",namespaces:{terminology:{"en-US":{"projects.project":"Project"}}}});
    language.setTerminology(terms);
  }
  withCatalog.register({version:"t",namespaces:{projects:{"en-US":{for:{format:"icu",message:"For {name}"}}}}});
  // Values are inserted as given: an HTML caller escapes them, and they are never escaped twice.
  for(const language of [withCatalog,withoutCatalog]){
    assert.equal(language.htmlText("projects","for","For {name}",{name:"&lt;b&gt;Ann &amp; Co"}),"For &lt;b&gt;Ann &amp; Co");
    assert.equal(language.text("projects","for","For {name}",{name:"<b>Ann & Co"}),"For <b>Ann & Co");
  }
  withCatalog.register({version:"t2",namespaces:{projects:{"en-US":{name_project:{format:"icu",message:"Project {name}"}}}}});
  assert.equal(withCatalog.htmlText("projects","name_project","",{name:"North"}),"R&amp;D &lt;Job&gt; North");
  // A fallback may carry caller-built text, so it is not rewritten by terminology.
  assert.equal(withoutCatalog.htmlText("projects","name_project","Project {name}",{name:"North"}),"Project North");
});

test("non-English catalog gaps are reported once while retaining English fallback", () => {
  const missing:string[]=[];
  const ja=createLanguage(resolveContext({locale:"ja-JP"}), key=>missing.push(key));
  ja.register({version:"0123456789abcdef",namespaces:{settings:{"en-US":{preview:"Report preview"},"ja-JP":{}}}});
  assert.equal(ja.text("settings","preview"),"Report preview");
  assert.equal(ja.text("settings","preview"),"Report preview");
  assert.deepEqual(missing,["settings.preview"]);
  ja.register({version:"0123456789abcdee",namespaces:{settings:{"en-US":{preview:"Report preview"},"ja-JP":{preview:"レポートプレビュー"}}}});
  assert.equal(ja.text("settings","preview"),"レポートプレビュー");
  assert.equal(missing.length,1);
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
