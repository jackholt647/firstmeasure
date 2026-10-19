import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../src/config/env.js';
import { badRequest, forbidden, notFound } from '../../platform/errors.js';
import { type PlatformAuthContext } from '../../platform/auth.js';
import * as s from '../calls/storage.js';

const signature=(org:string,id:string,expires:string)=>createHmac('sha256',env.platformSessionSecret).update(JSON.stringify([org,id,expires])).digest('hex');
export async function saveGreeting(ctx:PlatformAuthContext,input:unknown){
  const v=z.object({file:z.string().max(6*1024*1024),name:z.string().min(1).max(120)}).parse(input),buffer=Buffer.from(v.file,'base64');
  const wav=buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WAVE',mp3=buffer.subarray(0,3).toString()==='ID3'||buffer[0]===255&&((buffer[1]||0)&224)===224;
  if(buffer.length>4*1024*1024||buffer.length<12||!wav&&!mp3)throw badRequest('greeting_format','Upload a WAV or MP3 recording up to 4 MB.');
  const id=s.id('greeting');await s.saveResource(ctx.orgId,'phone_greeting',id,{owner_user_id:ctx.userId,name:v.name,file:v.file,content_type:wav?'audio/wav':'audio/mpeg'});return {id,name:v.name};
}
export function greetingUrl(org:string,id:string){const expires=String(Date.now()+15*60000);return `${env.publicBaseUrl}/v1/comms/phone-greetings/${encodeURIComponent(org)}/${encodeURIComponent(id)}?expires=${expires}&signature=${signature(org,id,expires)}`;}
export async function readGreeting(org:string,id:string,expires:string,provided:string){
  if(!/^\d{13}$/.test(expires)||Number(expires)<Date.now()||Number(expires)>Date.now()+16*60000||! /^[a-f0-9]{64}$/.test(provided)||!timingSafeEqual(Buffer.from(provided,'hex'),Buffer.from(signature(org,id,expires),'hex')))throw forbidden('greeting_expired','This audio link expired.');
  const row=await s.resource(org,'phone_greeting',id);if(!row)throw notFound('greeting_missing','This greeting is unavailable.');return {buffer:Buffer.from(s.text(row.file),'base64'),content_type:s.text(row.content_type)};
}
