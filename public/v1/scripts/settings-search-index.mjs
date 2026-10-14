/** Generate settings discovery from JavaScript UI templates, without executing application code.
 * node scripts/settings-search-index.mjs [--check]
 * Unknown expressions are placeholders; only literal UI copy enters the public artifact.
 */
import ts from 'typescript';
import {chromium} from 'playwright-core';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=process.env.SETTINGS_SEARCH_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const unknown='FM_DYNAMIC', files=[];
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory()&&!['node_modules','vendor'].includes(e.name))await walk(f);else if(e.name.endsWith('.js')&&!/search(-index)?\.js$/.test(e.name))files.push(f);}}
await walk(path.join(root,'libraries'));
files.sort();
const companyFile=path.join(root,'libraries/apps/settings/company.js');
const sources=new Map();for(const file of files)sources.set(file,ts.createSourceFile(file,await readFile(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS));
const functions=new Map(), declarations=new Map();
function visit(node,fn){fn(node);ts.forEachChild(node,n=>visit(n,fn));}
for(const sf of sources.values())visit(sf,n=>{
 if(ts.isFunctionDeclaration(n)&&n.name)functions.set(sf.fileName+':'+n.name.text,n);
 if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)){
  const key=sf.fileName+':'+n.name.text;const list=declarations.get(key)||[];list.push(n);declarations.set(key,list);
 }
});
const ancestor=(node,predicate)=>{for(let p=node;p;p=p.parent)if(predicate(p))return p;};
function resolve(name,node){
 const candidates=declarations.get(node.getSourceFile().fileName+':'+name)||[];
 // Respect lexical scopes rather than conflating common names such as items and sections.
 for(let p=node;p;p=p.parent){const found=candidates.find(d=>d.parent?.parent===p||d.parent?.parent?.parent===p);if(found)return found.initializer;}
 return candidates.length===1?candidates[0].initializer:null;
}
let evaluationSteps=0;
function evaluate(node,env={},depth=0){
 if(!node||depth>16||++evaluationSteps>1600)return unknown;
 const ev=n=>evaluate(n,env,depth+1);
 if(ts.isStringLiteralLike(node)||ts.isNumericLiteral(node))return node.text;
 if(node.kind===ts.SyntaxKind.TrueKeyword)return true;
 if(node.kind===ts.SyntaxKind.FalseKeyword)return false;
 if(ts.isParenthesizedExpression(node))return ev(node.expression);
 if(ts.isIdentifier(node)){if(Object.hasOwn(env,node.text))return env[node.text];return ev(resolve(node.text,node));}
 if(ts.isTemplateExpression(node))return node.head.text+node.templateSpans.map(s=>String(ev(s.expression))+s.literal.text).join('');
 if(ts.isArrayLiteralExpression(node))return node.elements.flatMap(e=>ts.isSpreadElement(e)?(Array.isArray(ev(e.expression))?ev(e.expression):[]):[ev(e)]);

 if(ts.isObjectLiteralExpression(node))return Object.fromEntries(node.properties.filter(ts.isPropertyAssignment).map(p=>[p.name.text,ev(p.initializer)]));
 if(ts.isPropertyAccessExpression(node)){const obj=ev(node.expression);return obj&&typeof obj==='object'?obj[node.name.text]??unknown:unknown;}
 if(ts.isElementAccessExpression(node)){const obj=ev(node.expression),key=ev(node.argumentExpression);return obj&&typeof obj==='object'?obj[key]??unknown:unknown;}
 if(ts.isBinaryExpression(node)){
  const a=ev(node.left),b=ev(node.right),op=node.operatorToken.kind;
  if(op===ts.SyntaxKind.QuestionQuestionToken||op===ts.SyntaxKind.BarBarToken)return a===unknown?b:a;
  if(op===ts.SyntaxKind.PlusToken)return String(a)+String(b);
  return unknown;
 }
 if(ts.isConditionalExpression(node)){
  const condition=ev(node.condition);if(condition===true)return ev(node.whenTrue);if(condition===false)return ev(node.whenFalse);
  const a=ev(node.whenTrue),b=ev(node.whenFalse);
  if(Array.isArray(a)&&Array.isArray(b))return [...a,...b];
  return typeof a==='string'&&typeof b==='string'&&(/</.test(a)||/</.test(b))?a+b:unknown;
 }
 if(ts.isCallExpression(node)){
  const callee=node.expression, name=callee.getText(),args=node.arguments.map(ev);
  if(/PlatformLanguage\??\.(?:htmlText|text)$/.test(name))return args[2]??unknown;
  if(/^(?:String|escapeHtml|esc|clean)$/.test(name))return args[0]??unknown;
  if(/^(?:settingsText|t|text)$/.test(name))return args[1]??unknown;
  if(ts.isPropertyAccessExpression(callee)){
   const target=ev(callee.expression);
   if(callee.name.text==='join'&&Array.isArray(target))return target.join(args[0]===unknown?'':args[0]??',');
   if(callee.name.text==='map'&&Array.isArray(target)&&target.length<300){
    const callback=node.arguments[0];if(ts.isArrowFunction(callback)||ts.isFunctionExpression(callback))return target.map((value,index)=>invoke(callback,[value,index],env,depth+1));
   }
  }
  const fn=ts.isArrowFunction(callee)?callee:functions.get(node.getSourceFile().fileName+':'+name)||resolve(name,node);
  if(fn&&(ts.isFunctionDeclaration(fn)||ts.isArrowFunction(fn)||ts.isFunctionExpression(fn)))return invoke(fn,args,env,depth+1);
 }
 return unknown;
}
function invoke(fn,args,env,depth){
 const locals={...env};fn.parameters.forEach((p,i)=>{
  if(ts.isIdentifier(p.name))locals[p.name.text]=args[i]??unknown;
  if(ts.isArrayBindingPattern(p.name))p.name.elements.forEach((e,j)=>{if(e.name)locals[e.name.text]=args[i]?.[j]??unknown;});
  if(ts.isObjectBindingPattern(p.name))p.name.elements.forEach(e=>{locals[e.name.text]=args[i]?.[e.propertyName?.text||e.name.text]??unknown;});
 });
 if(!ts.isBlock(fn.body))return evaluate(fn.body,locals,depth+1);
 const ret=fn.body.statements.find(ts.isReturnStatement);return evaluate(ret?.expression,locals,depth+1);
}
const company=sources.get(companyFile);
let sections=[];visit(company,n=>{if(ts.isVariableDeclaration(n)&&n.name.getText()==='settingsSections')sections=n.initializer.elements.map(element=>{evaluationSteps=0;return evaluate(element);});});
sections=sections.filter(s=>s.id&&s.id!==unknown).map(s=>({id:s.id,title:s.title,description:s.subtitle,paneId:s.paneId}));
const functionViews=new Map(),symbolViews=new Map(),fileViews=new Map();
const functionSections=new Map(),symbolSections=new Map(),paneSections=new Map();
for(const section of sections)paneSections.set(section.paneId,section.id);
visit(company,n=>{
 if(ts.isIfStatement(n)){
  const match=n.expression.getText().match(/which\s*===\s*['"]([^'"]+)/);if(!match)return;
  visit(n.thenStatement,call=>{if(ts.isCallExpression(call)&&/^render\w+$/.test(call.expression.getText()))functionSections.set(call.expression.getText(),match[1]);});
 }
 if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&/^(pane[A-Z]|billingPane)/.test(n.name.text)&&n.initializer){for(const [pane,section] of paneSections)if(n.initializer.getText().includes("'#"+pane+"'"))paneSections.set(n.name.text,section);}
});
function companySection(node){
 for(let p=node;p&&p!==company;p=p.parent){
  if(ts.isFunctionDeclaration(p)&&functionSections.has(p.name?.text))return functionSections.get(p.name.text);
  if(ts.isIfStatement(p)||ts.isExpressionStatement(p)||ts.isVariableDeclaration(p)){
   const text=(ts.isIfStatement(p)?p.expression:p).getText();
   if(text.length<1200)for(const [name,section] of paneSections)if(new RegExp('\\b'+name+'\\b').test(text))return section;
  }
 }
 return null;
}
// Follow render helpers and pane aliases so lazily built controls inherit their owner.
for(let pass=0;pass<4;pass++){
 visit(company,n=>{
  if(ts.isBinaryExpression(n)&&ts.isIdentifier(n.left)&&/^(pane[A-Z]|billingPane)/.test(n.left.text))for(const [name,section]of paneSections)if(n.right.getText().length<200&&new RegExp('\\b'+name+'\\b').test(n.right.getText()))paneSections.set(n.left.text,section);
  if(ts.isFunctionDeclaration(n)&&n.name&&!functionSections.has(n.name.text)){
   const text=n.body?.getText()||'', owners=new Set();
   for(const [name,section]of paneSections)if(new RegExp('\\b'+name+'\\b').test(text))owners.add(section);
   if(owners.size===1)functionSections.set(n.name.text,[...owners][0]);
  }
 });
 for(const [key,fn]of functions){
  if(!key.startsWith(companyFile+':')||!functionSections.has(fn.name.text))continue;
  const owner=functionSections.get(fn.name.text);
  visit(fn.body,n=>{if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&/^(render|draw)[A-Z]/.test(n.expression.text)&&!functionSections.has(n.expression.text))functionSections.set(n.expression.text,owner);});
 }
}
visit(company,n=>{
 if(ts.isIfStatement(n)){
  const match=n.expression.getText().match(/nextView\s*===\s*['"]([^'"]+)/);if(match)visit(n.thenStatement,c=>{if(ts.isCallExpression(c)&&/^render\w+$/.test(c.expression.getText()))functionViews.set(c.expression.getText(),match[1]);});
 }
});
visit(company,n=>{
 if(ts.isCallExpression(n)){
  const match=n.expression.getText().match(/window\.(\w+)\??\.(?:mount|render|setView)/),section=companySection(n);
  if(match&&section){const owners=symbolSections.get(match[1])||new Set();owners.add(section);symbolSections.set(match[1],owners);const fn=ancestor(n,p=>ts.isFunctionDeclaration(p));if(functionViews.has(fn?.name?.text))symbolViews.set(match[1],functionViews.get(fn.name.text));const branch=ancestor(n,p=>ts.isIfStatement(p)&&/nextView\s*===/.test(p.expression.getText()));const view=branch?.expression.getText().match(/nextView\s*===\s*['"]([^'"]+)/)?.[1];if(view)symbolViews.set(match[1],view);}
 }
});
const fileSections=new Map([[companyFile,null]]);
for(const [file,sf]of sources){
 if(file===companyFile)continue;
 const name=path.basename(file,'.js');let section=file.startsWith(path.join(root,'libraries/apps/settings'))?sections.find(s=>s.id===name)?.id:undefined;
 for(const [symbol,ids] of symbolSections)if(new RegExp('(?:window|root)\\.'+symbol+'\\s*=').test(sf.text)){section=[...ids][0];if(symbolViews.has(symbol))fileViews.set(file,symbolViews.get(symbol));}
 if(file.includes(path.join('apps','people')))section='people';
 if(section)fileSections.set(file,section);
}
// Discover additional settings-owned modules through the mounted global export (no hand-maintained page list).
const snippets=[],objects=[],inputs=[];
for(const [file,section]of fileSections){
 const sf=sources.get(file);if(process.env.SEARCH_INDEX_DEBUG)console.error('Reading',path.relative(root,file));inputs.push([path.relative(root,file).replaceAll('\\','/'),createHash('sha256').update(sf.text.replaceAll('\r\n','\n')).digest('hex')]);
 const viewIds=[...sf.text.matchAll(/data-[\w-]+-(?:view|subtab|tab)=["']([\w-]+)["']/g)].map(m=>m[1]);
 visit(sf,n=>{
  evaluationSteps=0;
  if(!(ts.isTemplateExpression(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isObjectLiteralExpression(n)||(ts.isBinaryExpression(n)&&ts.isPropertyAccessExpression(n.left)&&n.left.name.text==='textContent')))return;
  const owner=section||companySection(n);if(!owner)return;
  const fn=ancestor(n,p=>ts.isFunctionDeclaration(p));const fnName=fn?.name?.text||'';
  const view=fileViews.get(file)||functionViews.get(fnName)||viewIds.find(v=>fnName.toLowerCase()===('render'+v).toLowerCase())||'';
  const registeredView=sf.text.match(/\.views\.register\(['"]([^'"]+)['"]/);
  const context={section:owner,tab:sections.find(s=>s.id===owner)?.title||owner,view:registeredView?.[1]||view,source:path.relative(root,file).replaceAll('\\','/')};
  if(ts.isTemplateExpression(n)||ts.isNoSubstitutionTemplateLiteral(n)){
   if(!n.getText().includes('<'))return;
   const html=evaluate(n);if(typeof html==='string'&&/<(?:label|input|select|textarea|h[1-6]|summary|button)\b/i.test(html))snippets.push({...context,html});
  }
  if(ts.isBinaryExpression(n)&&ts.isPropertyAccessExpression(n.left)&&n.left.name.text==='textContent'){
   const target=resolve(n.left.expression.getText(),n);
   if(!target||!/^document\.createElement\(['"]h[1-6]['"]\)$/.test(target.getText()))return;
   const value=evaluate(n.right);if(typeof value==='string'&&!value.includes(unknown)&&value.length>2&&value.length<150)objects.push({...context,title:value,description:'',kind:'heading',selector:''});
  }
  if(ts.isObjectLiteralExpression(n)){
   const props=new Map(n.properties.filter(ts.isPropertyAssignment).map(p=>[p.name.text,p.initializer]));
   // Declarative control lists (including report toggles) are UI source too.
   if(!props.has('label')||!(props.has('key')||props.has('id')))return;
   let title=evaluate(props.get('label'));
   if(title===unknown){const label=props.get('label');const fn=ts.isIdentifier(label)?resolve(label.text,label):label;if(fn&&(ts.isArrowFunction(fn)||ts.isFunctionExpression(fn)))title=invoke(fn,[],{},0);}
   const key=evaluate(props.get('key')||props.get('id'));
   if(typeof title!=='string'||title.includes(unknown)||typeof key!=='string'||key.includes(unknown))return;
   const desc=evaluate(props.get('tip')||props.get('description')||props.get('help'));
   let translation;
   visit(props.get('label'),c=>{if(ts.isCallExpression(c)&&/PlatformLanguage.*\.text$/.test(c.expression.getText())){const a=c.arguments.map(x=>evaluate(x));if(a.slice(0,3).every(x=>typeof x==='string'&&!x.includes(unknown)))translation=a.slice(0,3);}});
   const declaration=ancestor(n,p=>ts.isVariableDeclaration(p));
   const isView=props.has('id')&&(viewIds.includes(key)||/views/i.test(declaration?.name?.getText()||''));
   objects.push({...context,view:isView?key:context.view,title,description:desc===unknown?'':desc,kind:isView?'view':'control',selector:props.has('key')?`[data-key="${key}"]`:'',...(translation?{translation}:{})});
  }
 });
}
console.error('Extracting',snippets.length,'templates',snippets.reduce((n,s)=>n+s.html.length,0),'bytes from',inputs.length,'sources');
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'chrome'}:{}),headless:true});let extracted=[];
try{
 const page=await browser.newPage();await page.addScriptTag({path:path.join(root,'libraries/apps/settings/search.js')});
 extracted=await page.evaluate(snippets=>{
  const rows=[];
  for(const {html,...context}of snippets){
   // Detached documents cannot execute scripts or issue image/network requests.
   const template=document.createElement('template');template.innerHTML=html;
   const host=document.createElement('div');host.append(template.content);
   rows.push(...window.FirstMateSettingsSearch.extract(host,context).map(({element,...entry})=>entry));
  }
  return rows;
 },snippets);
}finally{await browser.close();}
const entries=new Map();
for(const s of sections)entries.set(s.id,{section:s.id,tab:s.title,title:s.title,description:s.description,view:'',kind:'section',selector:''});
for(const item of [...objects,...extracted]){
 if(!item.title||item.title.includes(unknown)||item.title.length>150)continue;
 const key=[item.section,item.view,item.title.toLowerCase()].join('|'),old=entries.get(key);
 if(!old||(!old.selector&&item.selector))entries.set(key,item);
}
const output={version:1,inputs,entries:[...entries.values()].sort((a,b)=>a.section.localeCompare(b.section,'en')||a.title.localeCompare(b.title,'en'))};
const content='/* Generated by public/v1/scripts/settings-search-index.mjs. Do not edit. */\nwindow.FirstMateSettingsIndex = '+JSON.stringify(output,null,2)+';\n';
const destination=path.join(root,'libraries/apps/settings/search-index.js');
if(process.argv.includes('--check')){
 if(await readFile(destination,'utf8')!==content)throw Error('Settings search index is stale. Run node scripts/settings-search-index.mjs');
}else await writeFile(destination,content);
console.log(JSON.stringify({entries:output.entries.length,sources:inputs.length,sections:sections.map(s=>({id:s.id,entries:output.entries.filter(e=>e.section===s.id).length}))},null,2));
