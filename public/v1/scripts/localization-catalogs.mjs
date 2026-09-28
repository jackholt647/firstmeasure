/** Source migration and catalog compiler. Never inspects or rewrites live DOM/customer data. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { build } from 'esbuild';
// Atomic replacement also works when Windows previewers hold a mapped file open.
function writeFile(file,contents){
  if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')===contents)return;
  const temporary=file+'.localization-'+process.pid+'.tmp';
  fs.writeFileSync(temporary,contents);fs.renameSync(temporary,file);
}
const root = path.resolve(import.meta.dirname, '../../..');
const out = path.join(root, 'public/libraries/platform-language/catalogs');
const sourcePath = path.join(root, 'public/v1/platform/localization/catalog-source.json');
const catalog = fs.existsSync(sourcePath) ? JSON.parse(fs.readFileSync(sourcePath, 'utf8')) : {};
const languageRegistry=JSON.parse(fs.readFileSync(path.join(root,'public/v1/platform/localization/languages.json'),'utf8'));
const supportedLocales=languageRegistry.packs.map(pack=>pack.code);
const overrides=JSON.parse(fs.readFileSync(path.join(root,'public/v1/platform/localization/catalog-overrides.json'),'utf8'));
// Each translation worker's language is imported separately; no shared override-file edits.
const packsDir=path.join(root,'public/v1/platform/localization/packs');
for(const locale of supportedLocales.filter(code=>!['en-US','en-GB'].includes(code))) {
  const file=path.join(packsDir,locale+'.json');
  if(fs.existsSync(file)) {
    const pack=JSON.parse(fs.readFileSync(file,'utf8'));
    overrides[locale] ||= {};
    for(const [namespace,messages] of Object.entries(pack)) overrides[locale][namespace]={...overrides[locale][namespace],...messages};
  }
}
const write = process.argv.includes('--write');
const check = process.argv.includes('--check');
const words = {color:'colour',colors:'colours',colored:'coloured',coloring:'colouring',colorize:'colourise',colorized:'colourised',favorite:'favourite',favorites:'favourites',organize:'organise',organized:'organised',organizing:'organising',organization:'organisation',organizations:'organisations',customize:'customise',customized:'customised',customizing:'customising',customization:'customisation',analyze:'analyse',analyzed:'analysed',analyzing:'analysing',center:'centre',centers:'centres',centered:'centred',centering:'centring',license:'licence',licenses:'licences',aluminum:'aluminium',gray:'grey',labor:'labour',vapor:'vapour',miter:'mitre',miters:'mitres',canceled:'cancelled',canceling:'cancelling',catalog:'catalogue',catalogs:'catalogues',meter:'metre',meters:'metres',millimeter:'millimetre',millimeters:'millimetres'};
// Build-time English variant generation; runtime only resolves reviewed, literal catalog entries.
function british(text) { return text.replace(/\b[a-z]+\b/gi, word => { const value = words[word.toLowerCase()]; return !value ? word : word === word.toUpperCase() ? value.toUpperCase() : /^[A-Z]/.test(word) ? value[0].toUpperCase()+value.slice(1) : value; }); }
function files(dir) { return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()&&!['vendor','node_modules','dist'].includes(e.name)?files(path.join(dir,e.name)):e.isFile()&&e.name.endsWith('.js')?[path.join(dir,e.name)]:[]); }
const targets = [...files(path.join(root,'public/libraries')), ...files(path.join(root,'public/portal/scripts')), ...files(path.join(root,'public/customer_portal'))]
  .filter(file=>!file.endsWith('platform-terminology.js')&&!/(?:platform-language|doc-language|site-runtime)[/\\]|(?:\.min|\.bundle)\.js$/.test(file));
const uiKeys = new Set(['label','title','description','placeholder','subtitle','emptyText','buttonText','helpText','tooltip','ariaLabel','message','heading','caption','confirmText','emptyMessage']);
const stats=[];
function register(namespace, message, format) {
  const key='m_'+crypto.createHash('sha256').update((format||'plain')+'\0'+message).digest('hex').slice(0,14);
  (catalog[namespace] ||= {})[key] = format ? {message,format} : message;
  return key;
}
function eligible(text) { return !/(?:color|display|font-size|padding|background|margin|border):/.test(text) && /[A-Za-z]{2}/.test(text) && !/^\s*(?:https?:|[.#][\w-]+\s*\{|@|[\w.-]+\.js)/.test(text); }
function escapeIcu(text) { return text.replace(/'/g,"''").replace(/[{}]/g,c=>"'"+c+"'"); }
for(const file of targets) {
  const relative=path.relative(root,file).replaceAll('\\','/');
  const namespace=relative.includes('/customer_portal/')?'customer-portal':relative.includes('/apps/')?relative.split('/apps/')[1].split('/')[0].replace(/\.js$/,''):relative.includes('/portal/')?'platform':relative.split('/libraries/')[1].split('/')[0];
  const code=fs.readFileSync(file,'utf8'), tree=ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),edits=[];
  let messages=0;
  function expression(text, expressions=[], htmlContext=false) {
    if(!eligible(text.replace(/__FM_SLOT_\d+__/g,'')))return null;
    const used=[...text.matchAll(/__FM_SLOT_(\d+)__/g)].map(m=>Number(m[1]));
    // Arbitrary HTML-producing expressions stay outside localized messages.
    if(used.some(i=>/\.map\(|\.join\(|\b(?:html|markup|render\w*)\b|<\w/i.test(expressions[i]||'')))return null;
    messages++;
    if(!used.length){const key=register(namespace,text);return `(globalThis.PlatformLanguage?.${htmlContext ? 'htmlText' : 'text'}(${JSON.stringify(namespace)},${JSON.stringify(key)},${JSON.stringify(text)}) ?? ${JSON.stringify(text)})`;}
    const unique=[...new Set(used)],message=escapeIcu(text).replace(/__FM_SLOT_(\d+)__/g,(_,n)=>'{v'+n+'}'),key=register(namespace,message,'icu');
    const literal='`'+text.replace(/[`\\]/g,c=>'\\'+c).replace(/\$\{/g,'\\${').replace(/__FM_SLOT_(\d+)__/g,(_,n)=>'${v'+n+'}')+'`';
    return `((${unique.map(i=>'v'+i).join(',')}) => globalThis.PlatformLanguage?.text(${JSON.stringify(namespace)},${JSON.stringify(key)},${literal},{${unique.map(i=>'v'+i).join(',')}}) ?? ${literal})(${unique.map(i=>expressions[i]).join(',')})`;
  }
  function stringParts(node) {
    if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)) return {text:node.text,expressions:[]};
    if(ts.isTemplateExpression(node)) {const expressions=[];let text=node.head.text;for(const span of node.templateSpans){text+='__FM_SLOT_'+expressions.length+'__'+span.literal.text;expressions.push(span.expression.getText(tree));}return {text,expressions};}
    return null;
  }
  function renderOriginal(text,expressions){
    return text.split(/(__FM_SLOT_\d+__)/g).map(part=>/^__FM_SLOT_\d+__$/.test(part)?'${'+expressions[Number(part.match(/\d+/)[0])]+ '}':part.replace(/\\/g,'\\\\').replace(/`/g,'\\`').replace(/\$\{/g,'\\${')).join('');
  }
  function html(text,expressions) {
    const ranges=[];const blocked=[...text.matchAll(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi)].map(m=>[m.index,m.index+m[0].length]);
    for(const pattern of [/>[^<>]+(?=<)/g,/\b(?:title|placeholder|aria-label|alt)=("[^"]*"|'[^']*')/g])for(const match of text.matchAll(pattern)){
      const attr=pattern.source.startsWith('\\b'),start=match.index+(attr?match[0].indexOf('=')+2:1),end=match.index+match[0].length-(attr?1:0);
      if(blocked.some(([a,b])=>start>=a&&start<b))continue;
      const value=text.slice(start,end);if(!value.trim()||(!attr&&/[{}]/.test(value)))continue;
      const result=expression(value,expressions,true);if(result)ranges.push({start,end,result});
    }
    if(!ranges.length)return null;
    ranges.sort((a,b)=>a.start-b.start);let cursor=0;const parts=[];
    for(const range of ranges){if(range.start<cursor)continue;if(range.start>cursor)parts.push(renderOriginal(text.slice(cursor,range.start),expressions));parts.push('${'+range.result+'}');cursor=range.end;}
    if(cursor<text.length)parts.push(renderOriginal(text.slice(cursor),expressions));
    return '`'+parts.join('')+'`';
  }
  function visible(node) {
    const p=node.parent;
    if(ts.isPropertyAssignment(p)&&p.initializer===node&&uiKeys.has(p.name.getText(tree).replace(/['"]/g,'')))return true;
    if(ts.isBinaryExpression(p)&&p.right===node&&/\.(textContent|innerText|placeholder|title)$/.test(p.left.getText(tree)))return true;
    if(ts.isCallExpression(p)){
      const name=p.expression.getText(tree),index=p.arguments.indexOf(node);
      if(/(?:^|\.)(alert|confirm|prompt)$/.test(name)&&index===0)return true;
      if(/(?:^|\.)(showToast|toast)$/.test(name)&&index<2)return true;
      if(/\.setAttribute$/.test(name)&&index===1&&/^(title|aria-label|placeholder|alt)$/.test(p.arguments[0]?.text||''))return true;
    }
    return false;
  }
  function htmlSink(node){
    for(let parent=node.parent;parent&&!ts.isSourceFile(parent)&&!ts.isBlock(parent);parent=parent.parent){
      if(ts.isCallExpression(parent)&&/(?:escapeHtml|esc|escapeAttr|escapeHTML|htmlEscape)$/.test(parent.expression.getText(tree)))return false;
      if(ts.isTemplateExpression(parent)&&/<[a-z][^>]*>/i.test(parent.getText(tree)))return true;
      if(ts.isBinaryExpression(parent)&&/\.innerHTML$/.test(parent.left.getText(tree)))return true;
    }
    return false;
  }
  function visit(node){
    if(ts.isCallExpression(node)&&/(?:^|\.)PlatformLanguage\??\.(?:htmlText|text)$|(?:^|\.)FMText$/.test(node.expression.getText(tree))){
      if(/PlatformLanguage\?\.text$/.test(node.expression.getText(tree))&&htmlSink(node))edits.push({start:node.expression.end-4,end:node.expression.end,text:'htmlText'});
      return;
    }
    const parts=stringParts(node);
    if(parts){
      // Never translate generated translation fallbacks a second time.
      let parent=node.parent;for(let i=0;parent&&i<3;i++,parent=parent.parent)if(ts.isCallExpression(parent)&&parent.expression.getText(tree).includes('PlatformLanguage'))return;
      let replacement;
      if(/<[a-z][^>]*>/i.test(parts.text)&&!ts.isPropertyAssignment(node.parent)||(/<[a-z][^>]*>/i.test(parts.text)&&visible(node)))replacement=html(parts.text,parts.expressions);
      else if(visible(node)&&!parts.text.includes('<'))replacement=expression(parts.text,parts.expressions);
      if(replacement){edits.push({start:node.getStart(tree),end:node.end,text:replacement});return;}
    }
    ts.forEachChild(node,visit);
  }
  visit(tree);
  if(write&&edits.length){
    const backup=path.join(root,'output/localization-before',relative);
    if(!fs.existsSync(backup)){fs.mkdirSync(path.dirname(backup),{recursive:true});fs.copyFileSync(file,backup);}
    let updated=code;for(const edit of edits.sort((a,b)=>b.start-a.start))updated=updated.slice(0,edit.start)+edit.text+updated.slice(edit.end);
    const parsed=ts.createSourceFile(file,updated,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    if(parsed.parseDiagnostics.length)throw new Error(`Migration syntax error: ${relative}: ${parsed.parseDiagnostics[0].messageText}`);
    writeFile(file,updated);
  }
  stats.push({file:relative,namespace,references:(code.match(/PlatformLanguage\?\.(?:htmlText|text)\(/g)||[]).length,candidates:messages,edits:edits.length});
}
// Terminology shares the same catalog while retaining branch overrides.
const window={};vm.runInNewContext(fs.readFileSync(path.join(root,'public/libraries/platform-terminology/platform-terminology.js'),'utf8'),{window});
const contractPath=path.join(root,'public/v1/platform/localization/terminology-contract.json');
const contract=JSON.stringify(Object.fromEntries(window.PlatformTerminology.CATALOG.flatMap(section=>section.terms.map(term=>[section.id+'.'+term.key,{label:term.label,kind:term.kind}]))),null,2)+'\n';
if(check){if(fs.readFileSync(contractPath,'utf8')!==contract)throw Error('Stale terminology contract');}else writeFile(contractPath,contract);
catalog.terminology=Object.fromEntries(window.PlatformTerminology.CATALOG.flatMap(section=>section.terms.map(term=>[section.id+'.'+term.key,term.label])));
catalog.shared={...(catalog.shared||{}),save:'Save',cancel:'Cancel',loading:'Loading…',item_count:{message:'{count, plural, =0 {No items} one {# item} other {# items}}',format:'icu'}};
// Only unambiguous, static error messages are catalogued; contextual messages keep their API fallback.
const errorTexts=new Map();
function backendFiles(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()&&!['node_modules','dist','tests','scripts','.tmp'].includes(e.name)?backendFiles(path.join(dir,e.name)):e.isFile()&&e.name.endsWith('.ts')?[path.join(dir,e.name)]:[]);}
for(const file of backendFiles(path.join(root,'public/v1'))){
  const tree=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
  function visit(node){if(ts.isCallExpression(node)&&/^(badRequest|forbidden|notFound|conflict|unauthorized)$/.test(node.expression.getText(tree))&&node.arguments.length>=2&&ts.isStringLiteral(node.arguments[0])&&ts.isStringLiteral(node.arguments[1])){const key=node.arguments[0].text,value=node.arguments[1].text;const set=errorTexts.get(key)||new Set();set.add(value);errorTexts.set(key,set);}ts.forEachChild(node,visit);}visit(tree);
}
catalog.errors=Object.fromEntries([...errorTexts].filter(([,values])=>values.size===1).map(([key,values])=>[key,[...values][0]]));
catalog.platform ||= {};
catalog.notifications={document_greeting:{format:'icu',message:'Hi {name},'},document_ready:{format:'icu',message:'Your {type} is ready to review.'},document_link:{format:'icu',message:'Review and respond here: {url}'}};
const reportRoot={};vm.runInNewContext(fs.readFileSync(path.join(root,'public/libraries/report-units.js'),'utf8'),{window:reportRoot});
catalog.reports=Object.fromEntries(Object.keys(reportRoot.ReportUnits.catalogs['en-GB']).map(key=>[key,key]));
function localeMessages(namespace,messages) {
  const locales={'en-US':messages};
  for(const locale of supportedLocales.filter(code=>code!=='en-US')) {
    if(locale!=='en-GB' && !overrides[locale])throw Error(`Missing reviewed catalog overrides for ${locale}`);
    const defaults=locale==='en-GB' ? (namespace==='reports'?{...reportRoot.ReportUnits.catalogs['en-GB']}:Object.fromEntries(Object.entries(messages).filter(([,m])=>british(typeof m==='string'?m:m.message)!==(typeof m==='string'?m:m.message)).map(([key,m])=>[key,typeof m==='string'?british(m):{...m,message:british(m.message)}]))) : {};
    const translated={...defaults,...overrides[locale]?.[namespace]};
    for(const key of Object.keys(translated))if(!Object.hasOwn(messages,key))throw Error(`Unknown translation key: ${locale}.${namespace}.${key}`);
    locales[locale]=translated;
  }
  return locales;
}
if(check){
  const unresolved=stats.filter(s=>s.edits);if(unresolved.length){console.error(JSON.stringify(unresolved,null,2));process.exitCode=1;}
  const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
  if(JSON.stringify(manifest.supported_locales)!==JSON.stringify(supportedLocales))throw Error('Stale supported language list');
  for(const [namespace,messages] of Object.entries(catalog)){
    const namespaces={[namespace]:localeMessages(namespace,messages)},version=crypto.createHash('sha256').update(JSON.stringify(namespaces)).digest('hex').slice(0,16);
    if(manifest.namespaces[namespace]!==namespace+'.'+version+'.json'||fs.readFileSync(path.join(out,manifest.namespaces[namespace]),'utf8')!==JSON.stringify({version,namespaces}))throw Error(`Stale generated catalog: ${namespace}. Run npm run localization:build.`);
  }
  const compiled=await build({entryPoints:[path.join(root,'public/v1/platform/localization/browser.ts')],bundle:true,format:'iife',target:'es2022',minify:true,legalComments:'eof',write:false});
  if(compiled.outputFiles[0].text!==fs.readFileSync(path.join(root,'public/libraries/platform-language/platform-language.js'),'utf8'))throw Error('Stale language runtime. Run npm run localization:build.');
}
else {
  fs.mkdirSync(out,{recursive:true});writeFile(sourcePath,JSON.stringify(catalog,null,2)+'\n');
  const appNamespaces=new Set(stats.filter(s=>/\/apps\/[^/]+\//.test(s.file)).map(s=>s.namespace));
  const manifest={schema_version:1,supported_locales:supportedLocales,eagerNamespaces:Object.keys(catalog).filter(n=>!appNamespaces.has(n)),namespaces:{}};
  for(const[namespace,messages]of Object.entries(catalog)){
    const namespaces={[namespace]:localeMessages(namespace,messages)},version=crypto.createHash('sha256').update(JSON.stringify(namespaces)).digest('hex').slice(0,16),file=namespace+'.'+version+'.json';
    writeFile(path.join(out,file),JSON.stringify({version,namespaces}));manifest.namespaces[namespace]=file;
  }
  writeFile(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  const runtime=await build({entryPoints:[path.join(root,'public/v1/platform/localization/browser.ts')],bundle:true,format:'iife',target:'es2022',minify:true,legalComments:'eof',write:false});
  const runtimePath=path.join(root,'public/libraries/platform-language/platform-language.js');
  writeFile(runtimePath,runtime.outputFiles[0].text);
  writeFile(path.join(root,'public/v1/platform/localization/coverage.json'),JSON.stringify({files:stats.length,namespaces:Object.keys(catalog).length,messages:Object.values(catalog).reduce((n,m)=>n+Object.keys(m).length,0),migration:stats},null,2)+'\n');
}
console.log(JSON.stringify({files:stats.length,messages:Object.values(catalog).reduce((n,m)=>n+Object.keys(m).length,0),candidates:stats.reduce((n,s)=>n+s.candidates,0),written:write}));
