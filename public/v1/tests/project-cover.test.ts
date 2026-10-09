import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeDefinitions, validateField } from "../custom_fields/contracts.js";

test("cover is a built-in single photo reference; other photo fields may be multiple", () => {
  const cover = normalizeDefinitions([{entity:"project",path:"cover_photo",type:"photo"}])[0]!;
  validateField(cover,{media_id:"photo"});
  validateField(cover,null);
  assert.throws(()=>validateField(cover,[{media_id:"photo"}]));
  for(const change of [{type:"text"},{cardinality:"many"},{enabled:false}]) assert.throws(()=>normalizeDefinitions([{...cover,...change}]));
  validateField({path:"reference_photos",type:"photo",cardinality:"many"},[{media_id:"a"},{media_id:"b"}]);
});

test("project photo fields validate ownership, media type, replacement, clearing and trash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"project-cover-"));
  process.env.PLATFORM_STORAGE_ROOT=root;
  if (process.env.TEST_POSTGRES_URL) Object.assign(process.env,{FIRSTMATE_ENV:"test",FIRSTMEASURE_DATABASE_MODE:"postgres",DATABASE_URL:process.env.TEST_POSTGRES_URL,POSTGRES_POOL_MAX:"1",POSTGRES_AUTO_MIGRATE:"false",FIRSTMEASURE_ARTIFACT_STORAGE:"local"});
  const storage = await import("../platform/storage.js");
  const fields = await import("../custom_fields/records.js");
  const org="cover_test";
  try {
    await storage.createOrganization({id:org,name:"Cover test"});
    await storage.saveBranchModule(org,"default","custom_fields",{data:{fields:[{entity:"project",path:"detail_photo",type:"photo"}]}},{replace:true});
    const stored=(await storage.readBranchModule(org,"default","custom_fields")).data.fields as any[];
    assert.equal(stored.find(f=>f.path==="cover_photo").type,"photo");
    for(const [id,owner,type] of [["a","project","image/jpeg"],["b","project","image/png"],["foreign","other","image/jpeg"],["video","project","video/mp4"]]) {
      const dir=path.join(root,"organizations",org,"media",id!);
      await mkdir(dir,{recursive:true});
      await writeFile(path.join(dir,"metadata.json"),JSON.stringify({id,owner:{type:"project",id:owner},content_type:type}));
    }
    const photos=[{id:"a"},{id:"b"},{id:"video"}];
    let saved=await storage.upsertDocument(org,"projects",{id:"project",data:{photos,custom_field_values:{cover_photo:{media_id:"a"},detail_photo:{media_id:"b"},legacy:"keep"}}});
    const defs=await fields.definitions(org,"default","project",saved.data);
    assert.equal(defs.find(f=>f.path==="cover_photo")?.cardinality,"one");
    for(const id of ["foreign","video","missing"]) await assert.rejects(()=>storage.upsertDocument(org,"projects",{id:"project",data:{custom_field_values:{cover_photo:{media_id:id}}}}));
    const {systemPublicationContext}=await import("../platform/publication/context.js");
    const ctx=systemPublicationContext({kind:"module",organizationId:org,operations:["custom-fields.project.write"],mode:"command"});
    const target={scope:"project" as const,organizationId:org,projectId:"project"};
    await fields.writeFields(ctx,target,"project",{values:{cover_photo:{media_id:"b"}},expectedRevision:saved.revision});
    await assert.rejects(()=>fields.writeFields(ctx,target,"project",{values:{cover_photo:{media_id:"a"}},expectedRevision:saved.revision}));
    saved=await storage.readDocument(org,"projects","project");
    assert.deepEqual((saved.data.custom_field_values as any).cover_photo,{media_id:"b"});
    assert.equal((saved.data.custom_field_values as any).legacy,"keep");
    saved=await storage.upsertDocument(org,"projects",{id:"project",data:{photos:[{id:"a"},{id:"b",in_trash:true}]}});
    assert.equal((saved.data.custom_field_values as any).cover_photo,null);
    await assert.rejects(()=>storage.upsertDocument(org,"projects",{id:"project",data:{custom_field_values:{detail_photo:{media_id:"b"},cover_photo:{media_id:"b"}}}}));
    saved=await storage.upsertDocument(org,"projects",{id:"project",data:{custom_field_values:{cover_photo:{media_id:"a"}}}});
    saved=await storage.upsertDocument(org,"projects",{id:"project",data:{photos:[]}});
    assert.equal((saved.data.custom_fields as any).cover_photo,null);
  } finally {await rm(root,{recursive:true,force:true});}
});
