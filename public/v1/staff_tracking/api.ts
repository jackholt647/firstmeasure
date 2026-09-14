import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authContextFromRequest, requirePlatformAuth, type PlatformAuthContext } from '../platform/auth.js';
import { readInternalUser, listInternalUsers } from '../internal/storage.js';
import { activeStaff, browserFamily, enabled, fullAdmin, normalizeIp, reference, RETENTION_DAYS, SAMPLE_MS, signalsFor, visitorIp, type TrackingEvent } from './core.js';
import { expireTracking, insertEvent, priorEvents, trackingQuery } from './store.js';

const base='/v1/staff-tracking';
const cache=new Map<string,number>();
let pending=0, dropped=0, failures=0;
const object=(v: unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as any:{};
async function staffContext(request: FastifyRequest, csrf=false) {
  const auth=await requirePlatformAuth(request,{csrf});
  const user=await readInternalUser(String(auth.identity.email||''));
  if(!activeStaff(user)) throw Object.assign(new Error('Active staff access required'),{statusCode:403});
  return {auth,user:user!};
}
async function viewer(request: FastifyRequest,csrf=false,adminOnly=false) {
  const c=await staffContext(request,csrf);
  if(!fullAdmin(c.user) && (adminOnly || !(await trackingQuery('SELECT email FROM staff_tracking_grants WHERE email=$1',[c.user.email])).length)) throw Object.assign(new Error('Tracking permission required'),{statusCode:403});
  return c;
}
async function audit(actor:string,action:string,target:string) { await trackingQuery('INSERT INTO staff_tracking_audit(id,actor,action,target,at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),actor,action,target,new Date().toISOString()]); }
export async function recordTracking(request: FastifyRequest,kind:TrackingEvent['kind'],details:Partial<TrackingEvent>={},context?:PlatformAuthContext) {
  if(!enabled())return;
  const auth=context||await authContextFromRequest(request);if(!auth)return;
  const user=await readInternalUser(String(auth.identity.email||''));if(!activeStaff(user))return;
  const at=new Date().toISOString();
  const ip=visitorIp(request.raw.socket.remoteAddress||request.ip,String(request.headers['x-forwarded-for']||''));
  const e:TrackingEvent={id:'',email:user!.email,name:user!.name,at,ip,kind,session_ref:reference(auth.sessionId),browser:browserFamily(String(request.headers['user-agent']||'')),
    established:user!.training_complete===true||user!.role==='qa',impersonated:!!object(auth.session.metadata).impersonated,
    course:String(details.course||'').slice(0,120),attempt:String(details.attempt||'').slice(0,120),project:String(details.project||'').slice(0,120)};
  e.id=reference([e.email,e.session_ref,ip,kind,e.course,e.attempt,e.project,Math.floor(Date.now()/SAMPLE_MS)].join('|'));
  await insertEvent(e);
}
function enqueue(task:()=>Promise<void>,app:FastifyInstance) {
  if(pending>=32){dropped++;return;}
  pending++;
  void task().catch(()=>{failures++;app.log.warn('Staff tracking collection failed; normal workflow continues.');}).finally(()=>pending--);
}
export async function flushTracking() { while(pending)await new Promise(r=>setTimeout(r,10)); }
export function installStaffTracking(app:FastifyInstance) {
  // Collect once at the public web entry (not again on the compatibility proxy).
  app.addHook('onResponse',async(request,reply)=>{
    if(!enabled()||process.env.CLUSTER_NODE_ROLE==='legacy'||reply.statusCode>=400)return;
    const url=request.url.split('?')[0]!;
    if(!url.startsWith('/v1/')||url.startsWith(base)||url.startsWith('/v1/health')||url.startsWith('/v1/private/'))return;
    const cookie=String(request.headers.cookie||'');if(!cookie)return;
    const key=reference(cookie+'|'+String(request.headers['x-forwarded-for']||request.ip));
    const now=Date.now();if((cache.get(key)||0)>now)return;
    if(cache.size>10000){for(const [k,t] of cache)if(t<now)cache.delete(k);if(cache.size>10000)cache.clear();}
    cache.set(key,now+SAMPLE_MS);
    enqueue(()=>recordTracking(request,url==='/v1/platform/auth/session'?'session_seen':'activity'),app);
  });
  void app.register(async routes=>{
    routes.addHook('onRequest',async(_req,reply)=>{reply.header('Cache-Control','no-store');if(!enabled())return reply.code(404).send({error:'Tracking pilot is not enabled'});});
    routes.setErrorHandler((error,_req,reply)=>reply.code(error instanceof z.ZodError?400:Number((error as any).statusCode)||503).send({error:error instanceof z.ZodError?'Invalid tracking request':(error as any).statusCode?(error as Error).message:'Tracking unavailable; no inference can be made from missing data'}));
    routes.get('/access',async req=>{const c=await viewer(req);return {ok:true,admin:fullAdmin(c.user),retention_days:RETENTION_DAYS};});
    routes.get('/events',async req=>{
      const c=await viewer(req);const q=z.object({email:z.string().max(200).optional(),ip:z.string().max(60).optional(),training:z.enum(['1']).optional(),before:z.string().datetime().optional(),cursor:z.string().max(100).optional(),days:z.coerce.number().int().min(1).max(90).default(30)}).parse(req.query);
      const cutoff=new Date(Date.now()-q.days*86400000).toISOString();const args:(string|number|null)[]=[cutoff];let where='e.at>=$1';
      const add=(sql:string,value:string)=>{args.push(value);where+=' AND '+sql.replace('?',`$${args.length}`);};
      if(q.email)add('e.email=?',q.email.trim().toLowerCase());if(q.ip){const ip=normalizeIp(q.ip);if(!ip)throw Object.assign(new Error('Invalid IP'),{statusCode:400});add('e.ip=?',ip);}
      if(q.training)where+=" AND e.kind IN ('training_start','training_submit','exam_start','exam_submit')";
      if(q.before){args.push(q.before,q.cursor||'');where+=` AND (e.at<$${args.length-1} OR (e.at=$${args.length-1} AND e.id<$${args.length}))`;}
      const rows=await trackingQuery(`SELECT e.data,r.status,r.note,r.reviewer,r.at AS reviewed_at FROM staff_tracking_events e LEFT JOIN staff_tracking_reviews r ON r.event_id=e.id WHERE ${where} ORDER BY e.at DESC,e.id DESC LIMIT 51`,args);
      const page=rows.slice(0,50);const events=[];
      for(const row of page){const e=JSON.parse(row.data) as TrackingEvent;const prior=await priorEvents(e);events.push({...e,signals:signalsFor(e,prior).filter(s=>!prior.limited||s.key!=='new_ip').map(s=>({...s,matches:s.matches.slice(0,20),match_count:s.matches.length})),history_limited:prior.limited,review:row.status?{status:row.status,note:row.note,reviewer:row.reviewer,at:row.reviewed_at}:null});}
      await audit(c.user.email,'view_events',q.email||q.ip||'recent');
      const last=events.at(-1);return {ok:true,events,next:rows.length>50&&last?{before:last.at,cursor:last.id}:null,retention_days:RETENTION_DAYS,coverage:'Only observed activity since enablement is available; missing history is not evidence of no sharing.',collection:{pending,dropped,failures,scope:'this process since startup'}};
    });
    routes.post('/review',async req=>{const c=await viewer(req,true);const b=z.object({id:z.string().regex(/^[a-f0-9]{64}$/),status:z.enum(['needs_review','explained','dismissed']),note:z.string().max(1000)}).strict().parse(req.body);
      if(!(await trackingQuery('SELECT id FROM staff_tracking_events WHERE id=$1 AND at>=$2',[b.id,new Date(Date.now()-RETENTION_DAYS*86400000).toISOString()])).length)throw Object.assign(new Error('Event unavailable'),{statusCode:404});
      await trackingQuery('INSERT INTO staff_tracking_reviews(event_id,status,note,reviewer,at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(event_id) DO UPDATE SET status=excluded.status,note=excluded.note,reviewer=excluded.reviewer,at=excluded.at',[b.id,b.status,b.note,c.user.email,new Date().toISOString()]);await audit(c.user.email,'review:'+b.status,b.id);return {ok:true};});
    routes.get('/access-list',async req=>{await viewer(req,false,true);const users=await listInternalUsers();const grants=await trackingQuery('SELECT * FROM staff_tracking_grants ORDER BY email');return {ok:true,users:users.filter(activeStaff).map(u=>({email:u.email,name:u.name,admin:fullAdmin(u)})),grants};});
    routes.post('/access-list',async req=>{const c=await viewer(req,true,true);const b=z.object({email:z.string().email().max(200),allow:z.boolean()}).strict().parse(req.body);const email=b.email.toLowerCase();const user=await readInternalUser(email);if(!activeStaff(user)||fullAdmin(user))throw Object.assign(new Error('Choose an active non-admin staff member'),{statusCode:400});
      if(b.allow)await trackingQuery('INSERT INTO staff_tracking_grants(email,granted_by,at) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET granted_by=excluded.granted_by,at=excluded.at',[email,c.user.email,new Date().toISOString()]);else await trackingQuery('DELETE FROM staff_tracking_grants WHERE email=$1',[email]);await audit(c.user.email,b.allow?'grant':'revoke',email);return {ok:true};});
  },{prefix:base});
  // Private HMAC bridge: never mounted behind /internal's automatic secret proxy.
  app.post('/v1/private/staff-tracking',{bodyLimit:16384},async(req,reply)=>{
    const secret=process.env.STAFF_TRACKING_BRIDGE_SECRET||'';
    const b=z.object({payload:z.string().max(8000),signature:z.string().regex(/^[a-f0-9]{64}$/)}).safeParse(req.body);
    if(!enabled()||secret.length<32||!b.success)return reply.code(403).send({ok:false});
    const expected=createHmac('sha256',secret).update(b.data.payload).digest();if(!timingSafeEqual(expected,Buffer.from(b.data.signature,'hex')))return reply.code(403).send({ok:false});
    let parsed:unknown;try{parsed=JSON.parse(b.data.payload);}catch{return reply.code(400).send({ok:false});}
    const input=z.object({email:z.string().email(),actor:z.string().email(),at:z.string().datetime(),peer:z.string().max(64),forwarded:z.string().max(2048),session_ref:z.string().regex(/^[a-f0-9]{64}$/),ua:z.string().max(400),kind:z.enum(['exam_submit','training_submit']),course:z.string().max(120),attempt:z.string().max(120),project:z.string().max(120),impersonated:z.boolean()}).safeParse(parsed);
    if(!input.success||Math.abs(Date.now()-Date.parse(input.data.at))>120000)return reply.code(400).send({ok:false});
    const d=input.data;const user=await readInternalUser(d.email);const actor=await readInternalUser(d.actor);if(!activeStaff(user)||!activeStaff(actor))return reply.code(403).send({ok:false});
    const e:TrackingEvent={id:reference(b.data.payload),email:user!.email,name:user!.name,at:d.at,ip:visitorIp(d.peer,d.forwarded),kind:d.kind,session_ref:d.session_ref,browser:browserFamily(d.ua),established:user!.training_complete===true||user!.role==='qa',impersonated:d.impersonated||d.email!==d.actor,course:d.course,attempt:d.attempt,project:d.project};
    await insertEvent(e);return {ok:true};
  });
  if(enabled()){
    const timer=setInterval(()=>enqueue(expireTracking,app),3600000);timer.unref();
    app.addHook('onClose',async()=>{clearInterval(timer);await flushTracking();});
  }
}
export async function trackTutorialResult(request:FastifyRequest,action:string,result:Record<string,any>,body:Record<string,any>,app:FastifyInstance) {
  if(!enabled()||!result.success)return;
  const kind=action==='start_tutorial_test_attempt'?'exam_start':action==='start_tutorial_project'?'training_start':action==='start_tutorial_draft_reject_round'?(body.mode==='test'?'exam_start':'training_start'):null;if(!kind)return;
  enqueue(async()=>{
    const auth=await authContextFromRequest(request);if(!auth)return;
    const actor=String(request.headers['x-internal-user-email']||body.actor_email||object(body.actor).email||'').toLowerCase();
    if(actor&&actor!==String(auth.identity.email).toLowerCase())return;
    await recordTracking(request,kind,{course:String(result.course_id||body.course_id||'default'),attempt:String(result.attempt_id||''),project:String(result.folder||result.tutorial_id||'')},auth);
  },app);
}
