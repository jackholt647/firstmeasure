import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import ts from 'typescript';
const root=path.resolve(import.meta.dirname,'../../..');
const files=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()&&!['node_modules','vendor','dist'].includes(e.name)?files(path.join(dir,e.name)):e.isFile()&&e.name.endsWith('.js')&&!/\.(min|bundle|umd)\.js$/.test(e.name)?[path.join(dir,e.name)]:[]);
const window={};vm.runInNewContext(fs.readFileSync(path.join(root,'public/libraries/platform-terminology/platform-terminology.js'),'utf8'),{window});
const keys=new Set(window.PlatformTerminology.CATALOG.flatMap(group=>group.terms.map(row=>`${group.id}.${row.key}`))),references=[],unknown=[];
for(const file of [...files(path.join(root,'public/libraries')),...files(path.join(root,'public/portal/scripts')), ...files(path.join(root,'public/customer_portal'))]){
const tree=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
function visit(node){let key,fallback;
if(ts.isCallExpression(node)&&/(?:terminology.*get|terminologyLabel|^terminology$)/i.test(node.expression.getText(tree))){key=node.arguments[0];fallback=node.arguments[1];}
if(ts.isPropertyAssignment(node)&&['terminologyKey','term','terminology_key'].includes(node.name.getText(tree)))key=node.initializer;
if(key&&ts.isStringLiteral(key)&&key.text){const item={key:key.text,fallback:fallback&&ts.isStringLiteral(fallback)?fallback.text:undefined,file:path.relative(root,file).replaceAll('\\','/'),line:tree.getLineAndCharacterOfPosition(key.getStart(tree)).line+1};references.push(item);if(!keys.has(key.text))unknown.push(item);}
ts.forEachChild(node,visit);}visit(tree);
}
console.log(JSON.stringify({terms:keys.size,references:references.length,unknown},null,2));if(unknown.length)process.exitCode=1;
