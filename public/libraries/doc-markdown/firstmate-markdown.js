/* FirstMate's bounded Markdown representation and DocModel adapters.
 * No raw HTML, executable URLs, network fetches or model-supplied attributes.
 * Browser global FMMarkdown; the same implementation is CommonJS-importable.
 */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.FMMarkdown=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const VERSION=1,MAX_DEPTH=16,MAX_LENGTH=262144;
  const escape=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const safeUrl=value=>{const url=String(value??'').trim();return /^(https?:\/\/|mailto:|tel:|#)[^\s\u0000-\u001f<>]*$/i.test(url)?url:'';};
  function inline(source,marks={},depth=0){
    source=String(source??'');const runs=[];const add=(text,style=marks)=>{if(!text)return;const last=runs[runs.length-1];if(last&&JSON.stringify({...last,text:''})===JSON.stringify({...style,text:''}))last.text+=text;else runs.push({...style,text});};
    if(depth>=MAX_DEPTH)return [{...marks,text:source}];
    for(let i=0;i<source.length;){
      if(source[i]==='\\'&&i+1<source.length&&/[\\`*_[\]{}()#+\-.!>|~]/.test(source[i+1])){add(source[i+1]);i+=2;continue;}
      const code=/^(`+)([\s\S]*?)\1(?!`)/.exec(source.slice(i));
      if(code){add(code[2],{...marks,code:true});i+=code[0].length;continue;}
      // Links consume their destination atomically: emphasis never modifies URLs.
      if(source[i]==='['){const match=/^\[((?:\\.|[^\]\\])*)\]\(<?([^\s<>]*(?:\([^\s<>]*\)[^\s<>]*)?)>?\)/.exec(source.slice(i));if(match){const url=safeUrl(match[2]);runs.push(...inline(match[1],url?{...marks,link:url}:marks,depth+1));i+=match[0].length;continue;}}
      if(source[i]==='<'){const match=/^<((?:https?:\/\/|mailto:)[^<>\s]+)>/.exec(source.slice(i));if(match&&safeUrl(match[1])){add(match[1],{...marks,link:match[1]});i+=match[0].length;continue;}}
      let formatted=false;
      for(const [delimiter,key,value]of [['**','weight',700],['__','weight',700],['~~','strike',true],['*','italic',true],['_','italic',true]]){
        if(!source.startsWith(delimiter,i))continue;
        if(delimiter.includes('_')&&i&&/[\p{L}\p{N}]/u.test(source[i-1]))continue;
        const end=source.indexOf(delimiter,i+delimiter.length);
        if(end<=i+delimiter.length||/\s/.test(source[i+delimiter.length])||/\s/.test(source[end-1]))continue;
        runs.push(...inline(source.slice(i+delimiter.length,end),{...marks,[key]:value},depth+1));i=end+delimiter.length;formatted=true;break;
      }
      if(formatted)continue;add(source[i++]);
    }
    return runs;
  }
  function cells(line){
    let value=line.trim();if(value.startsWith('|'))value=value.slice(1);if(value.endsWith('|')&&!value.endsWith('\\|'))value=value.slice(0,-1);
    const rows=[];let cell='',ticks=0;
    for(let i=0;i<value.length;i++){const ch=value[i];if(ch==='\\'&&i+1<value.length){cell+=ch+value[++i];continue;}if(ch==='`')ticks=ticks?0:1;if(ch==='|'&&!ticks){rows.push(cell.trim());cell='';}else cell+=ch;}rows.push(cell.trim());return rows;
  }
  const listLine=line=>{const m=/^(\s*)([-*+•]|\d{1,9}[.)])\s+(.*)$/.exec(line);return m&&{indent:m[1].replace(/\t/g,'  ').length,ordered:/^\d/.test(m[2]),start:Math.min(10000,parseInt(m[2],10)||1),text:m[3]};};
  function parse(raw){
    const source=String(raw??'').replace(/\r\n?/g,'\n');if(source.length>MAX_LENGTH)throw new RangeError('Markdown exceeds the 256 KiB content limit.');
    function blocks(lines,depth=0){
      const out=[];for(let i=0;i<lines.length;){const line=lines[i];if(!line.trim()){i++;continue;}
        const fence=/^\s*(`{3,}|~{3,})([\w+-]*)\s*$/.exec(line);
        if(fence){const body=[];i++;while(i<lines.length&&!new RegExp('^\\s*'+fence[1][0]+'{'+fence[1].length+',}\\s*$').test(lines[i]))body.push(lines[i++]);if(i<lines.length)i++;out.push({type:'code',language:fence[2],text:body.join('\n')});continue;}
        if(/^\s{0,3}>/.test(line)&&depth<MAX_DEPTH){const body=[];while(i<lines.length&&/^\s{0,3}>/.test(lines[i]))body.push(lines[i++].replace(/^\s{0,3}> ?/,''));out.push({type:'quote',children:blocks(body,depth+1)});continue;}
        const heading=/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if(heading){out.push({type:'heading',level:heading[1].length,runs:inline(heading[2])});i++;continue;}
        if(/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)){out.push({type:'rule'});i++;continue;}
        const headers=cells(line),delimiters=cells(lines[i+1]||'');
        if(line.includes('|')&&headers.length===delimiters.length&&delimiters.every(x=>/^:?-{3,}:?$/.test(x))){
          const rows=[headers.map(x=>inline(x.replace(/<br\s*\/?\s*>/gi,'\n')))],align=delimiters.map(x=>x.startsWith(':')&&x.endsWith(':')?'center':x.endsWith(':')?'right':'left');i+=2;
          while(i<lines.length&&lines[i].trim()&&lines[i].includes('|')){const row=cells(lines[i++]);rows.push(headers.map((_,j)=>inline((row[j]||'').replace(/<br\s*\/?\s*>/gi,'\n'))));}out.push({type:'table',align,rows});continue;
        }
        const first=listLine(line);
        if(first&&depth<MAX_DEPTH){
          const items=[];while(i<lines.length){const item=listLine(lines[i]);if(!item||item.indent!==first.indent||item.ordered!==first.ordered)break;i++;
            const task=/^\[([ xX])\]\s+(.*)$/.exec(item.text),children=[];const nested=[];
            while(i<lines.length&&lines[i].trim()&&/^\s+/.test(lines[i])&&(listLine(lines[i])?.indent??lines[i].match(/^\s*/)[0].length)>first.indent)nested.push(lines[i++].slice(Math.min(first.indent+2,lines[i-1].match(/^\s*/)[0].length)));
            if(nested.length)children.push(...blocks(nested,depth+1));items.push({runs:inline(task?task[2]:item.text),...(task?{checked:task[1].toLowerCase()==='x'}:{}),children});
          }out.push({type:'list',ordered:first.ordered,start:first.start,items});continue;
        }
        out.push({type:'paragraph',runs:inline(line)});i++;
      }return out;
    }
    return {version:VERSION,blocks:blocks(source.split('\n'))};
  }
  function runsHtml(runs){return (runs||[]).map(run=>{let html=escape(run.text);if(run.code)html='<code>'+html+'</code>';else{if(run.weight>=600)html='<strong>'+html+'</strong>';if(run.italic)html='<em>'+html+'</em>';if(run.strike)html='<del>'+html+'</del>';}const url=safeUrl(run.link);return url?'<a href="'+escape(url)+'" target="_blank" rel="noopener noreferrer">'+html+'</a>':html;}).join('');}
  const css='.fm-markdown{overflow-wrap:anywhere;line-height:1.5}.fm-markdown p{margin:.4em 0;white-space:pre-wrap}.fm-markdown h1,.fm-markdown h2,.fm-markdown h3,.fm-markdown h4,.fm-markdown h5,.fm-markdown h6{font-size:1.12em;margin:.7em 0 .3em}.fm-markdown ul,.fm-markdown ol{padding-left:1.7em;margin:.4em 0}.fm-markdown li{margin:.15em 0}.fm-markdown blockquote{margin:.5em 0;padding:.1em .8em;border-left:3px solid #98a2b3}.fm-markdown pre{overflow:auto;max-width:100%;padding:.7em;background:var(--bg-muted,#f2f4f7);border-radius:6px;white-space:pre}.fm-markdown code{font-family:monospace;font-size:.93em}.fm-markdown-table{overflow:auto;max-width:100%;margin:.6em 0}.fm-markdown table{border-collapse:collapse;min-width:100%}.fm-markdown td,.fm-markdown th{border:1px solid var(--border,#d7dce3);padding:.4em .6em;vertical-align:top;white-space:pre-wrap}.fm-markdown-task{list-style:none}.fm-markdown-task-marker{margin-right:.5em}';
  function injectCss(){if(typeof document==='undefined'||document.getElementById('fm-markdown-css'))return;const el=document.createElement('style');el.id='fm-markdown-css';el.textContent=css;document.head.appendChild(el);}
  function render(raw){injectCss();const parsed=typeof raw==='string'||raw==null?parse(raw):raw;
    const body=(blocks,level=0)=>(blocks||[]).map(block=>{
      if(block.type==='table')return '<div class="fm-markdown-table"><table><thead><tr>'+block.rows[0].map((runs,i)=>'<th scope="col" style="text-align:'+(['left','right','center'].includes(block.align[i])?block.align[i]:'left')+'">'+runsHtml(runs)+'</th>').join('')+'</tr></thead><tbody>'+block.rows.slice(1).map(row=>'<tr>'+row.map((runs,i)=>'<td style="text-align:'+(['left','right','center'].includes(block.align[i])?block.align[i]:'left')+'">'+runsHtml(runs)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
      if(block.type==='list'){const tag=block.ordered?'ol':'ul';return '<'+tag+(block.ordered?' start="'+Math.max(1,Number(block.start)||1)+'" type="'+['1','a','i'][level%3]+'"':' style="list-style-type:'+['disc','circle','square'][level%3]+'"')+'>'+block.items.map(item=>'<li'+(item.checked!==undefined?' class="fm-markdown-task"':'')+'>'+(item.checked!==undefined?'<span class="fm-markdown-task-marker" role="img" aria-label="'+(item.checked?'Completed':'Not completed')+'">'+(item.checked?'☑':'☐')+'</span>':'')+runsHtml(item.runs)+body(item.children,level+1)+'</li>').join('')+'</'+tag+'>';}
      if(block.type==='quote')return '<blockquote>'+body(block.children,level)+'</blockquote>';
      if(block.type==='code')return '<pre><code>'+escape(block.text)+'</code></pre>';
      if(block.type==='rule')return '<hr>';
      const tag=block.type==='heading'?'h'+Math.max(1,Math.min(6,Number(block.level)||1)):'p';return '<'+tag+'>'+runsHtml(block.runs)+'</'+tag+'>';
    }).join('');return '<div class="fm-markdown">'+body(parsed.blocks)+'</div>';
  }
  function runsMarkdown(runs){return (runs||[]).map(run=>{let text=String(run.text??'');if(run.code){const delim='`'.repeat(Math.max(1,...(text.match(/`+/g)||[]).map(x=>x.length+1)));text=delim+text+delim;}else{text=text.replace(/([\\`*_[\]<>|~])/g,'\\$1');if(run.strike)text='~~'+text+'~~';if(run.italic)text='*'+text+'*';if(run.weight>=600)text='**'+text+'**';}return safeUrl(run.link)?'['+text+']('+run.link+')':text;}).join('');}
  function stringify(content){
    const body=blocks=>(blocks||[]).map(block=>{
      if(block.type==='table'){const rows=block.rows.map(row=>'| '+row.map(runs=>runsMarkdown(runs).replace(/\n/g,'<br>')).join(' | ')+' |');rows.splice(1,0,'| '+block.align.map(a=>a==='center'?':---:':a==='right'?'---:':'---').join(' | ')+' |');return rows.join('\n');}
      if(block.type==='list')return block.items.map((item,i)=>(block.ordered?(block.start+i)+'.':'-')+' '+(item.checked!==undefined?'['+(item.checked?'x':' ')+'] ':'')+runsMarkdown(item.runs)+(item.children.length?'\n'+body(item.children).split('\n').map(x=>'  '+x).join('\n'):'')).join('\n');
      if(block.type==='quote')return body(block.children).split('\n').map(x=>'> '+x).join('\n');
      if(block.type==='code'){const fence='`'.repeat(Math.max(3,...(block.text.match(/`+/g)||[]).map(x=>x.length+1)));return fence+String(block.language||'').replace(/[^\w+-]/g,'')+'\n'+block.text+'\n'+fence;}
      if(block.type==='rule')return '---';return (block.type==='heading'?'#'.repeat(block.level)+' ':'')+runsMarkdown(block.runs);
    }).join('\n\n');return body(content.blocks);
  }
  function toDocNodes(content,options={}){
    if(typeof content==='string')content=parse(content);let index=0;const id=prefix=>options.generateId?options.generateId(prefix):'md_'+prefix+'_'+(++index);const nodes=[];
    const add=(block,level=0,quote=0)=>{
      if(block.type==='table'){nodes.push({id:id('table'),type:'table',anchor:'flow',frame:{x:0,y:0,w:0,h:'auto',layout:'flow'},props:{header:true,columns:block.align.map(align=>({align,width_frac:1/block.align.length})),rows:block.rows.map(row=>({cells:row.map(runs=>({blocks:[{id:id('block'),type:'paragraph',runs:docRuns(runs)}]}))}))}});return;}
      if(block.type==='quote'){nodes.push({id:id('quote'),type:'frame',anchor:'flow',frame:{x:0,y:0,w:0,h:'auto',layout:'flow'},props:{flow:{direction:'column',padding:[0,0,0,10]},markdown_quote:true},children:toDocNodes({version:VERSION,blocks:block.children},{generateId:id})});return;}
      if(block.type==='list'){block.items.forEach((item,i)=>{text({id:id('block'),type:'list_item',indent:level,list_style:item.checked!==undefined?'check':block.ordered?'number':'bullet',...(item.checked!==undefined?{checked:item.checked}:{}),...(block.ordered&&i===0?{list_restart:true,list_start:block.start}:{}),runs:docRuns(item.runs)},quote);item.children.forEach(child=>add(child,level+1,quote));});return;}
      const result={id:id('block'),type:block.type==='heading'?'heading':'paragraph',runs:docRuns(block.runs||[{text:block.text||''}])};if(block.type==='heading')result.level=block.level;
      if(block.type==='code'){result.markdown={kind:'code',language:block.language};result.runs=[{text:block.text,font:'Courier New',literal:true}];}
      if(block.type==='rule'){result.markdown={kind:'rule'};result.border={width_pt:.75,color:'#98a2b3',sides:{bottom:true}};}
      text(result,quote);
    };
    function docRuns(runs){return runs.map(run=>{const result={...run,literal:true};if(result.code){result.font='Courier New';result.markdown_code=true;delete result.code;}return result;});}
    function text(block,quote){if(quote){block.markdown={...(block.markdown||{}),quote};block.border={width_pt:2,color:'#98a2b3',sides:{left:true}};block.indent=quote;}let node=nodes[nodes.length-1];if(!node||node.type!=='text'){node={id:id('text'),type:'text',anchor:'flow',frame:{x:0,y:0,w:0,h:'auto',layout:'flow'},props:{blocks:[]}};nodes.push(node);}node.props.blocks.push(block);}
    content.blocks.forEach(block=>add(block));return nodes;
  }
  function fromDocNodes(nodes){
    const blocks=[],diagnostics=[];const runs=value=>(value||[]).map(run=>({text:String(run.text??''),...(run.weight?{weight:run.weight}:{}),...(run.italic?{italic:true}:{}),...(run.strike?{strike:true}:{}),...(safeUrl(run.link)?{link:run.link}:{}),...(run.markdown_code?{code:true}:{})}));let lists=[];
    function addDoc(block){
      if(block.type==='list_item'){const level=Math.max(0,Math.min(8,Number(block.indent)||0)),ordered=block.list_style==='number';lists.length=Math.min(lists.length,level+1);let list=lists[level];
        if(!list||list.ordered!==ordered||block.list_restart){list={type:'list',ordered,start:Number(block.list_start)||1,items:[]};if(level&&lists[level-1]?.items.length)lists[level-1].items.at(-1).children.push(list);else blocks.push(list);lists[level]=list;}list.items.push({runs:runs(block.runs),...(block.list_style==='check'?{checked:!!block.checked}:{}),children:[]});return;
      }lists=[];let item=block.markdown?.kind==='code'?{type:'code',language:block.markdown.language||'',text:(block.runs||[]).map(r=>r.text||'').join('')}:block.markdown?.kind==='rule'?{type:'rule'}:{type:block.type==='heading'?'heading':'paragraph',...(block.type==='heading'?{level:Math.max(1,Math.min(6,Number(block.level)||1))}:{}),runs:runs(block.runs)};
      for(let i=0;i<(block.markdown?.quote||0);i++)item={type:'quote',children:[item]};blocks.push(item);
    }
    function walk(node){if(node.props?.markdown_quote){lists=[];const nested=fromDocNodes(node.children||[]);blocks.push({type:'quote',children:nested.content.blocks});diagnostics.push(...nested.diagnostics);return;}if(node.bind)diagnostics.push('Bindings are exported as their current text, not executable bindings.');if(node.type==='text')(node.props?.blocks||[]).forEach(addDoc);else if(node.type==='table'){lists=[];const props=node.props||{};if(props.header===false)diagnostics.push('Markdown requires a table header; the first row is used.');const rows=(props.rows||[]).map(row=>(row.cells||[]).map(cell=>{if(cell.colspan>1)diagnostics.push('Merged table cells cannot be represented in Markdown.');if(cell.blocks?.length>1)diagnostics.push('Multiple cell paragraphs are flattened.');return cell.blocks?runs(cell.blocks.flatMap((b,i)=>[...(i?[{text:'\n'}]:[]),...(b.runs||[])])):[{text:String(cell.text??cell??'')}];}));const width=Math.max(0,...rows.map(row=>row.length));if(width)blocks.push({type:'table',align:Array.from({length:width},(_,i)=>props.columns?.[i]?.align||'left'),rows:rows.map(row=>Array.from({length:width},(_,i)=>row[i]||[]))});}else if(node.children)node.children.forEach(walk);else diagnostics.push('Unsupported '+node.type+' content was omitted from Markdown.');}
    (nodes||[]).forEach(walk);return {content:{version:VERSION,blocks},diagnostics:[...new Set(diagnostics),'Page geometry, fonts, colors and other visual formatting are not represented in Markdown.']};
  }
  function listMarker(style,count,level){count=Number.isFinite(Number(count))?Math.max(1,Math.min(100000,Math.floor(Number(count)))):1;level=Math.max(0,Math.min(16,Number(level)||0));if(style!=='number')return ['•','◦','▪'][level%3];if(level%3===0)return String(count)+'.';let n=Math.max(1,count),out='';if(level%3===1){while(n){n--;out=String.fromCharCode(97+n%26)+out;n=Math.floor(n/26);}}else for(const [value,label]of [[1000,'m'],[900,'cm'],[500,'d'],[400,'cd'],[100,'c'],[90,'xc'],[50,'l'],[40,'xl'],[10,'x'],[9,'ix'],[5,'v'],[4,'iv'],[1,'i']])while(n>=value){out+=label;n-=value;}return out+'.';}
  return {VERSION,parse,render,stringify,inline,toDocNodes,fromDocNodes,listMarker,safeUrl,injectCss,css};
});
