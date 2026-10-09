import assert from 'node:assert/strict';
import test from 'node:test';
import { TelnyxClient } from '../messaging/telnyx.js';
import { TelnyxVoiceClient } from '../telephony/telnyx.js';
import { env } from '../src/config/env.js';
import { customerCallWorkerAllowed } from '../comms/calls/worker.js';

test('staff connection uses Telnyx API codec names and parks browser dialing', async () => {
  let payload: Record<string, any> = {};
  const client = new TelnyxClient({apiKey:'test-only',fetchImpl:async (url, init) => {
    assert.equal(String(url),'https://api.telnyx.com/v2/credential_connections');
    assert.equal(init?.method,'POST');
    payload=JSON.parse(String(init?.body));
    return new Response(JSON.stringify({data:{id:'test-connection'}}),{status:201});
  }});
  await new TelnyxVoiceClient(client).createConnection('test-organization');
  const supported=new Set(['G722','G711U','G711A','G729','OPUS','H.264','VP8','VP9','AMR-WB','AMR']);
  assert.ok(payload.inbound.codecs.length>0);
  for(const codec of payload.inbound.codecs)assert.ok(supported.has(codec),`Unsupported Telnyx codec: ${codec}`);
  assert.ok(payload.inbound.codecs.includes('OPUS'));
  assert.equal(payload.encrypted_media,'SRTP');
  assert.equal(payload.outbound.call_parking_enabled,true);
  assert.equal(payload.sip_uri_calling_preference,'internal');
  assert.match(payload.user_name,/^[A-Za-z0-9]+$/);
});

test('a development call worker owner does not enable general platform scheduling', async () => {
  const {platformBackgroundAllowed}=await import('../platform/runtime.js');
  const previous={dataEnvironment:env.dataEnvironment,deploymentTopology:env.deploymentTopology};
  const keys=['CUSTOMER_CALL_WORKER_OWNER','PLATFORM_PROCESS_ROLE','PLATFORM_BACKGROUND_DISABLED'];
  const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try {
    Object.assign(env,{dataEnvironment:'development',deploymentTopology:'cluster'});
    delete process.env.PLATFORM_PROCESS_ROLE;
    process.env.PLATFORM_BACKGROUND_DISABLED='1';
    process.env.CUSTOMER_CALL_WORKER_OWNER='0';
    assert.equal(customerCallWorkerAllowed(),false);
    process.env.CUSTOMER_CALL_WORKER_OWNER='1';
    assert.equal(customerCallWorkerAllowed(),true);
    assert.equal(platformBackgroundAllowed(),false);
    Object.assign(env,{dataEnvironment:'production'});
    assert.equal(customerCallWorkerAllowed(),false);
  } finally {
    Object.assign(env,previous);
    for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
  }
});

test('development blocks unapproved PSTN calls and transfers before contacting Telnyx', async () => {
  const previousEnvironment=env.dataEnvironment;
  const previousAllowlist=process.env.TELNYX_VOICE_DEVELOPMENT_ALLOWED_NUMBERS;
  let requests=0;
  const client=new TelnyxVoiceClient(new TelnyxClient({apiKey:'test-only',fetchImpl:async()=>{
    requests++;
    return new Response(JSON.stringify({data:{id:'test-call'}}),{status:200});
  }}));
  try {
    Object.assign(env,{dataEnvironment:'development'});
    delete process.env.TELNYX_VOICE_DEVELOPMENT_ALLOWED_NUMBERS;
    await assert.rejects(client.dial({to:'+12065550100'}),{code:'development_voice_destination_blocked'});
    process.env.TELNYX_VOICE_DEVELOPMENT_ALLOWED_NUMBERS='+12065550100';
    await assert.rejects(client.dial({to:'+12065550101'}),{code:'development_voice_destination_blocked'});
    await assert.rejects(client.command('call','transfer',{to:'+12065550101'}),{code:'development_voice_destination_blocked'});
    await assert.rejects(client.dial({to:'sip:agent@untrusted.example'}),{code:'development_voice_destination_blocked'});
    assert.equal(requests,0);
    process.env.TELNYX_VOICE_DEVELOPMENT_ALLOWED_NUMBERS='+14259700671';
    await client.dial({to:'+12065550100'});
    await client.dial({to:'sip:agent@sip.telnyx.com'});
    assert.equal(requests,2);
    Object.assign(env,{dataEnvironment:'production'});
    await client.dial({to:'+12065550101'});
    assert.equal(requests,3);
  } finally {
    Object.assign(env,{dataEnvironment:previousEnvironment});
    if(previousAllowlist===undefined)delete process.env.TELNYX_VOICE_DEVELOPMENT_ALLOWED_NUMBERS;
    else process.env.TELNYX_VOICE_DEVELOPMENT_ALLOWED_NUMBERS=previousAllowlist;
  }
});
