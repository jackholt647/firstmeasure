import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../measure/internal/portal_scripts/projects.js", import.meta.url), "utf8");
const method = source.slice(source.indexOf("    async wireQaReservation("), source.indexOf("    populateReserveSelect("));
const escapeHtml = (value: unknown) => String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;");

async function fixture(options: { selected?: string; usersDenied?: boolean; sessionDenied?: boolean; saveDenied?: boolean } = {}) {
  const select = { value:"", disabled:true, innerHTML:"", insertAdjacentHTML(_where:string, html:string) { this.innerHTML += html; } };
  const button: {disabled:boolean; onclick?:()=>Promise<void>} = {disabled:true};
  const note = {textContent:""};
  const fetches: Array<{url:string; options:any}> = [];
  let invalidations=0;
  const opened: string[]=[];
  const calls: string[]=[];
  const context = vm.createContext({
    document:{getElementById:(id:string)=>({pmQaReserveSelect:select,pmQaReserveSave:button,pmQaReserveNote:note})[id]},
    Portal:{escapeHtml}, queueOverviewStore:{invalidate(){invalidations++;}},
    fetch:async(url:string, request:any)=>{
      fetches.push({url,options:request});
      if(url.endsWith("/auth/session"))return {ok:!options.sessionDenied,json:async()=>options.sessionDenied?{authenticated:false}:{csrf_token:"config-independent-token"}};
      return {ok:!options.saveDenied,json:async()=>options.saveDenied?{success:false,message:"Manager permission required"}:{success:true}};
    }
  });
  const panel = vm.runInContext("({"+method+"})",context);
  panel.fmUrl=(path:string)=>"/v1/firstmeasure/"+path;
  panel.fmPost=async(path:string)=>{calls.push(path);return options.usersDenied?{success:false,message:"Manager permission required"}:{success:true,users:[{email:"qa@example.test",name:'QA <name>'}]};};
  panel.openProjectModal=async(id:string)=>{opened.push(id);};
  await panel.wireQaReservation("project/encoded", options.selected??"qa@example.test");
  return {select,button,note,fetches,opened,calls,invalidations:()=>invalidations};
}

test("QA reservation loads eligible users and retains current selection",async()=>{
  const f=await fixture();
  assert.deepEqual(f.calls,["qa/reservation/users"]);
  assert.equal(f.select.value,"qa@example.test");
  assert.match(f.select.innerHTML,/QA &lt;name>/);
  assert.equal(f.button.disabled,false);
  assert.equal(f.select.disabled,false);
  assert.equal(f.fetches.length,0);
  const unavailable=await fixture({selected:"former@example.test"});
  assert.equal(unavailable.select.value,"former@example.test");
  assert.match(unavailable.select.innerHTML,/unavailable — clear or reassign/);
});

for(const clear of [false,true]){
  test(clear?"clear reservation submits null":"save reservation uses session CSRF and correct project/reviewer",async()=>{
    const f=await fixture();
    if(clear)f.select.value="";
    await f.button.onclick!();
    assert.equal(f.fetches[0]!.url,"/v1/platform/auth/session");
    assert.equal(f.fetches[0]!.options.credentials,"include");
    const request=f.fetches[1]!;
    assert.equal(request.url,"/v1/firstmeasure/projects/project%2Fencoded/qa/reservation");
    assert.equal(request.options.method,"POST");
    assert.equal(request.options.credentials,"include");
    assert.equal(request.options.headers["X-Platform-CSRF"],"config-independent-token");
    assert.deepEqual(JSON.parse(request.options.body),{reserved_for:clear?null:{email:"qa@example.test"}});
    assert.deepEqual(f.opened,["project/encoded"]);
    assert.equal(f.invalidations(),1);
    assert.equal(f.button.disabled,false);
    assert.equal(f.select.disabled,false);
  });
}

test("permission denial while loading users leaves actions disabled and makes no mutation",async()=>{
  const f=await fixture({usersDenied:true});
  assert.equal(f.note.textContent,"Manager permission required");
  assert.equal(f.button.disabled,true);
  assert.equal(f.select.disabled,true);
  assert.equal(f.button.onclick,undefined);
  assert.equal(f.fetches.length,0);
  assert.equal(f.invalidations(),0);
});

test("expired session does not submit a reservation",async()=>{
  const f=await fixture({sessionDenied:true});
  await f.button.onclick!();
  assert.equal(f.fetches.length,1);
  assert.match(f.note.textContent,/Sign in again/);
  assert.equal(f.invalidations(),0);
  assert.deepEqual(f.opened,[]);
});

test("server rejection is shown and does not refresh as successful",async()=>{
  const f=await fixture({saveDenied:true});
  await f.button.onclick!();
  assert.equal(f.note.textContent,"Manager permission required");
  assert.equal(f.invalidations(),0);
  assert.deepEqual(f.opened,[]);
});
