import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
const root=path.resolve(import.meta.dirname,'../../..');
const coverage=JSON.parse(fs.readFileSync(path.join(root,'public/v1/platform/localization/coverage.json'),'utf8'));
let count=0;
for(const {file} of coverage.migration){
  const full=path.join(root,file),source=fs.readFileSync(full,'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),edits=[];
  function visit(node){
    if(ts.isCallExpression(node)||ts.isNewExpression(node)){
      const name=node.expression.getText(tree),args=node.arguments;
      if(args&&(/\.(toLocaleString|toLocaleDateString|toLocaleTimeString)$/.test(name)||/^Intl\.(NumberFormat|DateTimeFormat|ListFormat)$/.test(name))){
        const first=args[0];
        if(first&&ts.isStringLiteral(first)&&first.text==='en-US')edits.push({start:first.getStart(tree),end:first.end,text:'(globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US")'});
        else if(!first)edits.push({start:node.end-1,end:node.end-1,text:'globalThis.PlatformLanguage?.formatLocale?.()'});
      }
    }
    ts.forEachChild(node,visit);
  }
  visit(tree);if(!edits.length)continue;
  let updated=source;for(const edit of edits.sort((a,b)=>b.start-a.start))updated=updated.slice(0,edit.start)+edit.text+updated.slice(edit.end);
  if(ts.createSourceFile(file,updated,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS).parseDiagnostics.length)throw Error(file);
  const backup=path.join(root,'output/localization-before',file);
  if(!fs.existsSync(backup)){fs.mkdirSync(path.dirname(backup),{recursive:true});fs.writeFileSync(backup,source);}
  fs.writeFileSync(full,updated);count+=edits.length;
}
console.log({localeFormatters:count});
