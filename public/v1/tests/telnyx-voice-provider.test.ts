import assert from 'node:assert/strict';
import test from 'node:test';
import { TelnyxClient } from '../messaging/telnyx.js';
import { TelnyxVoiceClient } from '../telephony/telnyx.js';
import { env } from '../src/config/env.js';

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
