/* Latest-input frame queue. Input runs before view preparation and WebGL drawing. */
(function(root){'use strict';
const jobs=new Map();let scheduled=null,flushing=false;
function enqueue(key,run,priority=20){jobs.set(key,{run,priority});if(scheduled===null&&!flushing)scheduled=requestAnimationFrame(flush);}
function cancel(key){jobs.delete(key);if(!jobs.size&&scheduled!==null){cancelAnimationFrame(scheduled);scheduled=null;}}
function flush(){if(flushing)return false;if(scheduled!==null){cancelAnimationFrame(scheduled);scheduled=null;}flushing=true;let ran=false;const visited=new Set();try{
 while(true){const next=[...jobs].filter(([key])=>!visited.has(key)).sort((a,b)=>a[1].priority-b[1].priority)[0];if(!next)break;const [key,job]=next;visited.add(key);jobs.delete(key);ran=true;job.run();}
}finally{flushing=false;if(jobs.size&&scheduled===null)scheduled=requestAnimationFrame(flush);}return ran;}
root.ExteriorFramePipeline={enqueue,cancel,flush};
})(window);
