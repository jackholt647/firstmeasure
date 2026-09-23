/* Terrain meshes and bounded, deterministic lower-surface fitting. Metres. */
(function(root){
    'use strict';
    const G=typeof module!=='undefined'&&module.exports?require('./wall_geometry.js'):root.WallGeometry;
    const at=(p,q)=>p.dx*q.x+p.dy*q.y+p.k;
    const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
    function bounds(roof,pad=3){
        const ps=(roof.faces||[]).flatMap(f=>f.points);
        if(!ps.length)throw Error('Ground needs a resolved roof extent.');
        return {x0:Math.min(...ps.map(p=>p.x))-pad,x1:Math.max(...ps.map(p=>p.x))+pad,y0:Math.min(...ps.map(p=>p.y))-pad,y1:Math.max(...ps.map(p=>p.y))+pad};
    }
    function triangulate(points){
        if(points.length<3||points.length>128)throw Error('Use between 3 and 128 ground points.');
        for(let i=0;i<points.length;i++){
            if(![points[i].x,points[i].y,points[i].z].every(Number.isFinite))throw Error('Ground coordinates must be finite.');
            for(let j=0;j<i;j++)if(Math.hypot(points[i].x-points[j].x,points[i].y-points[j].y)<.02)throw Error('Ground points need at least 2 cm of horizontal separation.');
        }
        const xs=points.map(p=>p.x),ys=points.map(p=>p.y),cx=(Math.min(...xs)+Math.max(...xs))/2,cy=(Math.min(...ys)+Math.max(...ys))/2;
        const size=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys),1)*32,n=points.length;
        const ps=[...points,{x:cx-size,y:cy-size},{x:cx+size,y:cy-size},{x:cx,y:cy+size}];
        let tris=[[n,n+1,n+2]];
        for(let i=0;i<n;i++){
            const edges=new Map(),keep=[];
            for(const tri of tris){
                const [a,b,c]=tri.map(k=>({x:ps[k].x-ps[i].x,y:ps[k].y-ps[i].y}));
                const det=(a.x*a.x+a.y*a.y)*(b.x*c.y-b.y*c.x)-(b.x*b.x+b.y*b.y)*(a.x*c.y-a.y*c.x)+(c.x*c.x+c.y*c.y)*(a.x*b.y-a.y*b.x);
                if(det>1e-9){for(let j=0;j<3;j++){const e=[tri[j],tri[(j+1)%3]],key=[...e].sort((a,b)=>a-b).join(':');if(edges.has(key))edges.delete(key);else edges.set(key,e);}}
                else keep.push(tri);
            }
            for(const [a,b]of edges.values()){const area=cross(ps[a],ps[b],ps[i]);if(Math.abs(area)>1e-8)keep.push(area>0?[a,b,i]:[b,a,i]);}
            tris=keep;
        }
        const faces=tris.filter(t=>t.every(i=>i<n));
        if(!faces.length)throw Error('Ground points must enclose an area.');
        return faces;
    }
    function mesh(points,extra={}){return {...extra,points:points.map(p=>({...p})),faces:triangulate(points)};}
    function fromPlane(b,plane,extra={}){
        return mesh([{x:b.x0,y:b.y0},{x:b.x1,y:b.y0},{x:b.x1,y:b.y1},{x:b.x0,y:b.y1}].map(p=>({...p,z:at(plane,p)})),{...extra,plane});
    }
    function reference(terrain,roof){
        const b=bounds(roof),source=/usgs/i.test(terrain?.source||'')?'USGS':/dsm/i.test(terrain?.source||'')?'DSM':'Flat';
        const ps=terrain?.points||[],fit=G.plane(ps),center={x:(b.x0+b.x1)/2,y:(b.y0+b.y1)/2};
        const z=fit?at(fit,center):(ps[0]?.z||0),plane=source==='Flat'?{dx:0,dy:0,k:z}:fit||{dx:0,dy:0,k:z};
        return fromPlane(b,plane,{source:terrain?.sampledPoint?'DSM point':source,...(terrain?.sampledPoint?{sampledPoint:{...terrain.sampledPoint}}:{}),stats:terrain?.stats,visible:terrain?.simpleGrade===1?terrain.visible!==false:true,simpleGrade:1});
    }
    function height(terrain,p){
        for(const ids of terrain.faces){const points=ids.map(i=>terrain.points[i]);if(G.contains({points},p))return at(G.plane(points),p);}
        return null;
    }
    function fit(samples){
        if(samples.length<12)throw Error('Too few exposed ground samples. Click DSM to choose a ground point.');
        let seed=7843;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
        let best=null;
        for(let k=0;k<600;k++){
            const ps=Array.from({length:3},()=>samples[Math.floor(random()*samples.length)]);
            const p=G.plane(ps);if(!p||Math.hypot(p.dx,p.dy)>1)continue;
            const residuals=samples.map(s=>s.z-at(p,s)),inliers=samples.filter((s,i)=>Math.abs(residuals[i])<=.4);
            const below=residuals.filter(v=>v<-.6).length;
            // A tree/roof consensus has many observations below it; isolated
            // ditches are tolerated without pulling the whole surface down.
            if(below>samples.length*.2)continue;
            const score=inliers.length-below*.5;
            if(!best||score>best.score)best={p,inliers,score};
        }
        if(!best||best.inliers.length<Math.max(10,samples.length*.2))throw Error('No consistent exposed ground plane found. Click DSM to choose a ground point.');
        let p=G.plane(best.inliers);
        for(let i=0;i<3;i++){const inliers=samples.filter(s=>Math.abs(s.z-at(p,s))<.45);p=G.plane(inliers)||p;}
        const inliers=samples.filter(s=>Math.abs(s.z-at(p,s))<.45),xs=samples.map(s=>s.x),ys=samples.map(s=>s.y);
        const coverage=(Math.max(...inliers.map(s=>s.x))-Math.min(...inliers.map(s=>s.x)))*(Math.max(...inliers.map(s=>s.y))-Math.min(...inliers.map(s=>s.y)))/((Math.max(...xs)-Math.min(...xs))*(Math.max(...ys)-Math.min(...ys)));
        if(coverage<.25)throw Error('Ground evidence is too localized to infer the site grade. Click DSM to choose a ground point.');
        return {plane:p,stats:{samples:samples.length,inliers:inliers.length,coverage,rmse:Math.sqrt(inliers.reduce((sum,s)=>sum+(s.z-at(p,s))**2,0)/inliers.length),grade:Math.hypot(p.dx,p.dy)*100}};
    }
    function sampleDSMPoint(data,ctx,pixel,origin=ctx){
        if(!data||data.length<ctx.width*ctx.height||!(ctx.mpp>0))throw Error('Wait for the DSM height map to load.');
        const ix=Math.round(pixel.x),iy=Math.round(pixel.y);
        if(!Number.isFinite(ix)||!Number.isFinite(iy)||ix<0||iy<0||ix>=ctx.width||iy>=ctx.height)throw Error('Click inside the DSM height map.');
        const value=data[iy*ctx.width+ix],z=value==null?NaN:Number(value);
        if(!Number.isFinite(z)||z<=-9000||z>9000)throw Error('No DSM height at that point. Choose another ground point.');
        const dx=((origin.lng||0)-(ctx.lng||0))*111132*Math.cos((ctx.lat||0)*Math.PI/180),dy=((ctx.lat||0)-(origin.lat||0))*111132;
        return {x:(ix-ctx.width/2)*ctx.mpp-dx,y:(iy-ctx.height/2)*ctx.mpp-dy,z};
    }
    function initial(data,ctx,roof,fallback=0){
        const b=bounds(roof);
        try{const r=fit(sampleDSM(data,ctx,roof));return fromPlane(b,r.plane,{source:'DSM',stats:r.stats,visible:false,simpleGrade:1});}
        catch(e){return fromPlane(b,{dx:0,dy:0,k:Number.isFinite(fallback)?fallback:0},{source:'Flat',visible:false,simpleGrade:1});}
    }
    function sampleDSM(data,ctx,roof){
        if(!data||data.length<ctx.width*ctx.height)throw Error('Wait for the solar height map to load.');
        const b=bounds(roof,20),samples=[],cols=16,rows=16;
        // Equal-area cells prevent densely sampled objects dominating the fit.
        for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){
            const cell=[];
            for(let v=0;v<8;v++)for(let u=0;u<8;u++){
                const x=b.x0+(i+(u+.5)/8)*(b.x1-b.x0)/cols,y=b.y0+(j+(v+.5)/8)*(b.y1-b.y0)/rows;
                const ix=Math.round(ctx.width/2+x/ctx.mpp),iy=Math.round(ctx.height/2+y/ctx.mpp);
                if(ix<0||iy<0||ix>=ctx.width||iy>=ctx.height)continue;
                const z=Number(data[iy*ctx.width+ix]);if(!Number.isFinite(z)||z<=-9000||z>9000)continue;
                const point={x:(ix-ctx.width/2)*ctx.mpp,y:(iy-ctx.height/2)*ctx.mpp,z};
                if(roof.faces.some(f=>G.contains(f,point)))continue;
                cell.push(point);
            }
            if(cell.length>=6){cell.sort((a,b)=>a.z-b.z);samples.push(cell[Math.floor((cell.length-1)*.1)]);}
        }
        return samples;
    }
    const api={bounds,triangulate,mesh,fromPlane,reference,height,fit,sampleDSM,sampleDSMPoint,initial,at};
    if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.GroundGeometry=api;
})(typeof window!=='undefined'?window:globalThis);
