type Obj = Record<string, unknown>;
const obj=(v:unknown):Obj=>v&&typeof v==='object'&&!Array.isArray(v)?v as Obj:{};
/** XML point ids follow deduplicated saved geometry.points. Do not infer types
 * for endpoints absent from that geometry, or modify the report/export. */
export function reportEdgeTypes(saved:unknown){
  const state=obj(saved),geometry=obj(state.geometry),report=obj(state.report);
  const points: {x:number;y:number;id:string}[]=[];
  const cells=new Map<string,typeof points>();
  const locate=(raw:unknown)=>{
    const p=obj(raw),x=Number(p.x),y=Number(p.y);if(!Number.isFinite(x)||!Number.isFinite(y)||p.x==null||p.y==null)return null;
    const cx=Math.floor(x/.35),cy=Math.floor(y/.35);let best:null|typeof points[number]=null,distance=Infinity;
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const q of cells.get(`${cx+dx}:${cy+dy}`)||[]){const d=Math.hypot(q.x-x,q.y-y);if(d<distance||(d===distance&&best&&Number(q.id.slice(1))<Number(best.id.slice(1)))){distance=d;best=q;}}
    return distance<=.35?best:null;
  };
  for(const raw of (Array.isArray(geometry.points)?geometry.points:[]).slice(0,10000)){
    const p=obj(raw),x=Number(p.x),y=Number(p.y);if(p.x==null||p.y==null||!Number.isFinite(x)||!Number.isFinite(y)||locate(p))continue;
    const point={x,y,id:`C${points.length+1}`},key=`${Math.floor(x/.35)}:${Math.floor(y/.35)}`;points.push(point);if(!cells.has(key))cells.set(key,[]);cells.get(key)!.push(point);
  }
  const lines=Array.isArray(report.lines)&&report.lines.length?report.lines:Array.isArray(geometry.connections)?geometry.connections:[];
  const types=new Set(['RIDGE','HIP','VALLEY','RAKE','EAVE','HEAD_WALL','SIDE_WALL','TRANS','PARAPET','PROTRUSION','CHIMNEY_BACK','CHIMNEY_EDGE','CHIMNEY_FRONT','SKYLIGHT','UNKNOWN']);
  const edges=new Map<string,{path:string;type:string}>();
  for(const raw of lines.slice(0,20000)){
    const line=obj(raw),ends=Array.isArray(line.points)?line.points:[line.start,line.end],a=locate(ends[0]),b=locate(ends[1]);
    let type=String(line.type||'').toUpperCase().replace(/[\s-]+/g,'_');if(type==='TRANSITION')type='TRANS';if(type==='STEPFLASH')type='SIDE_WALL';
    if(!a||!b||a===b||!types.has(type))continue;
    const path=[a.id,b.id].sort().join(',');edges.set(path,{path,type});
  }
  return [...edges.values()];
}
