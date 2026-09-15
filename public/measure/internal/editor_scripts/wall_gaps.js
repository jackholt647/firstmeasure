/* Partial-height wall boundaries and repairs along existing projected wall edges. */
(function(root){
    'use strict';
    const G=typeof module!=='undefined'&&module.exports?require('./wall_geometry.js'):root.WallGeometry;
    const EPS=1e-7,HEIGHT=.02;
    const dist=(a,b)=>Math.hypot(b.x-a.x,b.y-a.y);
    const mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
    const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
    const cross=(a,b)=>a.x*b.y-a.y*b.x;
    function projection(p,a,b){const len=dist(a,b);return len>EPS?((p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y))/(len*len):0;}
    function spanAt(w,p,tol){
        const t=projection(p,...w.bottom),len=dist(...w.bottom);
        if(len<EPS||t<-tol/len||t>1+tol/len)return null;
        const q=mix(...w.bottom,Math.max(0,Math.min(1,t)));if(dist(p,q)>tol)return null;
        return {t:Math.max(0,Math.min(1,t)),lo:q.z,hi:mix(...w.top,Math.max(0,Math.min(1,t))).z};
    }
    function groundHeight(ground,p){
        if(typeof ground==='number')return Number.isFinite(ground)?ground:null;
        if(!ground?.points||!ground?.faces)return null;
        let z=null;
        for(const ids of ground.faces){
            const points=ids.map(i=>ground.points[i]);if(!G.contains({points},p))continue;
            const plane=G.plane(points);if(!plane)continue;
            const value=plane.dx*p.x+plane.dy*p.y+plane.k;
            if(Number.isFinite(value))z=z===null?value:Math.max(z,value);
        }
        return z;
    }
    function detect(walls,ground=0,tolerance=.02){
        const columns=[];
        for(const w of walls)for(const p of w.bottom){if(!columns.some(q=>dist(p,q)<=tolerance))columns.push({x:p.x,y:p.y});}
        const gaps=[];
        for(const p of columns){
            const spans=walls.map((w,i)=>({w,i,s:spanAt(w,p,tolerance)})).filter(v=>v.s&&v.s.hi-v.s.lo>HEIGHT);
            const cuts=[...new Set(spans.flatMap(v=>[v.s.lo,v.s.hi]))].sort((a,b)=>a-b);
            let last=null;
            for(let j=0;j<cuts.length-1;j++){
                const lo=cuts[j],hi=cuts[j+1];if(hi-lo<HEIGHT)continue;
                const z=(lo+hi)/2,active=spans.filter(v=>v.s.lo<z&&v.s.hi>z),rays=[];
                // Count incident directions, including T-junctions inside a face.
                // Duplicate coplanar faces cannot make an open edge look closed.
                for(const {w}of active)for(const q of w.bottom){const len=dist(p,q);if(len<=tolerance)continue;const u={x:(q.x-p.x)/len,y:(q.y-p.y)/len};if(!rays.some(v=>u.x*v.x+u.y*v.y>.999))rays.push(u);}
                if(rays.length!==1){last=null;continue;}
                if(last&&Math.abs(last.top.z-lo)<HEIGHT)last.top.z=hi;
                else {last={id:`gap-${gaps.length+1}`,bottom:{...p,z:lo},top:{...p,z:hi},wallIndices:active.map(v=>v.i)};gaps.push(last);}
            }
        }
        // Only open intervals reaching the terrain are perimeter candidates.
        // An open upper interval does not qualify merely because another wall
        // in the same XY column touches ground somewhere below it.
        return gaps.filter(g=>{
            const z=groundHeight(ground,g.bottom);
            return z!==null&&(Math.abs(g.bottom.z-z)<=tolerance||Math.abs(g.top.z-z)<=tolerance);
        });
    }
    function graph(walls,gaps,snap){
        const nodes=[],segments=[],edges=[];
        const node=p=>{let i=nodes.findIndex(q=>dist(p,q)<=snap);if(i<0){i=nodes.length;nodes.push({x:p.x,y:p.y});}return i;};
        // Distinct open ends must remain distinct even when their separation is
        // smaller than the tolerance used to match the overhead guide lines.
        const anchors=gaps.map(g=>{nodes.push({x:g.bottom.x,y:g.bottom.y});return nodes.length-1;});
        for(const w of walls)for(const edge of ['top','bottom'])if(dist(...w[edge])>.005)segments.push({a:w[edge][0],b:w[edge][1],cuts:[0,1],extend:w.kind==='flashing'});
        // A short roof return can end before its inset wall intersection.
        // Continue its existing supporting line to two nearby open columns,
        // only when that same edge supplies both missing top elevations.
        for(const s of [...segments])for(let i=0;i<gaps.length;i++)for(let j=i+1;j<gaps.length;j++){
            const pair=[gaps[i],gaps[j]],length=dist(s.a,s.b);if(!s.extend||length<.005)continue;
            const hits=pair.map(g=>{const t=projection(g.bottom,s.a,s.b);return {g,t,p:mix(s.a,s.b,t)};}).sort((a,b)=>a.t-b.t);
            if((Math.min(1,hits[1].t)-Math.max(0,hits[0].t))*length<.005||(hits[0].t>=0&&hits[1].t<=1)||hits.some(h=>dist(h.p,h.g.bottom)>.005||Math.abs(h.p.z-h.g.top.z)>HEIGHT))continue;
            if(-hits[0].t*length>.5||(hits[1].t-1)*length>.5)continue;
            segments.push({a:{...hits[0].g.top},b:{...hits[1].g.top},cuts:[0,1]});
        }
        for(let i=0;i<segments.length;i++){
            const a=segments[i],u=sub(a.b,a.a);
            for(const g of gaps){const t=projection(g.bottom,a.a,a.b);if(t>=0&&t<=1&&dist(g.bottom,mix(a.a,a.b,t))<=snap)a.cuts.push(t);}
            for(let j=i+1;j<segments.length;j++){
                const b=segments[j],v=sub(b.b,b.a),q=sub(b.a,a.a),den=cross(u,v);
                if(Math.abs(den)>EPS){const t=cross(q,v)/den,h=cross(q,u)/den;if(t>=0&&t<=1&&h>=0&&h<=1){a.cuts.push(t);b.cuts.push(h);}}
                // Split collinear overlaps and near-coincident endpoints too.
                for(const [s,t]of [[a,b],[b,a]])for(const p of [s.a,s.b]){const x=projection(p,t.a,t.b);if(x>=0&&x<=1&&dist(p,mix(t.a,t.b,x))<=snap)t.cuts.push(x);}
            }
        }
        for(const s of segments){
            const cuts=[...new Set(s.cuts)].sort((a,b)=>a-b);
            for(let i=0;i<cuts.length-1;i++){
                const a=mix(s.a,s.b,cuts[i]),b=mix(s.a,s.b,cuts[i+1]),from=node(a),to=node(b);if(from===to)continue;
                edges.push({from,to,a:{...nodes[from],z:a.z},b:{...nodes[to],z:b.z},length:dist(nodes[from],nodes[to])});
            }
        }
        return {nodes,edges,anchors};
    }
    function covered(walls,p,z,snap){return walls.some(w=>{const s=spanAt(w,p,snap);return s&&s.lo<z+HEIGHT&&s.hi>z-HEIGHT;});}
    function route(net,start,end,walls,z,snap,maxLength){
        const distances=new Map([[start,0]]),previous=new Map(),visited=new Set();
        while(true){
            let current=-1,best=Infinity;for(const [id,d]of distances)if(!visited.has(id)&&d<best){current=id;best=d;}
            if(current<0||best>maxLength)return null;
            if(current===end)break;visited.add(current);
            for(const edge of net.edges){
                if(edge.from!==current&&edge.to!==current)continue;
                if(Math.min(edge.a.z,edge.b.z)<z+HEIGHT||covered(walls,mix(edge.a,edge.b,.5),z,snap))continue;
                const next=edge.from===current?edge.to:edge.from,d=best+edge.length;
                if(d<(distances.get(next)??Infinity)){distances.set(next,d);previous.set(next,{from:current,edge:edge.from===current?edge:{...edge,a:edge.b,b:edge.a}});}
            }
        }
        const path=[];for(let id=end;id!==start;){const p=previous.get(id);if(!p)return null;path.unshift(p.edge);id=p.from;}
        return {path,length:distances.get(end)};
    }
    function cleanSlivers(walls,width=.05){
        let result=JSON.parse(JSON.stringify(walls));const removed=[],heightTolerance=Math.max(.03,Math.min(.15,width));
        for(const candidate of [...result]){
            const w=result.find(v=>v.id===candidate.id);if(!w||dist(...w.bottom)>width)continue;
            const neighbors=w.bottom.map((p,i)=>result.flatMap(v=>v===w?[]:v.bottom.flatMap((q,j)=>dist(p,q)<.02&&dist(p,q)<=dist(w.bottom[1-i],q)+1e-8&&Math.abs(q.z-p.z)<heightTolerance&&Math.abs(v.top[j].z-w.top[i].z)<heightTolerance?[{w:v,j}]:[])));
            if(neighbors.some(ns=>ns.length!==1))continue;const [a,b]=neighbors.map(ns=>ns[0]);if(a.w===b.w||dist(...a.w.bottom)<=width*2||dist(...b.w.bottom)<=width*2)continue;
            const p=a.w.bottom[0],q=b.w.bottom[0],u={x:a.w.bottom[1].x-p.x,y:a.w.bottom[1].y-p.y},v={x:b.w.bottom[1].x-q.x,y:b.w.bottom[1].y-q.y},den=cross(u,v);let corner;
            if(Math.abs(den)>1e-7*dist(...a.w.bottom)*dist(...b.w.bottom)){const t=cross({x:q.x-p.x,y:q.y-p.y},v)/den;corner={x:p.x+u.x*t,y:p.y+u.y*t};}
            else {if(Math.abs(cross({x:q.x-p.x,y:q.y-p.y},u))/dist(...a.w.bottom)>.002)continue;corner=mix(...w.bottom,.5);}
            if(w.bottom.some(p=>dist(p,corner)>width*2))continue;
            const spans=[a,b].map(n=>{const t=projection(corner,...n.w.bottom);return {bottom:mix(...n.w.bottom,t).z,top:mix(...n.w.top,t).z};});
            if(Math.abs(spans[0].bottom-spans[1].bottom)>heightTolerance||Math.abs(spans[0].top-spans[1].top)>heightTolerance)continue;
            const bottom=(spans[0].bottom+spans[1].bottom)/2,top=(spans[0].top+spans[1].top)/2;if(top-bottom<HEIGHT)continue;
            if([a,b].some(n=>dist(n.w.bottom[1-n.j],corner)<=width))continue;
            for(const n of [a,b]){n.w.bottom[n.j]={x:corner.x,y:corner.y,z:bottom};n.w.top[n.j]={x:corner.x,y:corner.y,z:top};}
            result=result.filter(v=>v!==w);removed.push(w.id);
        }
        return {walls:result,removed};
    }
    function joinSourceBreaks(walls,ground){
        const result=JSON.parse(JSON.stringify(walls));
        const origin=w=>w.kind==='perimeter'&&/^R\d+\.\d+$/.test(w.sourceId||'')?w.sourceId.replace(/\.\d+$/,''):null;
        for(let i=0;i<result.length;i++)for(let j=i+1;j<result.length;j++){
            const a=result[i],b=result[j];if(!origin(a)||origin(a)!==origin(b))continue;
            for(const ai of [0,1])for(const bi of [0,1]){
                const p=a.bottom[ai],q=b.bottom[bi],gap=dist(p,q);
                if(gap<1e-6||gap>.05)continue;
                const len=dist(...a.bottom),u=sub(a.bottom[1],a.bottom[0]);
                if(len<.1||dist(...b.bottom)<.1||b.bottom.some(v=>Math.abs(cross(sub(v,a.bottom[0]),u))/len>.002))continue;
                // The remaining ends must point away from the gap, not overlap.
                if(projection(q,...a.bottom)>0&&projection(q,...a.bottom)<1)continue;
                if(projection(p,...b.bottom)>0&&projection(p,...b.bottom)<1)continue;
                const mid=mix(p,q,.5),z=groundHeight(ground,mid);if(z===null)continue;
                const spans=[a,b].map(w=>{const t=projection(mid,...w.bottom);return {lo:mix(...w.bottom,t).z,hi:mix(...w.top,t).z};});
                if(spans.some(v=>Math.abs(v.lo-z)>.02)||Math.abs(spans[0].hi-spans[1].hi)>.002)continue;
                // Do not move a junction belonging to another wall.
                if(result.some(w=>w!==a&&w!==b&&[p,q].some(v=>{const s=spanAt(w,v,.002);return s&&s.lo<Math.min(...spans.map(t=>t.hi))-.02&&s.hi>z+.02;})))continue;
                const bottom={x:mid.x,y:mid.y,z},top={x:mid.x,y:mid.y,z:(spans[0].hi+spans[1].hi)/2};
                a.bottom[ai]={...bottom};b.bottom[bi]={...bottom};a.top[ai]={...top};b.top[bi]={...top};
            }
        }
        return result;
    }
    function repair(walls,ground=0,options={}){
        // Drawing mismatch is allowed in the projected guide path only. Keep
        // actual wall contact, coverage and repair verification at the tighter
        // tolerance so a nearby line cannot simply hide an unfilled opening.
        const cleaned=cleanSlivers(joinSourceBreaks(walls,ground),options.sliverWidth??.05);walls=cleaned.walls;
        const snap=options.snap??.02,pathSnap=options.pathSnap??.05;
        const before=detect(walls,ground,snap),net=graph(walls,before,pathSnap),candidates=[];
        for(let i=0;i<before.length;i++)for(let j=i+1;j<before.length;j++){
            const a=before[i],b=before[j],direct=dist(a.bottom,b.bottom),lo=Math.max(a.bottom.z,b.bottom.z),hi=Math.min(a.top.z,b.top.z);
            if(direct<=snap||direct>12||hi-lo<HEIGHT)continue;
            const r=route(net,net.anchors[i],net.anchors[j],walls,(lo+hi)/2,snap,Math.min(12,Math.max(2,direct*4)));
            if(r)candidates.push({...r,a,b,lo,hi});
        }
        candidates.sort((a,b)=>a.length-b.length);
        let result=walls.slice(),gaps=before;const added=[],paths=[];
        const openAt=(list,p,lo,hi)=>list.filter(g=>dist(g.bottom,p)<=snap).reduce((sum,g)=>sum+Math.max(0,Math.min(hi,g.top.z)-Math.max(lo,g.bottom.z)),0);
        for(const c of candidates){
            const oldA=openAt(gaps,c.a.bottom,c.lo,c.hi),oldB=openAt(gaps,c.b.bottom,c.lo,c.hi);if(oldA<HEIGHT||oldB<HEIGHT)continue;
            const id=`gap-fill-${paths.length+1}`;
            const sources=c.path.map((e,i)=>({id:`${id}.${i}`,a:e.a,b:e.b,kind:'gap-repair',direction:'down',type:'wall'}));
            const proposed=G.extrude({faces:[]},sources,ground).walls;
            // Subtract every already-covered vertical interval, not just flashing.
            const clipped=G.deduplicate([...result.map(w=>({...w,kind:'flashing'})),...proposed],snap).walls.filter(w=>w.kind==='gap-repair');
            if(!clipped.length)continue;
            const next=[...result,...clipped],after=detect(next,ground,snap);
            if(openAt(after,c.a.bottom,c.lo,c.hi)>oldA-HEIGHT||openAt(after,c.b.bottom,c.lo,c.hi)>oldB-HEIGHT)continue;
            const total=gs=>gs.reduce((sum,g)=>sum+g.top.z-g.bottom.z,0);
            if(total(after)>total(gaps)-HEIGHT)continue;
            result=next;gaps=after;added.push(...clipped);paths.push({id,from:c.a.id,to:c.b.id,points:[c.path[0].a,...c.path.map(e=>e.b)],length:c.length});
            if(paths.length>=32)break;
        }
        return {walls:result,added,paths,before,gaps,sliversRemoved:cleaned.removed};
    }
    const api={detect,repair,cleanSlivers};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.WallGaps=api;
})(typeof window!=='undefined'?window:globalThis);
