import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requirePlatformAuth } from '../platform/auth.js';
import { badRequest, forbidden, PlatformError } from '../platform/errors.js';
import { env } from '../src/config/env.js';
import { getMerchantConfig } from './merchant_config.js';

const sessionSchema=z.object({session_id:z.string().uuid()});
const inputSchema=sessionSchema.extend({event:z.discriminatedUnion('type',[
  z.object({type:z.literal('pointer'),action:z.enum(['mousePressed','mouseReleased','mouseMoved']),x:z.number().finite(),y:z.number().finite(),button:z.enum(['left','right']).optional(),buttons:z.number().int().min(0).max(7).optional(),clickCount:z.number().int().min(1).max(2).optional()}),
  z.object({type:z.literal('wheel'),x:z.number().finite(),y:z.number().finite(),deltaX:z.number().finite(),deltaY:z.number().finite()}),
  z.object({type:z.literal('text'),text:z.string().max(10000)}),
  z.object({type:z.literal('key'),key:z.string().max(100)}),
  z.object({type:z.literal('resize'),width:z.number().int().min(420).max(1440),height:z.number().int().min(400).max(1200)}),
  z.object({type:z.literal('upload'),name:z.string().max(250),mime:z.string().max(100),data:z.string().max(14000000)}),
  z.object({type:z.literal('dialog'),accept:z.boolean(),text:z.string().max(1000).optional()}),
  z.object({type:z.enum(['back','reload'])})
])});

export async function browserWorker(action:string,body:Record<string,unknown>) {
  const base=process.env.PAYMENTS_BROWSER_URL;
  const token=process.env.PAYMENTS_BROWSER_TOKEN;
  if(!base||!token) throw new PlatformError('payment_browser_unavailable',503,'The signup browser is not configured yet.');
  let response;
  try {response=await fetch(new URL(action,base),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(action==='/start'?60000:35000)});}
  catch {throw new PlatformError('payment_browser_unavailable',503,'The signup browser is temporarily unavailable. Please try again.');}
  const data=await response.json() as Record<string,unknown>;
  if(!response.ok) throw new PlatformError('payment_browser_error',response.status,String(data.message||'The signup browser request failed.'));
  return data;
}

export function registerPaymentsBrowserApi(app:FastifyInstance,hostedSignup:(request:FastifyRequest,reply:FastifyReply)=>Promise<unknown>) {
  const prefix='/organizations/:orgId/merchant-boarding/browser';
  async function principal(request:FastifyRequest,write:boolean) {
    const orgId=String((request.params as {orgId:string}).orgId);
    const ctx=await requirePlatformAuth(request,{orgId,csrf:write,permission:'manage_projects'});
    if(process.env.FIRSTMEASURE_DATA_ENVIRONMENT!=='development'||!env.forwardApiBase.includes('sandbox')) throw forbidden('payment_browser_development_only','Streamed signup is available in development only.');
    return {ctx,tenant:createHash('sha256').update(orgId).digest('hex'),owner:createHash('sha256').update(JSON.stringify([orgId,ctx.userId])).digest('hex')};
  }
  app.post(prefix+'/session',async(request,reply)=>{
    const {ctx,owner,tenant}=await principal(request,true);
    const config=await getMerchantConfig(ctx.orgId);
    if(config.provider!=='forward') throw badRequest('payment_browser_provider','Choose the Forward sandbox provider for streamed signup.');
    reply.header('Cache-Control','no-store');
    const reserved=await browserWorker('/reserve',{owner,tenant});
    if(!reserved.claimed) return reserved;
    const session_id=reserved.session_id;
    try {
      // Only the worker's winning reservation creates/refreshes the provider
      // link. Other web nodes join the same browser without expiring its URL.
      const result=await hostedSignup(request,reply) as {link?:{url?:string};already_submitted?:boolean};
      if(result.already_submitted){await browserWorker('/close',{owner,session_id});return {ok:true,state:'submitted',already_submitted:true};}
      if(!result.link?.url) throw new PlatformError('payment_browser_link_missing',502,'The payment provider did not return a signup link. Please try again.');
      reply.code(200);
      return await browserWorker('/start',{owner,session_id,url:result.link.url});
    }catch(error){await browserWorker('/close',{owner,session_id}).catch(()=>{});throw error;}
  });
  app.get(prefix+'/frame',async(request,reply)=>{
    const {owner}=await principal(request,false);
    const body=sessionSchema.extend({after:z.coerce.number().int().min(0).default(0)}).parse(request.query);
    reply.header('Cache-Control','no-store');
    return browserWorker('/frame',{owner,...body});
  });
  app.post(prefix+'/input',{bodyLimit:15000000},async(request,reply)=>{
    const {owner}=await principal(request,true);
    reply.header('Cache-Control','no-store');
    return browserWorker('/input',{owner,...inputSchema.parse(request.body)});
  });
  app.post(prefix+'/close',async(request,reply)=>{
    const {owner}=await principal(request,true);
    reply.header('Cache-Control','no-store');
    return browserWorker('/close',{owner,...sessionSchema.parse(request.body)});
  });
}
