import { nextTestPhone, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

type TestClient = ReturnType<typeof createSessionClient>;

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown, omitCsrf = false) => {
    const response = await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(!omitCsrf && csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
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
    let data: any = null;
    try {
      data = response.body ? JSON.parse(response.body) : null;
    } catch {
      data = null;
    }
    return { statusCode: response.statusCode, body: response.body, data };
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.data;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-apptconf-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.APPOINTMENT_CONFIRMATIONS_DISABLED = "1";
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.MESSAGING_STORAGE_ROOT = path.join(storageRoot, "messaging");
  process.env.V1_LOG_LEVEL = "error";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await (await import("../firstmeasure/job_runtime.js")).stopFirstMeasureJobRuntime();
  if (app) await app.close();
  await closePlatformFixtureStores();
  const { closeWorkDatabase } = await import("../work/storage.js");
  const { closeAppointmentsDatabase } = await import("../appointments/storage.js");
  (await closeWorkDatabase());
  (await closeAppointmentsDatabase());
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  await closeSqlStoresForTests();
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function registerOwner(client: TestClient) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    email: `appt-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Appointment Test Owner",
    phone: nextTestPhone(),
    company: "Appointment Confirmation Test Org",
    organization_id: `org_apptconf_${suffix}`
  });
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues(String(registered.organization.id), { "platform.expanded_access": true });
  return { orgId: String(registered.organization.id), suffix };
}

async function createProject(orgId: string, projectId: string, name: string, contact: { email: string; phone: string }) {
  const { upsertDocument } = await import("../platform/storage.js");
  await upsertDocument(orgId, "projects", {
    id: projectId,
    data: {
      id: projectId,
      title: `${name} Roof Replacement`,
      branch_id: "default",
      status: "open",
      address: "1200 Example Ave",
      contacts: [{ id: `contact_${projectId}`, name, email: contact.email, phone: contact.phone, primary: true }]
    }
  });
}

// ── Pure timing / parsing units ─────────────────────────────────────────────


test('staff booking validates authority, rechecks availability, and retries without duplication', async () => {
  const client = createSessionClient();
  const {orgId} = await registerOwner(client);
  const {saveBranchModule, upsertDocument, readDocument} = await import('../platform/storage.js');
  const {saveCapabilityValues} = await import('../platform/capabilities.js');
  await saveCapabilityValues(orgId, {'platform.scheduling':true,'scheduling.appointment_slots':true});
  await saveBranchModule(orgId, 'default', 'scheduling', {data:{
    self_service:{default_policy:{min_notice_minutes:0}},
    event_types:{sales_appointment:{duration_minutes:60,slot_minutes:30,assignment_policy:{allow_unassigned:true,rules:[]}}}
  }}, {replace:true});
  await createProject(orgId, 'booking_project', 'Customer', {email:'',phone:''});
  const day = new Date(Date.now()+48*3600000).toISOString().slice(0,10);
  const availability = await client.request('GET', `/v1/appointments/organizations/${orgId}/availability?project_id=booking_project&start_date=${day}&end_date=${day}`);
  const slot = availability.slots.find((row:any) => row.available);
  assert.ok(slot);
  const url = `/v1/appointments/organizations/${orgId}/book`;
  const body = {project_id:'booking_project',event_id:'appointment_0123456789abcdef',start_at:slot.start_at};
  const anonymous = await app.inject({method:'POST',url,payload:body});
  assert.equal(anonymous.statusCode,401);
  assert.equal((await client.raw('POST',url,body,true)).statusCode,403);
  assert.equal((await client.raw('POST',url,{...body,assigned_user_id:'arbitrary'})).statusCode,400);
  const booked = await client.request('POST',url,body);
  assert.equal(booked.event.start_at,slot.start_at);
  const again = await client.request('POST',url,body);
  assert.equal(again.event.id,booked.event.id);
  const stored = await readDocument(orgId,'projects','booking_project');
  assert.equal((stored.data.events as any[]).length,1);
  const invalid = await client.raw('POST',url,{...body,event_id:'appointment_1123456789abcdef',start_at:'2020-01-01T00:00:00.000Z'});
  assert.equal(invalid.statusCode,409);
  await upsertDocument(orgId,'projects',{id:'other_branch',data:{branch_id:'other',title:'Other'}});
  assert.equal((await client.raw('POST',url,{...body,project_id:'other_branch'})).statusCode,403);
  const next = await client.request('GET', `/v1/appointments/organizations/${orgId}/availability?start_date=${day}&end_date=${day}`);
  const free = next.slots.find((row:any) => row.available);
  assert.ok(free);
  const standaloneBody = {event_id:'appointment_standalone0123456789',start_at:free.start_at};
  const standalone = await client.request('POST',url,standaloneBody);
  assert.equal(standalone.event.start_at,free.start_at);
  assert.equal(standalone.event.project_id,undefined);
  assert.equal((await client.request('POST',url,standaloneBody)).event.id,standalone.event.id);
  const calendarDoc = await readDocument(orgId,'calendar_events',standalone.event.id);
  assert.equal(calendarDoc.data.branch_id,'default');
  const after = await client.request('GET', `/v1/appointments/organizations/${orgId}/availability?start_date=${day}&end_date=${day}`);
  assert.equal(after.slots.find((row:any)=>row.start_at===free.start_at)?.available,false);
  assert.equal((await client.raw('POST',url,{...standaloneBody,event_id:'appointment_conflicting0123456789'})).statusCode,409);
  await client.request('PATCH',`/v1/platform/organizations/${orgId}/calendar_events/${standalone.event.id}`,{data:{project_id:'booking_project'}});
  const linked = await readDocument(orgId,'calendar_events',standalone.event.id);
  assert.equal(linked.data.project_id,'booking_project');
  assert.equal(linked.data.start_at,free.start_at);
  await saveCapabilityValues(orgId, {'scheduling.appointment_slots':false});
  assert.equal((await client.raw('POST',url,body)).statusCode,403);
});

test('configured appointments preserve departments, delivery, staffing and recurring arrival windows',async()=>{
  const client=createSessionClient();const {orgId}=await registerOwner(client);
  const storage=await import('../platform/storage.js');
  const {saveCapabilityValues}=await import('../platform/capabilities.js');
  await saveCapabilityValues(orgId,{'platform.scheduling':true,'scheduling.appointment_slots':true});
  await storage.saveBranchModule(orgId,'default','scheduling',{data:{self_service:{default_policy:{min_notice_minutes:0}}}},{replace:true});
  await createProject(orgId,'configured_project','Configured',{email:'',phone:''});
  const base=`/v1/appointments/organizations/${orgId}`;
  const catalog=await client.request('GET',base+'/catalog');
  const person=catalog.resources.find((r:any)=>r.subject_type==='organization_user');assert.ok(person);
  catalog.catalog.departments.push({id:'consulting',label:'Consulting',subject_keys:[person.key],color:'#123456',group_id:'customer-services'});
  catalog.catalog.groups=[{id:'customer-services',label:'Customer services'}];
  const saved=await client.request('PUT',base+'/catalog',{catalog:catalog.catalog,revision:catalog.revision});
  assert.equal((await client.raw('PUT',base+'/catalog',{catalog:catalog.catalog,revision:catalog.revision})).statusCode,409);
  assert.equal(saved.catalog.departments.at(-1).label,'Consulting');
  const date=new Date(Date.now()+72*3600000).toISOString().slice(0,10);
  const configuration={title:'Joint consultation delivery',department_ids:['sales','consulting'],delivery:true,duration_minutes:60,window_minutes:240,slot_minutes:30,requirements:[{department_id:'consulting',subject_type:'organization_user',mode:'specific',subject_keys:[person.key]}],recurrence:{frequency:'weekly',interval:1,occurrence_count:2}};
  const preview=await client.request('POST',base+'/preview',{project_id:'configured_project',date,configuration});
  const slot=preview.slots.find((s:any)=>s.available);assert.ok(slot);
  assert.equal(Date.parse(slot.window_end_at)-Date.parse(slot.start_at),240*60000);
  const body={project_id:'configured_project',event_id:'appointment_configured0123456789',start_at:slot.start_at,configuration};
  const result=await client.request('POST',base+'/book',body);assert.ok(result.series);
  const again=await client.request('POST',base+'/book',body);assert.equal(again.series.id,result.series.id);
  const project=await storage.readDocument(orgId,'projects','configured_project');const events=project.data.events as any[];assert.equal(events.length,2);
  for(const event of events){assert.deepEqual(event.department_ids,['sales','consulting']);assert.equal(event.delivery,true);assert.equal(event.assigned_user_ids[0],person.id);assert.equal(Date.parse(event.end_at)-Date.parse(event.start_at),60*60000);assert.equal(Date.parse(event.arrival_window_end_at)-Date.parse(event.arrival_window_start_at),240*60000);}
  assert.notEqual(events[0].arrival_window_start_at,events[1].arrival_window_start_at);
  const singleConfig={title:'Uncategorized',department_ids:[],requirements:[],delivery:false};
  const single=await client.request('POST',base+'/preview',{project_id:'configured_project',date,configuration:singleConfig});
  const booked=await client.request('POST',base+'/book',{project_id:'configured_project',event_id:'appointment_single0123456789012',start_at:single.slots.find((s:any)=>s.available).start_at,configuration:singleConfig});
  assert.deepEqual(booked.event.department_ids,[]);
  assert.equal(booked.event.delivery,false);
  assert.equal(booked.event.event_type_default_id,'appointment');
});


test('Instant Full presets use day installations, quarterly maintenance and office meetings; days check every date',async()=>{
  const client=createSessionClient();const {orgId}=await registerOwner(client);
  const storage=await import('../platform/storage.js');
  const {instantFullAppointmentCatalog,seedInstantFullAppointmentCatalog}=await import('../appointments/defaults.js');
  const {saveCapabilityValues}=await import('../platform/capabilities.js');
  await saveCapabilityValues(orgId,{'platform.scheduling':true,'scheduling.appointment_slots':true});
  await storage.saveBranchModule(orgId,'default','scheduling',{data:{availability:{timezone:'America/New_York'},self_service:{default_policy:{min_notice_minutes:0}}}},{replace:true});
  await seedInstantFullAppointmentCatalog(orgId);await seedInstantFullAppointmentCatalog(orgId);
  const seeded=instantFullAppointmentCatalog();assert.equal(seeded.presets.length,7);
  assert.equal(seeded.presets.find(p=>p.id==='maintenance')?.configuration.recurrence?.frequency,'quarterly');
  assert.equal(seeded.presets.find(p=>p.id==='repair')?.configuration.recurrence,null);
  assert.equal(seeded.presets.find(p=>p.id==='sales')?.configuration.window_minutes,60);
  assert.equal(seeded.presets.find(p=>p.id==='delivery')?.configuration.delivery,true);
  await storage.upsertDocument(orgId,'branch',{id:'default',data:{contact:{business_address:{address1:'100 Office Lane',city:'Austin',state:'TX',postal_code:'78701'}}}});
  const base=`/v1/appointments/organizations/${orgId}`;
  const catalog=await client.request('GET',base+'/catalog');assert.match(catalog.company_office.address,/100 Office Lane/);
  const person=catalog.resources.find((r:any)=>r.subject_type==='organization_user');assert.ok(person);
  // Cross next year's spring DST transition: two local days are 47 elapsed hours.
  const year=new Date().getUTCFullYear()+1,firstSunday=1+(7-new Date(Date.UTC(year,2,1)).getUTCDay())%7,day=firstSunday+6;
  const date=`${year}-03-${String(day).padStart(2,'0')}`;
  const configuration={...seeded.presets.find(p=>p.id==='installation')!.configuration,requirements:[{subject_type:'organization_user',mode:'specific',subject_keys:[person.key]}]};
  const preview=await client.request('POST',base+'/preview',{date,configuration});assert.equal(preview.slots.length,1);assert.equal(preview.slots[0].available,true);
  assert.equal(Date.parse(preview.slots[0].plan.end_at)-Date.parse(preview.slots[0].plan.start_at),47*3600000);
  const result=await client.request('POST',base+'/book',{event_id:'appointment_installation123456789',start_at:preview.slots[0].start_at,configuration});assert.equal(result.event.all_day,true);assert.equal(result.event.duration_minutes,2880);
  const busy=await client.request('POST',base+'/preview',{date,configuration});assert.equal(busy.slots[0].available,false);
  const secondDay=`${year}-03-${String(day+1).padStart(2,'0')}`;
  const meetings=await client.request('POST',base+'/preview',{date:secondDay,configuration:seeded.presets.find(p=>p.id==='company-meeting')!.configuration});assert.ok(meetings.slots.every((s:any)=>!s.available));
  const nextDate=`${year}-03-${String(day+3).padStart(2,'0')}`,meeting=seeded.presets.find(p=>p.id==='company-meeting')!.configuration;
  const free=await client.request('POST',base+'/preview',{date:nextDate,configuration:meeting});
  await storage.upsertDocument(orgId,'branch',{id:'default',data:{contact:{address:'200 New Office Road'}}});
  const booked=await client.request('POST',base+'/book',{event_id:'appointment_officemeeting123456',start_at:free.slots.find((s:any)=>s.available).start_at,configuration:meeting});
  assert.equal(booked.event.location.mode,'company_office');assert.equal(booked.event.address,'200 New Office Road');assert.ok(booked.event.assigned_user_ids.includes(person.id));
  const blocked=await client.request('POST',base+'/preview',{date:nextDate,configuration:{...meeting,location:{mode:'none'}}});assert.equal(blocked.slots.find((s:any)=>s.start_at===booked.event.start_at)?.available,false);
});
