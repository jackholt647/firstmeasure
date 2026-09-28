import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/**
 * Money onboarding slice: the env-derived default merchant provider and the
 * money_onboarding attention source (all five states) computed from
 * capabilities + merchant config + boarding application state.
 */

let app: any = null;
let storageRoot = "";

const US_PLAN_ID = "partppl_3HpoNDtV6PtzrHasDxATGCIww6m";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) => {
    return await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {}),
        ...extraHeaders
      }
    });
  };
  const request = async (method: string, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) => {
    const response = await raw(method, url, payload, extraHeaders);
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [
        sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "",
        csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""
      ].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-payment-browser-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.V1_LOG_LEVEL = "error";
  // No Forward credentials: the environment default must resolve to mock.
  process.env.FORWARD_WEBHOOK_SECRET = "";
  process.env.FORWARD_PRIVATE_KEY = "";
  process.env.FORWARD_PUBLIC_KEY = "";

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  const { closeWorkforceDatabase } = await import("../workforce/storage.js");
  (await closeWorkforceDatabase());
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function register(client: ReturnType<typeof createSessionClient>, options: { moneyFlags?: boolean } = {}) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `onboarding-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Onboarding Owner",
    company: "Onboarding Test Org",
    organization_id: `org_onb_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  const orgId = data.organization.id as string;
  if (options.moneyFlags !== false) {
    const { saveGlobal } = await import("../platform/storage.js");
    await saveGlobal(orgId, {
      data: {
        app_flags: {
          platform: { expanded_access: true, money: true },
          money: { merchant_processing: true }
        }
      }
    }, { replace: false });
  }
  return { orgId };
}


test("streamed signup reauthorizes org access and CSRF and never accepts a caller-selected URL", async () => {
  const owner=createSessionClient(), outsider=createSessionClient();
  const {orgId}=await register(owner);await register(outsider);
  const {env}=await import('../src/config/env.js');
  const {upsertMerchantConfig}=await import('../payments/merchant_config.js');
  const {saveGlobal}=await import('../platform/storage.js');
  await upsertMerchantConfig(orgId,{provider:'forward'});
  const old={environment:process.env.FIRSTMEASURE_DATA_ENVIRONMENT,url:process.env.PAYMENTS_BROWSER_URL,token:process.env.PAYMENTS_BROWSER_TOKEN,forward:env.forwardApiBase,fetch:globalThis.fetch};
  const calls:Array<{url:string,body:any}>=[];
  process.env.FIRSTMEASURE_DATA_ENVIRONMENT='development';process.env.PAYMENTS_BROWSER_URL='http://browser.test';process.env.PAYMENTS_BROWSER_TOKEN='x'.repeat(64);Object.assign(env,{forwardApiBase:'https://api.sandbox.getfwd.com'});
  globalThis.fetch=(async (input:any,options:any)=>{
    if(!String(input).startsWith('http://browser.test'))return old.fetch(input,options);
    const body=JSON.parse(options.body);calls.push({url:String(input),body});
    return new Response(JSON.stringify({ok:true,state:'ready',session_id:'00112233-4455-4677-8899-aabbccddeeff',claimed:false,width:900,height:780}),{headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  try{
    const base=`/v1/payments/organizations/${orgId}/merchant-boarding/browser`;
    const started=await owner.request('POST',base+'/session',{url:'http://169.254.169.254/'});
    assert.equal(started.state,'ready');assert.equal(calls.length,1);
    assert.deepEqual(Object.keys(calls[0]!.body).sort(),['owner','tenant']);
    const denied=await outsider.raw('GET',base+'/frame?session_id='+started.session_id);
    assert.ok([401,403,404].includes(denied.statusCode));assert.equal(calls.length,1);
    const csrf=await owner.raw('POST',base+'/input',{session_id:started.session_id,event:{type:'text',text:'private'}},{'x-platform-csrf':'wrong'});
    assert.equal(csrf.statusCode,403);assert.equal(calls.length,1);
    const arbitrary=await owner.raw('POST',base+'/input',{session_id:started.session_id,event:{type:'evaluate',script:'process.env'}});
    assert.equal(arbitrary.statusCode,400);assert.equal(calls.length,1);
    await owner.request('GET',base+'/frame?session_id='+started.session_id);
    assert.equal(calls[1]!.body.owner,calls[0]!.body.owner);
    await saveGlobal(orgId,{data:{app_flags:{platform:{money:false}}}},{replace:false});
    const freshOrgAccess=await owner.raw('GET',base+'/frame?session_id='+started.session_id);
    assert.equal(freshOrgAccess.statusCode,200,'Onboarding remains available before enabling the Money workspace, like hosted signup.');
    assert.equal(calls.length,3);
  }finally{
    globalThis.fetch=old.fetch;Object.assign(env,{forwardApiBase:old.forward});
    for(const[key,value]of Object.entries({FIRSTMEASURE_DATA_ENVIRONMENT:old.environment,PAYMENTS_BROWSER_URL:old.url,PAYMENTS_BROWSER_TOKEN:old.token}))if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
});
