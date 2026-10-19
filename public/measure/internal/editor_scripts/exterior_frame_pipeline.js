/* Latest-input frame queue. Input runs before view preparation and WebGL drawing. */
(function(root){'use strict';
const jobs=new Map();let scheduled=null,flushing=false;
// three.js deletes a compiled WebGL program as soon as no material uses it. Exterior redraws replace their
// materials, so the same shaders were destroyed and recompiled several times per frame (each compile blocks
// on the driver). One retained reference per program keeps it for the next identical material. Bounded.
const RETAIN_LIMIT=256,retained=new WeakMap();
function retainPrograms(){
 // main.js declares the renderer with a top-level let, so it is a global binding, not a window property.
 const active=(typeof renderer!=='undefined'&&renderer)||root.renderer||null,programs=active?.info?.programs;if(!Array.isArray(programs))return;
 let kept=retained.get(active);if(!kept){kept=new WeakSet();kept.count=0;retained.set(active,kept);}
 for(const program of programs){if(kept.count>=RETAIN_LIMIT)return;if(!program||kept.has(program)||typeof program.usedTimes!=='number')continue;kept.add(program);kept.count++;program.usedTimes++;}
}
function enqueue(key,run,priority=20){jobs.set(key,{run,priority});if(scheduled===null&&!flushing)scheduled=requestAnimationFrame(flush);}
function cancel(key){jobs.delete(key);if(!jobs.size&&scheduled!==null){cancelAnimationFrame(scheduled);scheduled=null;}}
function flush(){if(flushing)return false;retainPrograms();if(scheduled!==null){cancelAnimationFrame(scheduled);scheduled=null;}flushing=true;let ran=false;const visited=new Set();try{
 while(true){const next=[...jobs].filter(([key])=>!visited.has(key)).sort((a,b)=>a[1].priority-b[1].priority)[0];if(!next)break;const [key,job]=next;visited.add(key);jobs.delete(key);ran=true;job.run();}
}finally{flushing=false;if(jobs.size&&scheduled===null)scheduled=requestAnimationFrame(flush);}return ran;}
root.ExteriorFramePipeline={enqueue,cancel,flush,retainPrograms};
})(window);
