type Obj = Record<string, unknown>;
const obj=(v:unknown):Obj=>v&&typeof v==='object'&&!Array.isArray(v)?v as Obj:{};
const TYPES=new Set(['RIDGE','HIP','VALLEY','RAKE','EAVE','HEAD_WALL','SIDE_WALL','TRANS','PARAPET','PROTRUSION','CHIMNEY_BACK','CHIMNEY_EDGE','CHIMNEY_FRONT','SKYLIGHT','UNKNOWN']);
// The type xml_generator.js (normalizeXmlLineType) writes for a saved line type, to check a pairing against the XML.
function xmlType(type:string){
  const value=type.toLowerCase();
  if(['eave','rake','ridge','hip','valley','head_wall','side_wall'].includes(value))return value.toUpperCase();
  if(value==='headwall'||value==='sidewall')return value==='headwall'?'HEAD_WALL':'SIDE_WALL';
  if(value.includes('step')||value.includes('chimney_edge')||value.includes('wall'))return 'STEPFLASH';
  if(value.includes('flash')||value.includes('trans'))return 'FLASHING';
  if(value.includes('skylight'))return 'SKYLIGHT';
  if(value.includes('chimney'))return 'FLASHING';
  return value.includes('parapet')?'PARAPET':'EAVE';
}
/** XML point ids follow deduplicated saved geometry.points, in the order xml_generator.js registers them. Since FM-405
 * the generator also keeps two points at one plan position apart when their heights differ by more than 0.25 m;
 * before it, plan position alone. With the stored XML, the deduplication whose ids agree with its lines is used.
 * Do not infer types for endpoints absent from that geometry, or modify the report/export. */
export function reportEdgeTypes(saved:unknown,xml=''){
  const state=obj(saved),geometry=obj(state.geometry),report=obj(state.report);
  const lines=Array.isArray(report.lines)&&report.lines.length?report.lines:Array.isArray(geometry.connections)?geometry.connections:[];
  const classify=(byHeight:boolean)=>{
    const points: {x:number;y:number;z:number|null;id:string}[]=[];
    const cells=new Map<string,typeof points>();
    const locate=(raw:unknown)=>{
      const p=obj(raw),x=Number(p.x),y=Number(p.y),z=p.z==null?NaN:Number(p.z);if(!Number.isFinite(x)||!Number.isFinite(y)||p.x==null||p.y==null)return null;
      const cx=Math.floor(x/.35),cy=Math.floor(y/.35);let best:null|typeof points[number]=null,distance=Infinity;
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const q of cells.get(`${cx+dx}:${cy+dy}`)||[]){
        if(byHeight&&q.z!=null&&Number.isFinite(z)&&Math.abs(q.z-z)>.25)continue;
        const d=Math.hypot(q.x-x,q.y-y);if(d<distance||(d===distance&&best&&Number(q.id.slice(1))<Number(best.id.slice(1)))){distance=d;best=q;}}
      return distance<=.35?best:null;
    };
    for(const raw of (Array.isArray(geometry.points)?geometry.points:[]).slice(0,10000)){
      const p=obj(raw),x=Number(p.x),y=Number(p.y),z=p.z==null?NaN:Number(p.z);if(p.x==null||p.y==null||!Number.isFinite(x)||!Number.isFinite(y)||locate(p))continue;
      const point={x,y,z:Number.isFinite(z)?z:null,id:`C${points.length+1}`},key=`${Math.floor(x/.35)}:${Math.floor(y/.35)}`;points.push(point);if(!cells.has(key))cells.set(key,[]);cells.get(key)!.push(point);
    }
    const edges=new Map<string,{path:string;type:string;xml:string}>();
    for(const raw of lines.slice(0,20000)){
      const line=obj(raw),ends=Array.isArray(line.points)?line.points:[line.start,line.end],a=locate(ends[0]),b=locate(ends[1]);
      const saved=String(line.type||'').toUpperCase().replace(/[\s-]+/g,'_');let type=saved;if(type==='TRANSITION')type='TRANS';if(type==='STEPFLASH')type='SIDE_WALL';
      if(!a||!b||a===b||!TYPES.has(type))continue;
      const path=[a.id,b.id].sort().join(',');edges.set(path,{path,type,xml:xmlType(saved)});
    }
    return edges;
  };
  let edges=classify(false);
  if(xml){
    // How many of the XML's lines a deduplication names with the type the generator wrote for them.
    const xmlLines=[...xml.matchAll(/<LINE\b[^>]*>/gi)].map(([tag])=>({path:(tag.match(/\bpath="([^"]*)"/)?.[1]||'').split(',').map(id=>id.trim()).sort().join(','),type:tag.match(/\btype="([^"]*)"/)?.[1]||''}));
    const agree=(found:typeof edges)=>xmlLines.filter(line=>found.get(line.path)?.xml===line.type).length;
    const byHeight=classify(true);if(agree(byHeight)>agree(edges))edges=byHeight;
  }
  return [...edges.values()].map(({path,type})=>({path,type}));
}
