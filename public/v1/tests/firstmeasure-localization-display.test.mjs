import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
const root=new URL('../../../',import.meta.url),read=p=>fs.readFileSync(new URL(p,root),'utf8');
function functions(file,names){const code=read(file),tree=ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true),found=[];function visit(n){if(ts.isFunctionDeclaration(n)&&names.includes(n.name?.text))found.push(n.getText(tree));ts.forEachChild(n,visit);}visit(tree);assert.equal(found.length,names.length);return found.join('\n');}
test('translated display preserves numeric summary values and authored data across every supported locale',()=>{
 const names=['formatSummaryNumber','summaryMetricNumber','summaryMetricLabel'],code=functions('public/libraries/apps/measurements/project.js',names),locales=JSON.parse(read('public/v1/platform/localization/languages.json')).packs.map(p=>p.code);
 for(const locale of locales){const context={Intl,PlatformLanguage:{companyContext:()=>({locale}),text:(_ns,key)=>'translated:'+key}};vm.createContext(context);vm.runInContext(code,context);
  assert.equal(context.formatSummaryNumber(1234.56,2),'1,234.56');
  assert.equal(context.summaryMetricNumber('1,234.56'),new Intl.NumberFormat(locale,{maximumFractionDigits:2}).format(1234.56));
  assert.equal(context.summaryMetricNumber('6/12'),'6/12');
  assert.equal(context.summaryMetricLabel('Customer authored note'),'Customer authored note');
  assert.match(context.summaryMetricLabel('Roof squares'),/^translated:/);
 }
});
test('project timestamps use company language and retain the timestamp instant',()=>{
 const code=functions('public/portal/scripts/core.js',['formatDate']);for(const locale of ['ja-JP','de-DE','en-US']){const context={Intl,PlatformLanguage:{companyContext:()=>({locale})}};vm.createContext(context);vm.runInContext(code,context);const date=new Date('2026-10-06T20:49:00Z'),expected=new Intl.DateTimeFormat(locale,{year:'numeric',month:'long',day:'numeric',hour:'numeric',minute:'2-digit'}).format(date);assert.equal(context.formatDate('2026-10-06 20:49:00'),expected);assert.equal(context.formatDate('2026-10-06T15:49:00-05:00'),expected);assert.equal(context.formatDate('invalid'),'');}
});
test('localization does not replace keyboard commands, HTTP header keys or metric identifiers',()=>{
 const viewer=read('public/libraries/apps/projects/viewer.js'),tree=ts.createSourceFile('viewer.js',viewer,ts.ScriptTarget.Latest,true);function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(tree).includes('PlatformLanguage')&&n.arguments.length>=3){const fallback=n.arguments[2];if(ts.isStringLiteral(fallback))assert(!['ArrowLeft','ArrowRight','ArrowDown','ArrowUp','Home','End','Enter','Escape','Accept','Range','Content-Type'].includes(fallback.text));}ts.forEachChild(n,visit);}visit(tree);
 assert(read('public/v1/scripts/localization-catalogs.mjs').includes("'bodyHtml'"));
});
