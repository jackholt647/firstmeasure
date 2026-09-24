/* Pure wall construction in metres (x/y plan, z elevation). No roof mutations. */
(function (root) {
    'use strict';
    const EPS = 1e-6, INCH = 0.0254;
    const mix = (a, b, t) => ({ x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t, z:a.z+(b.z-a.z)*t });
    const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
    const cross = (a,b) => a.x*b.y-a.y*b.x;
    const sub = (a,b) => ({x:a.x-b.x,y:a.y-b.y});
    const clone = x => JSON.parse(JSON.stringify(x));
    function onEdge(p,a,b,tolerance=0.002) {
        const d=sub(b,a), len=distance(a,b);
        if (len<EPS) return distance(p,a)<tolerance;
        const t=((p.x-a.x)*d.x+(p.y-a.y)*d.y)/(len*len);
        return t>=-tolerance/len && t<=1+tolerance/len && Math.abs(cross(sub(p,a),d))/len<=tolerance;
    }
    function inside(p,poly) {
        let yes=false;
        for(let i=0,j=poly.length-1;i<poly.length;j=i++) {
            const a=poly[j],b=poly[i];
            if(onEdge(p,a,b)) return true;
            if((a.y>p.y)!==(b.y>p.y) && p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x) yes=!yes;
        }
        return yes;
    }
    function contains(face,p) { return inside(p,face.points) && !(face.holes||[]).some(h=>inside(p,h)); }
    function plane(points) {
        if(points.length<3)return null;
        // Fit all vertices, rather than extrapolating the first (often very
        // small) triangle across a slightly nonplanar measured roof face.
        const mean=points.reduce((s,p)=>({x:s.x+p.x/points.length,y:s.y+p.y/points.length,z:s.z+p.z/points.length}),{x:0,y:0,z:0});
        let xx=0,xy=0,yy=0,xz=0,yz=0;
        for(const p of points){const x=p.x-mean.x,y=p.y-mean.y,z=p.z-mean.z;xx+=x*x;xy+=x*y;yy+=y*y;xz+=x*z;yz+=y*z;}
        const det=xx*yy-xy*xy;if(det<=1e-12*Math.max(xx*yy,1e-12))return null;
        const dx=(xz*yy-yz*xy)/det,dy=(yz*xx-xz*xy)/det;
        return {dx,dy,k:mean.z-dx*mean.x-dy*mean.y};
    }
    const height = (f,p) => f.plane.dx*p.x+f.plane.dy*p.y+f.plane.k;
    function surfaces(roof) {
        return (roof.faces||[]).map((f,i)=>({...f,id:f.id??i,plane:plane(f.points)})).filter(f=>f.plane);
    }
    function parentFace(faces,a,b) {
        const mid=mix(a,b,.5);
        const boundary=faces.filter(f=>[f.points,...(f.holes||[])].some(poly=>poly.some((p,i)=>{
            const q=poly[(i+1)%poly.length],len=distance(p,q);
            if(len<EPS||!onEdge(mid,p,q))return false;
            const t=((mid.x-p.x)*(q.x-p.x)+(mid.y-p.y)*(q.y-p.y))/(len*len);
            return Math.abs(mix(p,q,t).z-mid.z)<.12;
        })));
        if(boundary.length)return boundary.sort((f,g)=>Math.abs(height(f,mid)-mid.z)-Math.abs(height(g,mid)-mid.z))[0];
        return faces.filter(f=>contains(f,mid) && Math.abs(height(f,mid)-mid.z)<.12)
            .sort((f,g)=>Math.abs(height(f,mid)-mid.z)-Math.abs(height(g,mid)-mid.z))[0];
    }
    const isFlashing = type => ['head_wall','side_wall','roof_to_wall','headwall','sidewall','roof-to-wall'].includes(type);
    // A surveyed contact can also have a duplicate rake connection. It is
    // attached to masonry, not a free roof edge with an overhang. Compare in
    // 3D so an unrelated edge on another roof layer keeps its own soffit.
    function chimneyContact(roof,a,b){
        return (roof.connections||[]).some(e=>{
            if(!String(e.type).startsWith('chimney'))return false;
            const p=roof.points[e.startIdx],q=roof.points[e.endIdx];if(!p||!q)return false;
            const length=distance(p,q);if(length<EPS)return false;
            return [a,b].every(v=>{const t=((v.x-p.x)*(q.x-p.x)+(v.y-p.y)*(q.y-p.y))/(length*length);return onEdge(v,p,q,.002)&&Math.abs(v.z-mix(p,q,t).z)<.02;});
        });
    }
    // Connected roof pitches form one support layer. Flashing and chimney
    // boundaries separate layers even when their measured endpoints coincide.
    function roofLayers(roof,faces) {
        const groups=faces.map(f=>[f]),same=(a,b)=>distance(a,b)<.002&&Math.abs(a.z-b.z)<.02;
        const edges=(roof.connections||[]).filter(e=>isFlashing(e.type)||['eave','rake'].includes(e.type)||String(e.type).startsWith('chimney')).map(e=>[roof.points[e.startIdx],roof.points[e.endIdx]]);
        for(let i=0;i<faces.length;i++)for(let j=i+1;j<faces.length;j++){
            const a=faces[i],b=faces[j],shared=a.points.filter(p=>b.points.some(q=>same(p,q)));
            if(shared.length<2)continue;
            const linked=shared.some((p,k)=>shared.slice(k+1).some(q=>distance(p,q)>.01&&a.points.some((v,n)=>onEdge(p,v,a.points[(n+1)%a.points.length])&&onEdge(q,v,a.points[(n+1)%a.points.length]))&&b.points.some((v,n)=>onEdge(p,v,b.points[(n+1)%b.points.length])&&onEdge(q,v,b.points[(n+1)%b.points.length]))&&!edges.some(([v,w])=>v&&w&&onEdge(p,v,w)&&onEdge(q,v,w))));
            if(!linked)continue;const ga=groups.find(g=>g.includes(a)),gb=groups.find(g=>g.includes(b));if(ga!==gb){ga.push(...gb);groups.splice(groups.indexOf(gb),1);}
        }
        return new Map(groups.flatMap(g=>g.map(f=>[f.id,g])));
    }
    function layerSetback(layer,wanted){
        const vertices=layer.flatMap(f=>f.points);let limit=wanted;
        for(const f of layer)for(let i=0;i<f.points.length;i++){
            const a=f.points[i],b=f.points[(i+1)%f.points.length],length=distance(a,b);if(length<EPS)continue;
            const n={x:(b.y-a.y)/length,y:(a.x-b.x)/length},values=vertices.map(p=>p.x*n.x+p.y*n.y);
            limit=Math.min(limit,Math.max(0,(Math.max(...values)-Math.min(...values)-12*INCH)/2));
        }return limit;
    }
    function normalFor(face,a,b) {
        const len=distance(a,b),n={x:-(b.y-a.y)/len,y:(b.x-a.x)/len},m=mix(a,b,.5);
        if(contains(face,{x:m.x+n.x*.02,y:m.y+n.y*.02})) return n;
        if(contains(face,{x:m.x-n.x*.02,y:m.y-n.y*.02})) return {x:-n.x,y:-n.y};
        return null;
    }
    function inferredSetback(edge,flashing,n) {
        const len=distance(edge.a,edge.b),u={x:(edge.b.x-edge.a.x)/len,y:(edge.b.y-edge.a.y)/len};
        const matches=[];
        for(const f of flashing) {
            const fl=distance(f.a,f.b); if(fl<EPS) continue;
            if(Math.abs(cross(u,{x:(f.b.x-f.a.x)/fl,y:(f.b.y-f.a.y)/fl}))>.0872) continue;
            const ts=[f.a,f.b].map(p=>(p.x-edge.a.x)*u.x+(p.y-edge.a.y)*u.y).sort((a,b)=>a-b);
            const overlap=Math.min(len,ts[1])-Math.max(0,ts[0]);
            if(overlap<.15) continue;
            const mid=mix(f.a,f.b,.5),d=(mid.x-edge.a.x)*n.x+(mid.y-edge.a.y)*n.y;
            if(d>=.05 && d<=2 && mid.z<mix(edge.a,edge.b,.5).z-.02) matches.push({id:f.id,d,overlap});
        }
        // Weight by supported length: tiny overlaps with the neighboring walls
        // must not outvote the long flashing directly beneath a projecting eave.
        const half=matches.reduce((sum,m)=>sum+m.overlap,0)/2;
        let weight=0;for(const m of matches.sort((a,b)=>a.d-b.d)){weight+=m.overlap;if(weight>=half)return {distance:m.d,coverage:matches.filter(f=>Math.abs(f.d-m.d)<.02).reduce((sum,f)=>sum+f.overlap,0)/len,sourceIds:matches.filter(f=>Math.abs(f.d-m.d)<.02).map(f=>f.id)};}
        return null;
    }
    function soffitWithoutSources(source,sources,excluded){
        if(!source.inferred||!source.originalA||!source.setbackFrom?.some(id=>excluded.includes(id)))return null;
        const a=source.originalA,b=source.originalB,len=distance(a,b),u=sub(b,a),n={x:-u.y/len,y:u.x/len};
        const shift=sub(source.a,a);if(n.x*shift.x+n.y*shift.y<0){n.x*=-1;n.y*=-1;}
        const flashing=sources.filter(f=>f.kind==='flashing'&&f.parentId!==source.parentId&&!excluded.includes(f.id));
        const inference=inferredSetback({a,b},flashing,n);
        return {setback:inference?.distance??18*INCH,inferred:!!inference,normal:n};
    }
    // A lower layer reaching an upper eave needs room up to its head flashing.
    // This is a construction clearance, independent of the selected soffit.
    // Finite overlap, height and boundary checks exclude interior dormers and
    // unrelated parallel roof edges.
    function lowerLayerClearance(edge,flashing,faces,parent,n){
        const len=distance(edge.a,edge.b),u={x:(edge.b.x-edge.a.x)/len,y:(edge.b.y-edge.a.y)/len};
        let setback=0;const roofIds=[];
        for(const f of flashing){
            if(!['head_wall','headwall','roof_to_wall','roof-to-wall'].includes(f.type))continue;
            const fl=distance(f.a,f.b);if(fl<EPS||Math.abs(cross(u,{x:(f.b.x-f.a.x)/fl,y:(f.b.y-f.a.y)/fl}))>.002)continue;
            const ts=[f.a,f.b].map(p=>(p.x-edge.a.x)*u.x+(p.y-edge.a.y)*u.y).sort((a,b)=>a-b);
            if(Math.min(len,ts[1])-Math.max(0,ts[0])<.002)continue;
            const depth=p=>(p.x-edge.a.x)*n.x+(p.y-edge.a.y)*n.y,required=Math.max(depth(f.a),depth(f.b));
            if(Math.min(depth(f.a),depth(f.b))<0)continue;
            const lower=parentFace(faces,f.a,f.b);if(!lower||lower===parent)continue;
            const depths=lower.points.map(depth);
            if(Math.min(...depths)>.02||Math.max(...depths)>required+.02)continue;
            const mid=mix(f.a,f.b,.5);if(!contains({...parent,holes:[]},mid)||height(parent,mid)<=mid.z+.02)continue;
            setback=Math.max(setback,required);roofIds.push(lower.id);
        }
        return {setback,roofIds};
    }
    function intersectionT(a,b,c,d) {
        const u=sub(b,a),v=sub(d,c),den=cross(u,v);
        if(Math.abs(den)<EPS) return null;
        const t=cross(sub(c,a),v)/den,s=cross(sub(c,a),u)/den;
        return s>=-EPS && s<=1+EPS && t>EPS && t<1-EPS ? t : null;
    }
    function splitParameters(a,b,faces) {
        const ts=[0,1];
        for(const f of faces) for(const poly of [f.points,...(f.holes||[])]) {
            poly.forEach((p,i)=>{const t=intersectionT(a,b,p,poly[(i+1)%poly.length]); if(t!==null)ts.push(t);});
        }
        return [...new Set(ts.map(t=>+t.toFixed(8)))].sort((a,b)=>a-b);
    }
    // Propagate surveyed eave offsets only through connected eaves on one roof
    // layer. Compare evaluated heights; never flatten or move a roof plane.
    function driveSoffits(sources,faces,layers){
        const runs=sources.filter(s=>s.kind==='perimeter'&&s.type==='eave'),resolved=new Map(),neighbors=new Map(runs.map(s=>[s,[]]));
        const same=(a,b)=>distance(a,b)<.005&&Math.abs(a.z-b.z)<.02;
        for(let i=0;i<runs.length;i++)for(let j=i+1;j<runs.length;j++){
            const a=runs[i],b=runs[j];if(layers.get(a.parentId)!==layers.get(b.parentId))continue;
            if([a.originalA,a.originalB].some(p=>[b.originalA,b.originalB].some(q=>same(p,q)))){neighbors.get(a).push(b);neighbors.get(b).push(a);}
        }
        const point=(s,p,depth)=>{const n=normalFor(faces.find(f=>f.id===s.parentId),s.originalA,s.originalB),q={x:p.x+n.x*depth,y:p.y+n.y*depth};return {...q,z:height({plane:s.sourcePlane},q)};};
        for(const s of runs)if(s.inferred||s.boundaryReference||s.junctionSetback||Number.isFinite(s.contactSetback)&&Math.abs(s.setback-s.contactSetback)<.002){
            if(s.clearanceRoofIds?.length)continue;
            const h=(s.a.z+s.b.z)/2;resolved.set(s,{height:h,root:s.id});s.drivenSoffit={anchor:true,referenceHeight:h,sourceId:s.id};
        }
        // Synchronous waves avoid connection-order dependence and allow measured
        // contacts at both ends to compete before a new section propagates.
        for(let pass=0;pass<runs.length;pass++){
            const next=[];
            for(const s of runs){if(resolved.has(s)||s.clearanceRoofIds?.length)continue;const adjacent=neighbors.get(s).filter(n=>resolved.has(n));if(!adjacent.length)continue;
                const choices=adjacent.flatMap(n=>{const ref=resolved.get(n);return [...new Set([s.setback,n.setback])].map(depth=>{
                    depth=layerSetback(layers.get(s.parentId),depth);const a=point(s,s.originalA,depth),b=point(s,s.originalB,depth);
                    return {depth,a,b,ref,score:Math.max(Math.abs(a.z-ref.height),Math.abs(b.z-ref.height)),default:Math.abs(depth-s.setback)<.000001};
                });});
                choices.sort((a,b)=>Math.abs(a.score-b.score)>.001?a.score-b.score:Number(b.default)-Number(a.default)||a.depth-b.depth||a.ref.height-b.ref.height);
                next.push({s,best:choices[0]});
            }
            if(!next.length)break;
            for(const {s,best:b}of next){s.drivenSoffit={sourceId:b.ref.root,referenceHeight:b.ref.height,defaultSetback:s.setback,chosenSetback:b.depth};s.setback=b.depth;s.a=b.a;s.b=b.b;resolved.set(s,b.ref);}
        }
    }
    function buildSources(roof,options={}) {
        // New From Roof presets use a fixed default; legacy saved Auto retains its inferred sources.
        if(options.soffit==='auto'&&Number.isFinite(options.defaultSoffitInches))options={...options,soffit:options.defaultSoffitInches};
        const faces=surfaces(roof),warnings=[],sources=[],layers=roofLayers(roof,faces);
        const edges=(roof.connections||[]).map((c,i)=>({id:`R${i+1}`,a:roof.points[c.startIdx],b:roof.points[c.endIdx],type:c.type})).filter(e=>e.a&&e.b&&distance(e.a,e.b)>.01);
        const flashing=edges.filter(e=>isFlashing(e.type));
        for(const e of edges) {
            if(!isFlashing(e.type) && !['eave','rake'].includes(e.type)) continue;
            if(options.roofContacts&&chimneyContact(roof,e.a,e.b))continue;
            const parent=parentFace(faces,e.a,e.b);
            if(isFlashing(e.type)) { sources.push({...clone(e),kind:'flashing',direction:'up',parentId:parent?.id,setback:0}); continue; }
            if(!parent) { warnings.push(`${e.id}: no resolved roof face for ${e.type}.`); continue; }
            const n=normalFor(parent,e.a,e.b); if(!n) {warnings.push(`${e.id}: cannot determine inward side.`);continue;}
            const inferred=options.soffit==='auto' ? inferredSetback(e,flashing.filter(f=>parentFace(faces,f.a,f.b)!==parent),n) : null;
            let setback=options.soffit==='auto' ? (inferred?.distance??18*INCH) : Number(options.soffit??18)*INCH;
            const contact=inferredSetback(e,flashing.filter(f=>parentFace(faces,f.a,f.b)!==parent),n);
            if(options.roofContacts&&contact?.coverage>=.45&&e.type==='eave')setback=options.drivenSoffits!==false&&Number(options.soffit)!==0?contact.distance:Math.min(setback,contact.distance);
            // Preserve at least a foot across a narrow roof-supported body.
            // Measure the whole connected layer, not an individual hip triangle.
            setback=layerSetback(layers.get(parent.id),setback);
            const clearance=options.roofContacts&&e.type==='eave'?lowerLayerClearance(e,flashing,faces,parent,n):null;
            if(clearance)setback=Math.max(setback,clearance.setback);
            // Keep measured edge heights exact, using the parent only for the
            // inward pitch. A best-fit face need not pass through every vertex.
            const len=distance(e.a,e.b),u={x:(e.b.x-e.a.x)/len,y:(e.b.y-e.a.y)/len};
            const along=(e.b.z-e.a.z)/len,inward=parent.plane.dx*n.x+parent.plane.dy*n.y;
            const dx=along*u.x+inward*n.x,dy=along*u.y+inward*n.y;
            const sourcePlane={dx,dy,k:e.a.z-dx*e.a.x-dy*e.a.y};
            const shifted=p=>{const q={x:p.x+n.x*setback,y:p.y+n.y*setback};return {...q,z:height({plane:sourcePlane},q)};};
            sources.push({...clone(e),a:shifted(e.a),b:shifted(e.b),originalA:clone(e.a),originalB:clone(e.b),sourcePlane,kind:'perimeter',direction:'down',parentId:parent.id,setback,inferred:inferred!==null,...(options.roofContacts&&contact?{contactSetback:contact.distance}:{}),...(clearance?.roofIds.length?{clearanceRoofIds:clearance.roofIds}:{}),...(inferred?{setbackFrom:inferred.sourceIds}:{})});
        }
        // A measured side wall ending at the lower roof's eave is a finite
        // junction. Keep the adjoining upper wall at that end plane instead of
        // insetting past it and leaving an unsupported flashing wing outside.
        const junctions=[];
        if(options.roofContacts)for(const s of sources.filter(s=>s.kind==='perimeter'&&s.contactSetback!==undefined)){
            const len=distance(s.originalA,s.originalB),u={x:(s.originalB.x-s.originalA.x)/len,y:(s.originalB.y-s.originalA.y)/len},n=normalFor(faces.find(g=>g.id===s.parentId),s.originalA,s.originalB);
            const contactPoint={x:s.originalA.x+n.x*s.contactSetback,y:s.originalA.y+n.y*s.contactSetback};
            for(const f of sources.filter(f=>f.kind==='flashing'&&['side_wall','sidewall'].includes(f.type))){
                if(Math.abs(cross(u,sub(f.b,f.a)))>distance(f.a,f.b)*.002||[f.a,f.b].some(p=>Math.abs(cross(u,sub(p,contactPoint)))>.005))continue;
                const lower=faces.find(g=>g.id===f.parentId);if(!lower)continue;
                for(const end of [f.a,f.b]){
                    const boundary=edges.some(e=>['eave','rake'].includes(e.type)&&onEdge(end,e.a,e.b,.005)&&Math.abs(mix(e.a,e.b,Math.max(0,Math.min(1,((end.x-e.a.x)*(e.b.x-e.a.x)+(end.y-e.a.y)*(e.b.y-e.a.y))/distance(e.a,e.b)**2))).z-end.z)<.02&&parentFace(faces,e.a,e.b)?.id===lower.id);
                    if(!boundary)continue;
                    for(const t of sources.filter(t=>t.kind==='perimeter'&&t!==s&&[t.originalA,t.originalB].some(p=>[s.originalA,s.originalB].some(q=>distance(p,q)<.005&&Math.abs(p.z-q.z)<.02)))){
                        const n=normalFor(faces.find(g=>g.id===t.parentId),t.originalA,t.originalB);if(!n||Math.abs(cross(u,sub(t.originalB,t.originalA)))/distance(t.originalA,t.originalB)<.02)continue;
                        const limit=(end.x-t.originalA.x)*n.x+(end.y-t.originalA.y)*n.y;
                        if(limit<0||limit>=t.setback-.002||t.clearanceRoofIds?.length)continue;
                        junctions.push({source:t,limit,n,flashingId:f.id});
                    }
                    s.boundaryReference=true;s.setback=s.contactSetback;
                    for(const [k,original]of [['a','originalA'],['b','originalB']]){const p=s[original],q={x:p.x+n.x*s.setback,y:p.y+n.y*s.setback};s[k]={...q,z:height({plane:s.sourcePlane},q)};}
                }
            }
        }
        for(const {source:s,limit,n,flashingId}of junctions){
            if(limit>=s.setback)continue;s.setback=limit;s.junctionSetback={maximum:limit,flashingId};
            for(const [k,original]of [['a','originalA'],['b','originalB']]){const p=s[original],q={x:p.x+n.x*limit,y:p.y+n.y*limit};s[k]={...q,z:height({plane:s.sourcePlane},q)};}
        }
        if(options.roofContacts&&options.drivenSoffits!==false&&Number(options.soffit)!==0)driveSoffits(sources,faces,layers);
        // A short return/flashing/return chain inside two overlapping exterior
        // edges is an overlap seam, not a recess in the building. Resolve it
        // from measured roof edges before inset miters can invert the chain.
        const seamRemoved=new Set();
        const perimeterPairs=sources.filter(s=>s.kind==='perimeter'&&s.setback>0);
        for(let i=0;i<perimeterPairs.length;i++)for(let j=i+1;j<perimeterPairs.length;j++){
            const a=perimeterPairs[i],b=perimeterPairs[j],la=distance(a.originalA,a.originalB),lb=distance(b.originalA,b.originalB);
            if(a.parentId===b.parentId||Math.min(la,lb)<2)continue;
            const u=sub(a.originalB,a.originalA),v=sub(b.originalB,b.originalA);
            if(Math.abs(cross(u,v))/(la*lb)>.01||[b.originalA,b.originalB].some(p=>Math.abs(cross(sub(p,a.originalA),u))/la>.0254))continue;
            const na=normalFor(faces.find(f=>f.id===a.parentId),a.originalA,a.originalB),nb=normalFor(faces.find(f=>f.id===b.parentId),b.originalA,b.originalB);
            if(!na||!nb||na.x*nb.x+na.y*nb.y<.999)continue;
            const at=p=>((p.x-a.originalA.x)*u.x+(p.y-a.originalA.y)*u.y)/la;
            const ts=[at(b.originalA),at(b.originalB)].sort((x,y)=>x-y),lo=Math.max(0,ts[0]),hi=Math.min(la,ts[1]);if(hi-lo<.15)continue;
            const near=(p,q)=>distance(p,q)<.01&&Math.abs(p.z-q.z)<.05;
            const returns=s=>perimeterPairs.filter(r=>r!==s&&r.parentId===s.parentId&&distance(r.originalA,r.originalB)<1&&[r.originalA,r.originalB].some(p=>[s.originalA,s.originalB].some(q=>near(p,q))));
            let chain=null;
            for(const ra of returns(a))for(const rb of returns(b))for(const f of flashing){
                const ends=[ra.originalA,ra.originalB],other=[rb.originalA,rb.originalB];
                if([f.a,f.b].every(p=>[...ends,...other].some(q=>near(p,q)))&&ends.some(p=>near(p,f.a)||near(p,f.b))&&other.some(p=>near(p,f.a)||near(p,f.b)))chain={ra,rb,f};
            }
            if(!chain)continue;
            // Preserve the deeper of the two near-identical inset planes.
            const middle=mix(a.originalA,a.originalB,(lo+hi)/(2*la));
            const offset=s=>(s.a.x-middle.x)*na.x+(s.a.y-middle.y)*na.y;
            const anchor=offset(a)>=offset(b)?a:b,other=anchor===a?b:a;
            const d=sub(anchor.b,anchor.a),len=distance(anchor.a,anchor.b);
            for(const key of ['a','b']){const p=other[key],t=((p.x-anchor.a.x)*d.x+(p.y-anchor.a.y)*d.y)/(len*len),q=mix(anchor.a,anchor.b,t);other[key]={x:q.x,y:q.y,z:height({plane:other.sourcePlane},q)};}
            const project=t=>{const p=mix(a.originalA,a.originalB,t/la),axis=sub(anchor.b,anchor.a),length=distance(anchor.a,anchor.b),v=((p.x-anchor.a.x)*axis.x+(p.y-anchor.a.y)*axis.y)/(length*length);return mix(anchor.a,anchor.b,v);};
            const start=project(lo),end=project(hi),dz=p=>height({plane:a.sourcePlane},p)-height({plane:b.sourcePlane},p),da=dz(start),db=dz(end);
            const fraction=da*db<0?da/(da-db):(Math.abs(da)<Math.abs(db)?0:1),join=mix(start,end,fraction);
            for(const source of [a,b]){
                const key=distance(source.a,join)<distance(source.b,join)?'a':'b';
                source[key]={...join,z:height({plane:source.sourcePlane},join)};
                source.overlapSeam={a:start,b:end};
            }
            for(const id of [chain.ra.id,chain.rb.id,chain.f.id])seamRemoved.add(id);
        }
        for(let i=sources.length-1;i>=0;i--)if(seamRemoved.has(sources[i].id))sources.splice(i,1);
        for(let i=flashing.length-1;i>=0;i--)if(seamRemoved.has(flashing[i].id))flashing.splice(i,1);
        // A straight fascia remains one wall plane across a ridge. An inferred
        // setback on one roof pitch also applies to its collinear continuation.
        if(options.soffit==='auto'){
            const remaining=new Set(sources.filter(s=>s.kind==='perimeter'));
            while(remaining.size){const group=[remaining.values().next().value];remaining.delete(group[0]);
                for(let i=0;i<group.length;i++)for(const b of remaining){const a=group[i],u=sub(a.originalB,a.originalA),v=sub(b.originalB,b.originalA),la=distance(a.originalA,a.originalB),lb=distance(b.originalA,b.originalB);
                    if(Math.abs(cross(u,v))/(la*lb)>1e-5||![a.originalA,a.originalB].some(p=>[b.originalA,b.originalB].some(q=>distance(p,q)<.01&&Math.abs(p.z-q.z)<.05)))continue;
                    const na=sub(a.a,a.originalA),nb=sub(b.a,b.originalA);if(na.x*nb.x+na.y*nb.y<0)continue;group.push(b);remaining.delete(b);
                }
                const inferred=group.filter(s=>s.inferred).sort((a,b)=>distance(b.originalA,b.originalB)-distance(a.originalA,a.originalB))[0];if(!inferred)continue;
                for(const s of group){if(s.setback===inferred.setback){s.inferred=true;s.setbackFrom=clone(inferred.setbackFrom||[]);continue;}const n=normalFor(faces.find(f=>f.id===s.parentId),s.originalA,s.originalB);if(!n)continue;s.setback=inferred.setback;s.inferred=true;s.setbackFrom=clone(inferred.setbackFrom||[]);
                    for(const [k,original]of [['a','originalA'],['b','originalB']]){const p=s[original],q={x:p.x+n.x*s.setback,y:p.y+n.y*s.setback};s[k]={...q,z:height({plane:s.sourcePlane},q)};}
                }
            }
        }
        // Overlapping roof layers can describe one exterior side twice. A
        // shared wall follows the more inward plane, preserving the deeper soffit
        // rather than shortening it to match a longer roof edge. Reconcile only
        // nearby, overlapping, same-facing parallel runs.
        const envelopes=[];
        if(Number.isFinite(Number(options.soffit))){
            const perimeter=sources.filter(s=>s.kind==='perimeter'&&s.setback>0);
            for(const upper of perimeter){
                const len=distance(upper.originalA,upper.originalB),u={x:(upper.originalB.x-upper.originalA.x)/len,y:(upper.originalB.y-upper.originalA.y)/len},parent=faces.find(f=>f.id===upper.parentId),n=normalFor(parent,upper.originalA,upper.originalB);
                const choices=[];
                for(const lower of perimeter){
                    if(lower===upper||lower.parentId===upper.parentId)continue;
                    const l=distance(lower.originalA,lower.originalB),v={x:(lower.originalB.x-lower.originalA.x)/l,y:(lower.originalB.y-lower.originalA.y)/l},lp=faces.find(f=>f.id===lower.parentId),ln=normalFor(lp,lower.originalA,lower.originalB);
                    if(l<Math.min(2,len*.5)||!ln||Math.abs(cross(u,v))>.001||n.x*ln.x+n.y*ln.y<.999)continue;
                    const setback=(lower.a.x-upper.originalA.x)*n.x+(lower.a.y-upper.originalA.y)*n.y,shift=upper.setback-setback;
                    if(setback<.002||shift<.005||shift>upper.setback+.002)continue;
                    const ts=[lower.originalA,lower.originalB].map(p=>(p.x-upper.originalA.x)*u.x+(p.y-upper.originalA.y)*u.y).sort((a,b)=>a-b),lo=Math.max(0,ts[0]),hi=Math.min(len,ts[1]);
                    if(hi-lo<Math.max(.3,2*shift))continue;
                    const mid={x:upper.originalA.x+u.x*(lo+hi)/2+n.x*setback,y:upper.originalA.y+u.y*(lo+hi)/2+n.y*setback};
                    if(!contains(parent,mid)||!contains(lp,mid)||height(parent,mid)<=height(lp,mid)+.02)continue;
                    // Roof pitches which cross in the shared interval are a real
                    // junction, not an upper layer hiding a duplicate facade.
                    const at=t=>({x:upper.originalA.x+u.x*t+n.x*setback,y:upper.originalA.y+u.y*t+n.y*setback}),a=at(lo),b=at(hi),cuts=splitParameters(a,b,[parent,lp]);
                    const crossed=cuts.some((t,i)=>{if(!i)return false;const mid=mix(a,b,(cuts[i-1]+t)/2);if(!contains(parent,mid)||!contains(lp,mid))return false;return [cuts[i-1],t].some(q=>{const p=mix(a,b,q);return height(parent,p)<height(lp,p)-.02;});});
                    if(crossed)continue;
                    choices.push({lower,setback,n,parent});
                }
                const choice=choices.sort((a,b)=>a.setback-b.setback)[0];if(!choice)continue;
                // Both candidate offsets use the upper roof edge and inward normal.
                // A greater offset means a deeper overhang for both roof layers.
                choice.followUpper=upper.setback>=choice.setback;
                // Keep measured return evidence even if its rendered flashing is
                // hidden by the overlap. Cleanup needs the full chain to close
                // a clipped transition between the two inset wall planes.
                const lowerFace=faces.find(f=>f.id===choice.lower.parentId),returnGuides=flashing.filter(f=>[f.a,f.b].every(p=>lowerFace.points.some((a,i)=>onEdge(p,a,lowerFace.points[(i+1)%lowerFace.points.length],.01)))).map(f=>({...clone(f),kind:'flashing',parentId:choice.lower.parentId}));
                upper.outerEnvelope={sourceId:choice.lower.id,parentId:choice.lower.parentId,previousSetback:upper.setback,returnGuides};if(!choice.followUpper)upper.setback=choice.setback;
                for(const [key,original]of [['a','originalA'],['b','originalB']]){const p=upper[original],q={x:p.x+n.x*upper.setback,y:p.y+n.y*upper.setback};upper[key]={...q,z:height({plane:upper.sourcePlane},q)};}
                envelopes.push({upper,...choice});
            }
        }
        // Miter adjacent inset edges so the exterior closes at eave/rake corners.
        const perimeters=sources.filter(s=>s.kind==='perimeter');
        for(let i=0;i<perimeters.length;i++) for(let j=i+1;j<perimeters.length;j++) {
            const a=perimeters[i],b=perimeters[j];
            for(const ka of ['a','b']) for(const kb of ['a','b']) {
                const oa=a[ka==='a'?'originalA':'originalB'],ob=b[kb==='a'?'originalA':'originalB'];
                if(distance(oa,ob)>.01 || Math.abs(oa.z-ob.z)>.05) continue;
                const u=sub(a.b,a.a),v=sub(b.b,b.a),den=cross(u,v); if(Math.abs(den)<EPS)continue;
                const t=cross(sub(b.a,a.a),v)/den,p={x:a.a.x+u.x*t,y:a.a.y+u.y*t};
                if(distance(p,oa)>Math.max(a.setback,b.setback)*4+.01)continue;
                for(const [s,k] of [[a,ka],[b,kb]]) s[k]={...p,z:height({plane:s.sourcePlane},p)};
            }
        }
        // At an eave/flashing corner only the eave is inset. Join its shifted
        // endpoint to the flashing plane, rather than leaving a soffit-sized gap.
        for(const s of perimeters)for(const k of ['a','b']){
            const corner=s[k==='a'?'originalA':'originalB'];
            const joins=[];
            for(const f of flashing){
                if(![f.a,f.b].some(p=>distance(p,corner)<.01&&Math.abs(p.z-corner.z)<.05))continue;
                const u=sub(s.b,s.a),v=sub(f.b,f.a),den=cross(u,v);if(Math.abs(den)<EPS)continue;
                const t=cross(sub(f.a,s.a),v)/den,p={x:s.a.x+u.x*t,y:s.a.y+u.y*t};
                if(distance(p,corner)>s.setback*4+.01||!onEdge(p,f.a,f.b))continue;
                joins.push(p);
            }
            joins.sort((a,b)=>distance(a,corner)-distance(b,corner));
            if(joins.length)s[k]={...joins[0],z:height({plane:s.sourcePlane},joins[0])};
        }
        // Resolve only the shared interval. The other roof retains its own
        // wall plane beyond the overlap, including the far chimney corner.
        const envelopeContains=(e,p)=>contains(e.parent,p)&&(!e.followUpper||e.caps.every(c=>cross(sub(c.b,c.a),sub(p,c.a))*c.side>=-EPS));
        for(const e of envelopes){
            const {upper,lower,n,parent,followUpper}=e;if(!followUpper)continue;
            // Preserve real miter corners. Embedded flashing may terminate inside
            // the overlapping roof, so there the enclosing roof boundary wins.
            const mid=mix(upper.a,upper.b,.5);
            e.caps=[upper.a,upper.b].filter(p=>!flashing.some(f=>onEdge(p,f.a,f.b,.005))).map(p=>{
                const a=p,b={x:p.x+n.x,y:p.y+n.y};return {a,b,side:Math.sign(cross(sub(b,a),sub(mid,a)))};
            });
            const project=p=>{const d=(upper.a.x-p.x)*n.x+(upper.a.y-p.y)*n.y,q={x:p.x+n.x*d,y:p.y+n.y*d};return {...q,z:height({plane:lower.sourcePlane},q)};};
            const a=project(lower.a),b=project(lower.b),cuts=splitParameters(a,b,[parent]);
            const addCross=values=>{if(values[0]*values[1]<0)cuts.push(values[0]/(values[0]-values[1]));};
            for(const c of e.caps)addCross([a,b].map(p=>cross(sub(c.b,c.a),sub(p,c.a))));
            addCross([a,b].map(p=>height(parent,p)-p.z-.02));
            cuts.sort((a,b)=>a-b);
            const parts=[];
            for(let i=1;i<cuts.length;i++){
                const start=mix(a,b,cuts[i-1]),end=mix(a,b,cuts[i]),mid=mix(start,end,.5);
                if(distance(start,end)<.005||!envelopeContains(e,mid)||height(parent,mid)<=mid.z+.02)continue;
                parts.push({...lower,id:lower.id+'.aligned'+parts.length,a:start,b:end,soffitAlignment:{sourceId:upper.id},setback:lower.setback+upper.setback-e.setback});
            }
            for(const part of parts)for(const p of [part.a,part.b]){
                const edges=[...e.caps,...parent.points.map((a,i)=>({a,b:parent.points[(i+1)%parent.points.length]}))];
                const edge=edges.find(c=>Math.abs(cross(sub(c.b,c.a),sub(p,c.a)))/distance(c.a,c.b)<.005);
                if(!edge)continue;
                const v=sub(lower.b,lower.a),w=sub(edge.b,edge.a),den=cross(v,w);if(Math.abs(den)<EPS)continue;
                const t=cross(sub(edge.a,lower.a),w)/den;if(t<0||t>1)continue;
                const q=mix(lower.a,lower.b,t);if(distance(p,q)<.005)continue;
                sources.push({...lower,id:lower.id+'.return'+sources.length,a:{...p,z:height({plane:upper.sourcePlane},p)},b:q,envelopeReturn:true,envelopeParentId:parent.id});
            }
            for(const part of parts)for(const p of [part.a,part.b]){
                const v=sub(upper.b,upper.a),len=distance(upper.a,upper.b),t=((p.x-upper.a.x)*v.x+(p.y-upper.a.y)*v.y)/(len*len);
                const key=t<0?'a':t>1?'b':null;
                if(key&&distance(p,upper[key])<=upper.setback*2&&flashing.some(f=>onEdge(upper[key],f.a,f.b,.005)))upper[key]={...p,z:height({plane:upper.sourcePlane},p)};
            }
            sources.push(...parts);
        }
        const clipped=[];
        const hiddenByEnvelope=(s,p)=>envelopes.some(e=>s.parentId===e.lower.parentId&&
            !s.soffitAlignment&&!s.envelopeReturn&&(e.followUpper||(p.x-e.upper.a.x)*e.n.x+(p.y-e.upper.a.y)*e.n.y>.002)&&envelopeContains(e,p)&&height(e.parent,p)>p.z+.02);
        const envelopeCuts=s=>{
            const ts=[0,1];for(const {upper,lower,n,parent,caps=[]}of envelopes){if(s.parentId!==lower.parentId)continue;
                for(const c of caps){const v=[s.a,s.b].map(p=>cross(sub(c.b,c.a),sub(p,c.a)));if(v[0]*v[1]<0)ts.push(v[0]/(v[0]-v[1]));}
                ts.push(...splitParameters(s.a,s.b,[parent]));
                for(const values of [[s.a,s.b].map(p=>(p.x-upper.a.x)*n.x+(p.y-upper.a.y)*n.y),[s.a,s.b].map(p=>height(parent,p)-p.z-.02)]){
                    if(values[0]*values[1]<0&&Math.abs(values[0])>EPS&&Math.abs(values[1])>EPS)ts.push(values[0]/(values[0]-values[1]));
                }
            }return [...new Set(ts.map(t=>+t.toFixed(8)))].sort((a,b)=>a-b);
        };
        for(const s of sources) {
            if(s.kind==='flashing'){const ts=envelopeCuts(s),parts=[];for(let i=1;i<ts.length;i++)if(!hiddenByEnvelope(s,mix(s.a,s.b,(ts[i-1]+ts[i])/2)))parts.push({...s,a:mix(s.a,s.b,ts[i-1]),b:mix(s.a,s.b,ts[i])});clipped.push(...parts.map((p,i)=>({...p,id:i?s.id+'.envelope'+i:s.id})));continue;}
            const reference=()=>{if(s.boundaryReference)clipped.push({...s,id:s.id+'.0',referenceOnly:true});};
            if(distance(s.a,s.b)<.005){reference();continue;}
            if(options.roofContacts&&!s.envelopeReturn&&!s.soffitAlignment&&!s.overlapSeam&&(s.b.x-s.a.x)*(s.originalB.x-s.originalA.x)+(s.b.y-s.a.y)*(s.originalB.y-s.originalA.y)<=0){reference();continue;}
            const f=faces.find(f=>f.id===s.parentId);
            // A setback near a hip can enter the neighboring face before reaching
            // flashing. Restrict support to faces sharing a roof edge at this
            // source's corner; unrelated/stacked roofs must not extend the wall.
            const same=(a,b)=>distance(a,b)<.01&&Math.abs(a.z-b.z)<.05;
            const support=[f,...faces.filter(g=>g!==f&&[s.originalA,s.originalB].some(c=>g.points.some(p=>same(p,c)))&&f.points.filter(p=>g.points.some(q=>same(p,q))).length>=2)];
            const ts=[...new Set([...splitParameters(s.a,s.b,support),...envelopeCuts(s)])].sort((a,b)=>a-b),pieces=[];
            for(let i=0;i<ts.length-1;i++){
                if((ts[i+1]-ts[i])*distance(s.a,s.b)<.005)continue;
                const mid=mix(s.a,s.b,(ts[i]+ts[i+1])/2);
                if(hiddenByEnvelope(s,mid))continue;
                // Several neighboring roof layers may overlap in plan. Keep the
                // original parent where possible; otherwise use the layer nearest
                // the source height, not whichever face occurs first in the list.
                // Choosing a lower layer here excludes it as an extrusion target
                // and sends a narrow corner strip all the way to the ground.
                // An internal roof opening does not end the underlying wall run.
                // Chimney composition cuts and replaces that interval afterward.
                const candidates=support.filter(g=>inside(mid,g.points));
                const face=candidates.find(g=>g===f)||candidates.sort((a,b)=>Math.abs(height(a,mid)-mid.z)-Math.abs(height(b,mid)-mid.z))[0];
                if(!face&&!(s.overlapSeam&&onEdge(mid,s.overlapSeam.a,s.overlapSeam.b,.005)))continue;
                pieces.push({...s,id:`${s.id}.${i}`,parentId:(face||f).id,a:mix(s.a,s.b,ts[i]),b:mix(s.a,s.b,ts[i+1]),supportPlane:(face||f).plane});
            }
            // Keep the top continuous at the hip, changing pitch on the adjacent
            // face instead of extrapolating the eave's parent plane through it.
            const anchored=new Set(pieces.flatMap((p,i)=>p.parentId===s.parentId?[i]:[]));
            for(let pass=0;pass<pieces.length;pass++)for(let i=0;i<pieces.length;i++){
                if(anchored.has(i))continue;const p=pieces[i];
                const dz=height({plane:p.supportPlane},p.b)-height({plane:p.supportPlane},p.a);
                if(anchored.has(i-1)&&distance(pieces[i-1].b,p.a)<.005){p.a.z=pieces[i-1].b.z;p.b.z=p.a.z+dz;anchored.add(i);}
                else if(anchored.has(i+1)&&distance(pieces[i+1].a,p.b)<.005){p.b.z=pieces[i+1].a.z;p.a.z=p.b.z-dz;anchored.add(i);}
            }
            if(s.overlapSeam&&pieces.length){
                for(const [piece,key]of [[pieces[0],'a'],[pieces[pieces.length-1],'b']])if(distance(piece[key],s[key])<.005)piece[key]=clone(s[key]);
            }
            if(!pieces.length)reference();
            clipped.push(...pieces.map(({supportPlane,...p})=>p));
        }
        if(options.soffit==='auto' && perimeters.some(s=>!s.inferred)) warnings.push('Auto uses 18 in where no parallel flashing gives a soffit depth.');
        return {sources:clipped,warnings};
    }
    function extrude(roof,sources,ground=0) {
        const faces=surfaces(roof),walls=[],warnings=[],layers=roofLayers(roof,faces);
        const insideBody=(f,p)=>{
            if(!contains(f,p))return false;
            const layer=layers.get(f.id);
            for(const edge of sources){if(!edge.originalA||!layer.some(f=>f.id===edge.parentId))continue;
                const a=edge.originalA,b=edge.originalB,d=sub(b,a),length=distance(a,b),t=Math.max(0,Math.min(1,((p.x-a.x)*d.x+(p.y-a.y)*d.y)/(length*length)));
                if(distance(p,mix(a,b,t))<edge.setback+.002)return false;
            }return true;
        };
        const terrain=typeof ground==='object'?surfaces({faces:ground.faces.map((ids,i)=>({id:`ground:${i}`,points:ids.map(id=>ground.points[id]),terrain:true}))}):[];
        const flat=typeof ground==='number'?ground:null;
        for(const s of sources) {
            if(s.referenceOnly)continue;
            // Ignore planes outside this wall's footprint; their infinite extensions
            // can cross thousands of times without changing the actual wall.
            // Along a measured roof boundary, use its actual slope instead of
            // the least-squares face fit. Otherwise dedupe leaves a thin wedge
            // between that fit and flashing built from the same measured edge.
            const alignedFaces=faces.map(f=>{
                const len=distance(s.a,s.b),u={x:(s.b.x-s.a.x)/len,y:(s.b.y-s.a.y)/len};
                const edges=[f.points,...(f.holes||[])].flatMap(r=>r.map((a,i)=>[a,r[(i+1)%r.length]])).filter(([a,b])=>{
                    if(distance(a,b)<EPS||[a,b].some(p=>Math.abs(cross(sub(p,s.a),u))>.002))return false;
                    const t=[a,b].map(p=>(p.x-s.a.x)*u.x+(p.y-s.a.y)*u.y).sort((a,b)=>a-b);
                    return Math.min(len,t[1])-Math.max(0,t[0])>.002;
                });
                if(!edges.length)return f;
                const [a,b]=edges[0],along=(b.z-a.z)/((b.x-a.x)*u.x+(b.y-a.y)*u.y),delta=along-f.plane.dx*u.x-f.plane.dy*u.y;
                const dx=f.plane.dx+delta*u.x,dy=f.plane.dy+delta*u.y,plane={dx,dy,k:a.z-dx*a.x-dy*a.y};
                if(edges.some(e=>e.some(p=>Math.abs(height({plane},p)-p.z)>.002)))return f;
                return {...f,plane};
            });
            const relevant=[...alignedFaces,...(s.direction==='down'?terrain:[])].filter(f=>{
                if(f.id===s.parentId||(s.envelopeReturn&&f.id===s.envelopeParentId))return false;
                const cuts=splitParameters(s.a,s.b,[f]);
                return cuts.some((t,i)=>i>0&&(contains(f,mix(s.a,s.b,(cuts[i-1]+t)/2))||s.direction==='down'&&faces.some(p=>p.id===s.parentId&&contains(p,mix(s.a,s.b,(cuts[i-1]+t)/2)))&&inside(mix(s.a,s.b,(cuts[i-1]+t)/2),f.points)));
            });
            const ts=splitParameters(s.a,s.b,relevant);
            const envelopeRuns=s.outerEnvelope?sources.filter(r=>r.id===s.outerEnvelope.sourceId||r.id.startsWith(s.outerEnvelope.sourceId+'.')):[];
            const sourceLength=distance(s.a,s.b),sourceT=p=>((p.x-s.a.x)*(s.b.x-s.a.x)+(p.y-s.a.y)*(s.b.y-s.a.y))/(sourceLength*sourceLength);
            if(s.overlapSeam)for(const p of [s.overlapSeam.a,s.overlapSeam.b]){const t=sourceT(p);if(t>EPS&&t<1-EPS)ts.push(t);}
            for(const r of envelopeRuns)for(const p of [r.a,r.b]){const t=sourceT(p);if(t>EPS&&t<1-EPS)ts.push(t);}
            // Split where surfaces cross the source elevation, ground, or each other.
            const equations=[...(flat!==null?[{dx:0,dy:0,k:flat}]:[]),...relevant.map(f=>f.plane)];
            const sourceZ=t=>mix(s.a,s.b,t).z;
            const values=f=>[height({plane:f},s.a),height({plane:f},s.b)];
            const addCross=(a,b)=>{if(a*b<0)ts.push(a/(a-b));};
            for(let i=0;i<equations.length;i++) {
                const a=values(equations[i]); addCross(a[0]-sourceZ(0),a[1]-sourceZ(1));
                for(let j=i+1;j<equations.length;j++){const b=values(equations[j]);addCross(a[0]-b[0],a[1]-b[1]);}
            }
            const breaks=[...new Set(ts.map(t=>+t.toFixed(8)))].sort((a,b)=>a-b);
            let missed=false,uncovered=false;
            for(let i=0;i<breaks.length-1;i++) {
                const t0=breaks[i],t1=breaks[i+1],m=mix(s.a,s.b,(t0+t1)/2);
                if(t1-t0<1e-10)continue;
                const groundFace=relevant.filter(f=>f.terrain&&contains(f,m)).sort((a,b)=>height(b,m)-height(a,m))[0];
                const floor=groundFace?height(groundFace,m):flat;
                if(s.direction==='down'&&floor===null){uncovered=true;continue;}
                // A low roof detail entirely inside a higher roof's wall
                // footprint is embedded material. Near the eave, keep the
                // exposed lower projection and its own smaller setback.
                if(s.direction==='down'&&faces.some(f=>f.id!==s.parentId&&height(f,m)>m.z+.02&&insideBody(f,m)&&!layers.get(s.parentId)?.includes(f)))continue;
                const inSeam=s.overlapSeam&&onEdge(m,s.overlapSeam.a,s.overlapSeam.b,.005);
                // A dormer opening removes roof material, not the house below it.
                // Its upper roof still meets the lower support plane at the hole.
                const parent=faces.find(f=>f.id===s.parentId),coveredOpening=f=>s.direction==='down'&&parent&&contains(parent,m)&&inside(m,f.points);
                const targets=relevant.filter(f=>!inSeam&&!f.terrain&&(contains(f,m)||coveredOpening(f))&&(!s.outerEnvelope||f.id!==s.outerEnvelope.parentId||envelopeRuns.some(r=>onEdge(m,r.a,r.b,.005)))).map(f=>({f,z:height(f,m)}))
                    .filter(v=>s.direction==='up'?v.z>m.z+.02:v.z<(layers.get(s.parentId)?.includes(faces.find(f=>f.id===v.f.id))?m.z-.02:m.z+.02)&&v.z>floor);
                targets.sort((a,b)=>s.direction==='up'?a.z-b.z:b.z-a.z);
                const target=targets[0]?.f||(s.direction==='down'?groundFace:null);
                // Near-coincident roof contact terminates the wall; dropping a
                // contact within survey tolerance must never send it to grade.
                if(s.direction==='down'&&target&&!target.terrain&&Math.abs(height(target,m)-m.z)<=.02)continue;
                if(!target && s.direction==='up'){missed=true;continue;}
                const a=mix(s.a,s.b,t0),b=mix(s.a,s.b,t1);
                const edgeTarget=target?.id===s.outerEnvelope?.parentId?envelopeRuns.find(r=>onEdge(m,r.a,r.b,.005)):null;
                const targetHeight=p=>{if(!edgeTarget)return target?height(target,p):flat;const u=sub(edgeTarget.b,edgeTarget.a),t=((p.x-edgeTarget.a.x)*u.x+(p.y-edgeTarget.a.y)*u.y)/(u.x*u.x+u.y*u.y);return mix(edgeTarget.a,edgeTarget.b,t).z;};
                const ta={...a,z:targetHeight(a)},tb={...b,z:targetHeight(b)};
                if(s.direction==='down' && m.z<=floor+.02)continue;
                const bottom=s.direction==='up'?[a,b]:[ta,tb],top=s.direction==='up'?[ta,tb]:[a,b];
                walls.push({id:`${s.id}:${i}`,sourceId:s.id,...(s.originalA&&s.originalB?{roofCorners:[distance(a,s.a)<.005?clone(s.originalA):null,distance(b,s.b)<.005?clone(s.originalB):null]}:{}),...(s.parentId!==undefined?{sourceRoofId:s.parentId}:{}),kind:s.kind,type:s.type,bottom,top,targetId:target?.id??'ground'});
            }
            if(missed)warnings.push(`${s.id}: no upper roof over part or all of flashing; that span was skipped.`);
            if(uncovered)warnings.push(`${s.id}: wall extends outside the ground faces; enlarge the ground layer to cover it.`);
        }
        return {walls:coalesce(walls),warnings};
    }
    function coalesce(walls) {
        const result=[];
        const near=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<1e-5;
        const straight=(a,b,c)=>{
            const total=distance(a,c),t=distance(a,b)/total;
            return total>EPS && t>0 && t<1 && near(b,mix(a,c,t));
        };
        for(const original of walls){
            let w=clone(original),merged=true;
            while(merged){
                merged=false;
                for(let i=0;i<result.length;i++){
                    const other=result[i];
                    if(other.kind!==w.kind)continue;
                    for(const reverse of [false,true]){
                        const b=reverse?{...w,bottom:[...w.bottom].reverse(),top:[...w.top].reverse(),...(w.roofCorners?{roofCorners:[...w.roofCorners].reverse()}:{})}:w;
                        for(const [left,right] of [[other,b],[b,other]]){
                            if(!['bottom','top'].every(edge=>near(left[edge][1],right[edge][0])&&straight(left[edge][0],left[edge][1],right[edge][1])))continue;
                            w={...left,...(left.roofCorners||right.roofCorners?{roofCorners:[left.roofCorners?.[0]||null,right.roofCorners?.[1]||null]}:{}),bottom:[left.bottom[0],right.bottom[1]],top:[left.top[0],right.top[1]],sourceIds:[...new Set([...(left.sourceIds||[left.sourceId]),...(right.sourceIds||[right.sourceId])])]};
                            result.splice(i,1);merged=true;break;
                        }
                        if(merged)break;
                    }
                    if(merged)break;
                }
            }
            result.push(w);
        }
        return result;
    }
    function sliceWall(w,t0,t1) {return {...w,...(w.roofCorners?{roofCorners:[t0<EPS?w.roofCorners[0]:null,t1>1-EPS?w.roofCorners[1]:null]}:{}),bottom:[mix(...w.bottom,t0),mix(...w.bottom,t1)],top:[mix(...w.top,t0),mix(...w.top,t1)]};}
    // A flashing source may continue beneath overlapping roof planes beyond
    // the inset exterior corner. Trim only a short, unconnected terminal tail
    // whose upper edge meets the crossing perimeter's upper edge.
    function trimFlashingTails(walls,tolerance) {
        let result=walls.map(clone);
        const groups=new Map();
        for(const w of walls.filter(w=>w.kind==='flashing')){const id=w.sourceId;if(id==null)continue;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(w);}
        for(const [id,group]of groups){
            const first=group[0],a=first.bottom[0],d=sub(first.bottom[1],a),len=distance(...first.bottom);if(len<EPS)continue;
            const u={x:d.x/len,y:d.y/len},project=p=>(p.x-a.x)*u.x+(p.y-a.y)*u.y;
            if(group.some(w=>w.bottom.some(p=>Math.abs(cross(sub(p,a),u))>.002)))continue;
            const ends=group.flatMap(w=>w.bottom),lo=Math.min(...ends.map(project)),hi=Math.max(...ends.map(project));
            for(const end of [lo,hi]){
                const tip=ends.find(p=>Math.abs(project(p)-end)<EPS);
                // Preserve real joined returns, even short ones.
                if(walls.some(w=>w.sourceId!==id&&onEdge(tip,...w.bottom,.02)))continue;
                let cut=null;
                for(const w of group)for(const p of walls.filter(w=>w.kind==='perimeter')){
                    const v=sub(p.bottom[1],p.bottom[0]),den=cross(u,v);if(Math.abs(den)<EPS)continue;
                    const q=sub(p.bottom[0],a),t=cross(q,v)/den,h=cross(q,u)/den;
                    if(h<-.002/distance(...p.bottom)||h>1+.002/distance(...p.bottom))continue;
                    const tail=Math.abs(t-end);if(t<=lo+EPS||t>=hi-EPS||tail>tolerance||tail*2>=hi-lo)continue;
                    const wl=project(w.bottom[0]),wr=project(w.bottom[1]),f=(t-wl)/(wr-wl);if(f<-EPS||f>1+EPS)continue;
                    if(Math.abs(mix(...w.top,f).z-mix(...p.top,Math.max(0,Math.min(1,h))).z)>.1)continue;
                    if(cut===null||tail<Math.abs(cut-end))cut=t;
                }
                if(cut===null)continue;
                result=result.flatMap(w=>{
                    if(w.kind!=='flashing'||w.sourceId!==id)return [w];
                    const x=project(w.bottom[0]),y=project(w.bottom[1]),keep=v=>end===lo?v>=cut-EPS:v<=cut+EPS;
                    if(keep(x)&&keep(y))return [w];if(!keep(x)&&!keep(y))return [];
                    const t=(cut-x)/(y-x);return [keep(x)?sliceWall(w,0,t):sliceWall(w,t,1)];
                });
            }
        }
        return result;
    }
    // Flashing and an inferred inset edge can describe the same wall plane
    // with millimetre survey drift. Use the longer generated perimeter plane,
    // and carry the junction through adjacent returns at every elevation.
    function alignFlashingPlanes(walls){
        const result=clone(walls),moves=[],heights=[];
        const perimeters=result.filter(w=>w.kind==='perimeter'&&w.sourceRoofId!==undefined);
        for(const f of result.filter(w=>w.kind==='flashing')){
            const len=distance(...f.bottom);if(len<.005)continue;
            const candidates=perimeters.filter(w=>w.sourceRoofId===f.targetId).map(w=>{
                const a=w.bottom[0],b=w.bottom[1],l=distance(a,b);
                const u={x:(b.x-a.x)/l,y:(b.y-a.y)/l},at=p=>((p.x-a.x)*u.x+(p.y-a.y)*u.y)/l;
                const ts=f.bottom.map(at).sort((a,b)=>a-b);
                return {w,a,b,l,u,at,overlap:(Math.min(1,ts[1])-Math.max(0,ts[0]))*l};
            }).filter(c=>c.l>.005&&c.overlap>.005&&
                Math.abs(cross(c.u,sub(f.bottom[1],f.bottom[0])))/len<.02&&
                f.bottom.every(p=>Math.abs(cross(sub(p,c.a),c.u))<.01)
            ).sort((a,b)=>b.l-a.l);
            const c=candidates[0];if(!c)continue;
            for(const p of f.bottom){
                const q=mix(c.a,c.b,c.at(p));
                if(distance(p,q)>1e-9)moves.push({from:{...p},to:q});
            }
            // Both upper edges terminate at the same source roof. Reconcile
            // small fitting differences before subtraction can leave a ledge.
            const top=f.top.map(p=>mix(...c.w.top,c.at(p)).z);
            if(top.every((z,i)=>Math.abs(z-f.top[i].z)<.05)){
                for(let i=0;i<2;i++)heights.push({from:{...f.top[i]},z:top[i]});
            }
            for(const w of perimeters.filter(w=>w.sourceRoofId===f.targetId))for(const p of w.bottom){
                const junction=f.bottom.find(q=>distance(p,q)<.01);
                if(junction)moves.push({from:{...p},to:mix(c.a,c.b,c.at(junction))});
            }
            // The adjoining source roof may have its own slightly skewed inset.
            // Only reconcile a run touching this measured flashing endpoint;
            // parallel walls elsewhere (including intentional offsets) stay put.
            for(const w of perimeters.filter(w=>w.sourceRoofId===f.sourceRoofId)){
                const l=distance(...w.bottom);if(l<.005)continue;
                if(Math.abs(cross(c.u,sub(w.bottom[1],w.bottom[0])))/l>=.02||
                    !w.bottom.some(p=>f.bottom.some(q=>distance(p,q)<.01))||
                    w.bottom.some(p=>Math.abs(cross(sub(p,c.a),c.u))>INCH))continue;
                const aligned=[];
                for(const p of w.bottom){
                    const junction=f.bottom.find(q=>distance(p,q)<.01);
                    let q=mix(c.a,c.b,c.at(junction||p));
                    if(!junction){
                        const neighbor=perimeters.find(v=>v!==w&&v.bottom.some(r=>distance(p,r)<1e-6)&&Math.abs(cross(sub(v.bottom[1],v.bottom[0]),c.u))>.01);
                        if(neighbor){const v=sub(neighbor.bottom[1],neighbor.bottom[0]),t=cross(sub(neighbor.bottom[0],c.a),v)/cross(c.u,v);q={x:c.a.x+c.u.x*t,y:c.a.y+c.u.y*t,z:p.z};}
                    }
                    if(distance(p,q)<=INCH)aligned.push({from:{...p},to:q});
                }
                if(aligned.length===2)moves.push(...aligned);
            }
            const bounds=f.bottom.map(p=>c.at(p)*c.l).sort((a,b)=>a-b);
            for(const w of perimeters.filter(w=>w.sourceRoofId===f.sourceRoofId||w.sourceRoofId===f.targetId)){
                const v=sub(w.bottom[1],w.bottom[0]),l=distance(...w.bottom);
                if(l<.005||Math.abs((v.x*c.u.x+v.y*c.u.y)/l)>.2)continue;
                for(const p of w.bottom){
                    const t=c.at(p)*c.l,offset=Math.abs(cross(sub(p,c.a),c.u));
                    if(offset<1e-9||offset>.01||t<bounds[0]-.5||t>bounds[1]+.5)continue;
                    const at=cross(sub(c.a,p),c.u)/cross(v,c.u);
                    moves.push({from:{...p},to:{x:p.x+v.x*at,y:p.y+v.y*at,z:p.z}});
                }
            }
        }
        for(const w of result)for(const edge of [w.bottom,w.top])for(const p of edge){
            const h=heights.find(h=>Math.hypot(p.x-h.from.x,p.y-h.from.y,p.z-h.from.z)<1e-6);
            const m=moves.find(m=>distance(p,m.from)<1e-6);
            if(h)p.z=h.z;
            if(m){p.x=m.to.x;p.y=m.to.y;}
        }
        return result;
    }
    function deduplicate(walls,tolerance=.4572,options={}) {
        if(!options.preserveJunctions)walls=trimFlashingTails(alignFlashingPlanes(walls),tolerance);
        let result=walls.filter(w=>w.kind==='flashing').map(clone); let removed=0;
        const flashing=result.slice();
        for(const original of walls.filter(w=>w.kind!=='flashing')) {
            let pieces=[clone(original)];
            for(const f of flashing) {
                const next=[];
                for(const w of pieces) {
                    const a=w.bottom[0],b=w.bottom[1],len=distance(a,b),u={x:(b.x-a.x)/len,y:(b.y-a.y)/len};
                    const fl=distance(...f.bottom),v={x:(f.bottom[1].x-f.bottom[0].x)/fl,y:(f.bottom[1].y-f.bottom[0].y)/fl};
                    if(Math.abs(cross(u,v))>.0872 || f.bottom.some(p=>Math.abs(cross(sub(p,a),u))>tolerance)) {next.push(w);continue;}
                    const t=f.bottom.map(p=>((p.x-a.x)*u.x+(p.y-a.y)*u.y)/len).sort((a,b)=>a-b);
                    const lo=Math.max(0,t[0]),hi=Math.min(1,t[1]);
                    if(hi-lo<.005/len){next.push(w);continue;}
                    // Preserve portions above/below flashing: only remove duplicate wall area.
                    const fz=(p,edge)=>{const q=Math.max(0,Math.min(1,((p.x-f.bottom[0].x)*v.x+(p.y-f.bottom[0].y)*v.y)/fl));return mix(...f[edge],q).z;};
                    if(lo>EPS)next.push(sliceWall(w,0,lo));
                    if(hi<1-EPS)next.push(sliceWall(w,hi,1));
                    const cuts=[lo,hi];
                    for(const we of ['bottom','top'])for(const fe of ['bottom','top']){
                        const a=mix(...w[we],lo),b=mix(...w[we],hi),da=a.z-fz(a,fe),db=b.z-fz(b,fe);
                        if(da*db<0)cuts.push(lo+(hi-lo)*da/(da-db));
                    }
                    cuts.sort((a,b)=>a-b);
                    for(let k=0;k<cuts.length-1;k++){
                        if(cuts[k+1]-cuts[k]<EPS)continue;
                        const c=sliceWall(w,cuts[k],cuts[k+1]),mid=mix(...c.bottom,.5);
                        const low=Math.max(mix(...c.bottom,.5).z,fz(mid,'bottom')),high=Math.min(mix(...c.top,.5).z,fz(mid,'top'));
                        if(high-low<.02){next.push(c);continue;}
                        const below={...c,top:c.bottom.map((p,i)=>({...p,z:Math.max(p.z,Math.min(c.top[i].z,fz(p,'bottom')))}))};
                        const above={...c,bottom:c.bottom.map((p,i)=>({...p,z:Math.min(c.top[i].z,Math.max(p.z,fz(p,'top')))}))};
                        if(below.top.some((p,i)=>p.z-below.bottom[i].z>.02))next.push(below);
                        if(above.top.some((p,i)=>p.z-above.bottom[i].z>.02))next.push(above);
                        removed++;
                    }
                }
                pieces=next;
            }
            result.push(...pieces);
        }
        // Exact same-kind duplicate boundaries can arise from shared source edges.
        const seen=new Set(); result=result.filter(w=>{const k=[...w.bottom,...w.top].map(p=>[p.x,p.y,p.z].map(v=>v.toFixed(4)).join(',')).sort().join('|');if(seen.has(k)){removed++;return false;}seen.add(k);return true;});
        const unique=coalesce(result),used=new Set(unique.map(w=>w.id)),seenIds=new Set();
        for(const w of unique){if(seenIds.has(w.id)){const original=w.id;let i=1;while(used.has(original+':dedupe-part-'+i))i++;w.id=original+':dedupe-part-'+i;used.add(w.id);}seenIds.add(w.id);}
        return {walls:options.preserveJunctions?unique:weldGeneratedJunctions(unique),removed};
    }
    // Roof plane fits can disagree by millimetres at the same generated junction.
    // Weld complete vertical columns only; do not merge deliberate short edges
    // or unrelated elevations, and never apply this to user-edited geometry.
    function weldGeneratedJunctions(walls){
        const result=clone(walls),groups=[];
        for(const w of result)for(let i=0;i<2;i++){
            const bottom=w.bottom[i],top=w.top[i];
            const group=groups.find(g=>!g.some(c=>c.w===w)&&g.every(c=>distance(c.bottom,bottom)<=.005&&Math.abs(c.bottom.z-bottom.z)<=.01));
            const column={w,i,bottom,top};if(group)group.push(column);else groups.push([column]);
        }
        for(const g of groups)if(g.length>1){
            const anchor=g[0].bottom,lo=Math.min(...g.map(c=>c.bottom.z)),tops=[];
            // Floor junction ownership does not depend on matching roof heights.
            // Reconcile small fitted-roof discrepancies separately, keeping real
            // stepped upper edges and their vertical connecting segments.
            for(const c of g){Object.assign(c.bottom,{x:anchor.x,y:anchor.y,z:lo});Object.assign(c.top,{x:anchor.x,y:anchor.y});const cluster=tops.find(t=>t.every(v=>Math.abs(v.top.z-c.top.z)<=(v.w.roofCorners?.[v.i]&&c.w.roofCorners?.[c.i]&&Math.hypot(v.w.roofCorners[v.i].x-c.w.roofCorners[c.i].x,v.w.roofCorners[v.i].y-c.w.roofCorners[c.i].y,v.w.roofCorners[v.i].z-c.w.roofCorners[c.i].z)<.01?.05:.01)));if(cluster)cluster.push(c);else tops.push([c]);}
            for(const cluster of tops){const z=Math.min(...cluster.map(c=>c.top.z));for(const c of cluster)c.top.z=z;}
        }
        // A tapered flashing strip can end a few millimetres above its lower
        // roof seam after plane fitting. Collapse only that terminal sliver,
        // not short wall edges or two nearby corners in the floor plan.
        for(const w of result)if(w.kind==='flashing')for(let i=0;i<2;i++){
            const a=w.bottom[i],b=w.top[i],other=1-i;
            if(distance(a,b)<1e-6&&b.z>=a.z&&b.z-a.z<=.005&&w.top[other].z-w.bottom[other].z>.02)w.top[i]={...a};
        }
        return result;
    }
    function mergeCoplanar(walls,excluded=[]){
        const blocked=new Set(excluded),parent=walls.map((_,i)=>i),find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));
        const ring=w=>[w.bottom[0],w.bottom[1],w.top[1],w.top[0]],touch=(a,b)=>{
            const len=distance(...a.bottom);if(len<EPS)return false;const u=sub(a.bottom[1],a.bottom[0]);
            if(b.bottom.some(p=>Math.abs(cross(sub(p,a.bottom[0]),u))/len>1e-5))return false;
            const local=p=>({x:((p.x-a.bottom[0].x)*u.x+(p.y-a.bottom[0].y)*u.y)/len,y:p.z});
            const ar=ring(a).map(local),br=ring(b).map(local);
            return ar.some((p,i)=>{const q=ar[(i+1)%4],d=sub(q,p),l=distance(p,q);if(l<1e-5)return false;return br.some((r,j)=>{const t=br[(j+1)%4];if([r,t].some(v=>Math.abs(cross(sub(v,p),d))/l>1e-5))return false;const ts=[r,t].map(v=>((v.x-p.x)*d.x+(v.y-p.y)*d.y)/l).sort((a,b)=>a-b);return Math.min(l,ts[1])-Math.max(0,ts[0])>1e-5;});});
        };
        for(let i=0;i<walls.length;i++)for(let j=i+1;j<walls.length;j++)if(!blocked.has(walls[i].id)&&!blocked.has(walls[j].id)&&touch(walls[i],walls[j]))parent[find(j)]=find(i);
        const groups=new Map();walls.forEach((w,i)=>{const key=find(i);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(w.id);});
        return {walls:canonicalGeneratedWalls(walls.map((w,i)=>{const ids=groups.get(find(i));return ids.length>1?{...w,mergeGroup:ids.slice().sort().join('|')}:clone(w);}),excluded),removed:[...groups.values()].reduce((s,g)=>s+g.length-1,0)};
    }
    // Measured roof triangles are not perfectly coplanar. Their clipping
    // stations must be reconciled in the source mesh and editable outline together.
    // Bound the total deviation of a joined run (not just each local bend),
    // and retain actual turns and shared wall junctions.
    function simplifyGeneratedEdges(points,edges,junctions=new Set(),tolerance=.05,corrections=null) {
        const result=edges.map(e=>({ids:e.slice(),samples:e.slice()}));
        const distance3=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
        let changed=true;
        while(changed){changed=false;
            for(const id of new Set(result.flatMap(e=>e.ids))){
                if(junctions.has(id))continue;
                const incident=result.filter(e=>e.ids.includes(id));if(incident.length!==2)continue;
                const a=incident[0].ids.find(v=>v!==id),b=incident[1].ids.find(v=>v!==id);if(a===b)continue;
                if(result.some(e=>e.ids.includes(a)&&e.ids.includes(b)))continue;
                const p=points[a],q=points[b],v=points[id],l=distance3(p,q),la=distance3(p,v),lb=distance3(v,q);
                if(l<1e-8||la<1e-8||lb<1e-8)continue;
                const cosine=((v.x-p.x)*(q.x-v.x)+(v.y-p.y)*(q.y-v.y)+(v.z-p.z)*(q.z-v.z))/(la*lb);
                // Very short survey stations can have steep local angles even on
                // a long, nearly level eave. The whole-run deviation bound below
                // decides those runs; short physical corners keep the angle test.
                const surveyRun=tolerance>.001&&distance(p,q)>2&&Math.abs(q.z-p.z)/distance(p,q)<Math.tan(5*Math.PI/180);
                if(cosine<Math.cos(5*Math.PI/180)&&!surveyRun)continue;
                const samples=[...new Set(incident.flatMap(e=>e.samples))];
                if(samples.some(i=>{const s=points[i],t=((s.x-p.x)*(q.x-p.x)+(s.y-p.y)*(q.y-p.y)+(s.z-p.z)*(q.z-p.z))/(l*l);return t<-1e-8||t>1+1e-8||distance3(s,mix(p,q,t))>tolerance;}))continue;
                result.splice(result.indexOf(incident[0]),1);result.splice(result.indexOf(incident[1]),1);result.push({ids:[a,b],samples});changed=true;break;
            }
        }
        if(corrections)for(const e of result){const [a,b]=e.ids.map(i=>points[i]),dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;
            if(l2<1e-12)continue;
            for(const id of e.samples){if(e.ids.includes(id))continue;const p=points[id],t=((p.x-a.x)*dx+(p.y-a.y)*dy)/l2,z=a.z+(b.z-a.z)*t;
                if(Math.abs(z-p.z)>1e-9)corrections.set(id,{...p,z});
            }
        }
        return result.map(e=>e.ids);
    }
    function simplifyGeneratedRing(points,junctions=[]) {
        const protectedIds=new Set(points.flatMap((p,i)=>junctions.some(q=>Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)<1e-5)?[i]:[]));
        const edges=simplifyGeneratedEdges(points,points.map((p,i)=>[i,(i+1)%points.length]),protectedIds),kept=new Set(edges.flat());
        return points.filter((p,i)=>kept.has(i));
    }
    // Canonicalize generated coordinates before any renderer or edit tool sees them.
    // Source strips remain for provenance, but no longer retain a different rim.
    function canonicalGeneratedWalls(walls,excluded=[]) {
        const blocked=new Set(excluded),groups=new Set(walls.filter(w=>blocked.has(w.id)).map(w=>w.mergeGroup));
        const source=walls.map(w=>blocked.has(w.id)||groups.has(w.mergeGroup)?{...w,sourceId:undefined}:w);
        const corrections=topology(source).corrections;if(!corrections.length)return walls;
        const key=p=>[p.x,p.y,p.z].map(v=>v.toFixed(5)).join('|'),moves=new Map(corrections.map(m=>[key(m.from),m.to]));
        return walls.map(w=>({...w,bottom:w.bottom.map(p=>({...p,...moves.get(key(p))})),top:w.top.map(p=>({...p,...moves.get(key(p))}))}));
    }
    function topology(walls) {
        const points=[],connections=[],faces=[],index=new Map(),edges=new Set(),corrections=new Map();
        const add=p=>{const key=[p.x,p.y,p.z].map(v=>v.toFixed(5)).join('|');if(!index.has(key)){index.set(key,points.length);points.push({...p});}return index.get(key);};
        walls.forEach(w=>{
            // Vertical wall polygons are planar in (distance along wall, elevation).
            // This avoids the roof solver's top-down area and z=f(x,y) assumptions.
            const ids=[w.bottom[0],w.bottom[1],w.top[1],w.top[0]].map(add).filter((id,i,a)=>id!==a[(i+a.length-1)%a.length]);
            if(ids.length<3)return;
            ids.forEach((id,i)=>{const end=ids[(i+1)%ids.length],key=[id,end].sort((a,b)=>a-b).join(':');if(!edges.has(key)){edges.add(key);connections.push({startIdx:id,endIdx:end,type:'wall'});}});
            const triangles=[];for(let i=1;i<ids.length-1;i++)triangles.push([ids[0],ids[i],ids[i+1]]);
            const area=distance(...w.bottom)*((w.top[0].z-w.bottom[0].z)+(w.top[1].z-w.bottom[1].z))/2;
            if(area>EPS)faces.push({pointIndices:ids,triangles,area,sourceId:w.sourceId,kind:w.kind,...(w.chimney?{chimney:{...w.chimney},type:'chimney'}:{}),...(w.mergeGroup?{mergeGroup:w.mergeGroup}:{})});
        });
        const groups=[...new Set(faces.map(f=>f.mergeGroup).filter(Boolean))];
        if(groups.length){
            const output=faces.filter(f=>!f.mergeGroup),boundary=[];
            for(const group of groups){
                const members=faces.filter(f=>f.mergeGroup===group),K=typeof module==='object'&&module.exports?require('./exterior_geometry.js'):root.ExteriorGeometry;
                const owner=members.find(f=>!f.chimney)||members[0],origin=points[owner.pointIndices[0]],other=owner.pointIndices.map(i=>points[i]).reduce((a,b)=>distance(origin,b)>distance(origin,a)?b:a,origin),length=distance(origin,other),u={x:(other.x-origin.x)/length,y:(other.y-origin.y)/length};
                const local=p=>({x:(p.x-origin.x)*u.x+(p.y-origin.y)*u.y,y:p.z-origin.z,z:0}),world=p=>({x:origin.x+u.x*p.x,y:origin.y+u.y*p.x,z:origin.z+p.y});
                // Shared-edge parity cannot represent overlapping source strips.
                // Union the filled regions, then derive BOTH mesh and wire from it.
                const regions=K.union(members.map(f=>({points:f.pointIndices.map(i=>local(points[i]))}))),junctions=new Set(faces.filter(f=>f.mergeGroup!==group).flatMap(f=>f.pointIndices));
                for(const region of regions){
                    const anchors=members.every(f=>f.sourceId)?[...junctions]:members.flatMap(f=>f.pointIndices);
                    const rings=[region.points,...region.holes].map(r=>r.flatMap((p,i)=>{const q=r[(i+1)%r.length],dx=q.x-p.x,dy=q.y-p.y,l2=dx*dx+dy*dy;return [add(world(p)),...anchors.map(id=>({id,v:local(points[id])})).map(v=>({...v,t:((v.v.x-p.x)*dx+(v.v.y-p.y)*dy)/l2})).filter(v=>v.t>1e-6&&v.t<1-1e-6&&Math.hypot(v.v.x-p.x-v.t*dx,v.v.y-p.y-v.t*dy)<1e-5&&Math.abs((points[v.id].x-origin.x)*u.y-(points[v.id].y-origin.y)*u.x)<1e-5).sort((a,b)=>a.t-b.t).map(v=>v.id)];}));
                    const clean=r=>{
                        let e=r.map((id,i)=>[id,r[(i+1)%r.length]]);
                        if(members.every(f=>f.sourceId))e=simplifyGeneratedEdges(points,e,junctions,members.every(f=>f.kind==='perimeter'&&!f.chimney)?.05:1e-5,corrections);
                        const kept=new Set(e.flat());return r.filter(i=>kept.has(i));
                    },result=rings.map(clean),outside=result.flatMap(r=>r.map((id,i)=>[id,r[(i+1)%r.length]]));
                    // Boolean union also removes collinear stations. Carry every
                    // original boundary sample onto its surviving run, including
                    // samples that disappeared before simplification.
                    if(members.every(f=>f.sourceId))for(const id of new Set(members.flatMap(f=>f.pointIndices))){
                        if(junctions.has(id)||outside.some(e=>e.includes(id)))continue;
                        const p=points[id],q=local(p),onRaw=rings.some(r=>r.some((a,i)=>{const b=r[(i+1)%r.length],v=local(points[a]),w=local(points[b]),dx=w.x-v.x,dy=w.y-v.y,l2=dx*dx+dy*dy,t=l2?((q.x-v.x)*dx+(q.y-v.y)*dy)/l2:-1;return t>=-1e-6&&t<=1+1e-6&&Math.hypot(q.x-v.x-t*dx,q.y-v.y-t*dy)<1e-5;}));
                        if(!onRaw)continue;
                        const tolerance=members.every(f=>f.kind==='perimeter'&&!f.chimney)?.05:1e-5;
                        for(const [a,b]of outside){const v=local(points[a]),w=local(points[b]),dx=w.x-v.x;if(Math.abs(dx)<1e-8)continue;const t=(q.x-v.x)/dx,z=origin.z+v.y+(w.y-v.y)*t;if(t>=0&&t<=1&&Math.abs(z-p.z)<=tolerance){if(Math.abs(z-p.z)>1e-9)corrections.set(id,{...p,z});break;}}
                    }
                    boundary.push(...outside);
                    const mesh=K.triangles(result[0].map(i=>local(points[i])),result.slice(1).map(r=>r.map(i=>local(points[i])))),flat=result.flat();
                    output.push({...owner,pointIndices:result[0],...(result.length>1?{holes:result.slice(1)}:{}),boundary:outside,triangles:mesh.triangles.map(t=>t.map(i=>flat[i])),area:K.area(region)});
                }
            }
            const ordinary=output.filter(f=>!f.mergeGroup).flatMap(f=>f.pointIndices.map((id,i)=>[id,f.pointIndices[(i+1)%f.pointIndices.length]]));
            const unique=new Map([...ordinary,...boundary].map(ids=>[ids.slice().sort((a,b)=>a-b).join(':'),{startIdx:ids[0],endIdx:ids[1],type:'wall'}]));
            const moved=[...corrections].map(([i,to])=>({from:{...points[i]},to}));for(const [i,to]of corrections)points[i]=to;
            for(const face of output)face.area=face.triangles.reduce((area,t)=>{const [a,b,c]=t.map(i=>points[i]),u={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},v={x:c.x-a.x,y:c.y-a.y,z:c.z-a.z};return area+Math.hypot(u.y*v.z-u.z*v.y,u.z*v.x-u.x*v.z,u.x*v.y-u.y*v.x)/2;},0);
            const used=[...new Set(output.flatMap(f=>[...f.pointIndices,...(f.holes||[]).flat(),...f.triangles.flat()]))],remap=new Map(used.map((id,i)=>[id,i])),edge=e=>e.map(i=>remap.get(i));
            return {points:used.map(i=>points[i]),connections:[...unique.values()].map(c=>({...c,startIdx:remap.get(c.startIdx),endIdx:remap.get(c.endIdx)})),faces:output.map(f=>({...f,pointIndices:edge(f.pointIndices),...(f.holes?{holes:f.holes.map(edge)}:{}),...(f.boundary?{boundary:f.boundary.map(edge)}:{}),triangles:f.triangles.map(edge)})),corrections:moved};
        }
        return {points,connections,faces,corrections:[]};
    }
    function build(roof,options) {
        const a=buildSources(roof,options),b=extrude(roof,a.sources,options.ground),c=deduplicate(b.walls,options.tolerance);
        return {sources:a.sources,extruded:b.walls,deduplicated:c.walls,removed:c.removed,warnings:[...a.warnings,...b.warnings]};
    }
    // Split roof-edge runs can leave centimetre-wide wall fragments. They are
    // part of their parent plane, not an independently anchored extrusion face.
    function generatedMoveGroup(walls,id){
        const parent=walls.find(w=>w.id===id);if(!parent)return [];
        const root=w=>String(w.sourceId||'').replace(/\.\d+$/,'');
        const family=root(parent);if(!family)return [id];
        const a=parent.bottom[0],b=parent.bottom[1],len=distance(a,b);if(len<.03)return [id];
        const u={x:(b.x-a.x)/len,y:(b.y-a.y)/len},group=[parent];
        for(let i=0;i<group.length;i++)for(const w of walls){
            if(group.includes(w)||root(w)!==family||w.kind!==parent.kind)continue;
            const size=distance(...w.bottom);if(size>.03||size<.000001)continue;
            const dx=w.bottom[1].x-w.bottom[0].x,dy=w.bottom[1].y-w.bottom[0].y;
            if(Math.abs(u.x*dy-u.y*dx)/size>1e-5||w.bottom.some(p=>Math.abs((p.x-a.x)*-u.y+(p.y-a.y)*u.x)>.002))continue;
            const v=group[i],touch=w.bottom.some((p,j)=>v.bottom.some((q,k)=>distance(p,q)<.03&&Math.min(w.top[j].z,v.top[k].z)-Math.max(p.z,q.z)>0));
            if(touch)group.push(w);
        }
        return group.map(w=>w.id);
    }
    const api={canonicalGeneratedWalls,chimneyContact,layerSetback,roofLayers:roof=>roofLayers(roof,surfaces(roof)),soffitWithoutSources,splitParameters,mergeCoplanar,build,buildSources,extrude,deduplicate,topology,simplifyGeneratedRing,plane,contains,onEdge,generatedMoveGroup,INCH};
    if(typeof module!=='undefined'&&module.exports)module.exports=api;
    else root.WallGeometry=api;
})(typeof window!=='undefined'?window:globalThis);
