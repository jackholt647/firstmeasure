import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("report preferences are opt-in, validated and frozen on orders", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "report-localization-"));
  Object.assign(process.env, { FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "sqlite",
    FIRSTMEASURE_STORAGE_ROOT: path.join(root,"fm"), FIRSTMEASURE_INDEX_DB_PATH: path.join(root,"index.sqlite"),
    PLATFORM_STORAGE_ROOT: path.join(root,"platform"), INTERNAL_STORAGE_ROOT: path.join(root,"internal"),
    FIRSTMEASURE_JOB_WORKERS: "0", PLATFORM_HEARTBEAT_DISABLED: "1" });
  const platform = await import("../platform/storage.js");
  const prefs = await import("../firstmeasure/report_preferences.js");
  const storage = await import("../firstmeasure/storage.js");
  const { createProjectSchema } = await import("../firstmeasure/schemas.js");
  const { effectiveAppFlags } = await import("../platform/app_flags.js");
  const org = await platform.createOrganization({ name:"Localization fixture" });
  const input = { address:"10 Test Road", organization_ref:{id:org.id} };
  const us = { measurement_system:"imperial", report_language:"en-US" };
  const gb = { measurement_system:"metric", report_language:"en-GB" };
  try {
    const defaults = await effectiveAppFlags(org.id);
    assert.ok(defaults);
    await platform.upsertDocument(org.id,"branch",{id:"default",data:{report_preferences:gb}});
    assert.deepEqual(await prefs.resolveOrderReportPreferences({...input,...gb}),us,"disabled organizations cannot opt themselves in");
    const legacy = await storage.createProject(input);
    assert.equal(legacy.manifest.measurement_system,"imperial");
    assert.equal(legacy.manifest.report_language,"en-US");
    await platform.saveGlobal(org.id,{data:{app_flags:{firstmeasure:{metric_measurements:true}}}});
    assert.deepEqual(await prefs.resolveOrderReportPreferences(input),{...us,measurement_system:"metric"});
    await platform.saveGlobal(org.id,{data:{app_flags:{firstmeasure:{metric_measurements:false,report_localization:true}}}});
    const localized = await storage.createProject(input);
    assert.equal(localized.manifest.measurement_system,"metric");
    assert.equal(localized.manifest.report_language,"en-GB");
    assert.deepEqual(await prefs.resolveOrderReportPreferences({...input,...us}),us,"explicit order choice overrides branch defaults");
    await platform.upsertDocument(org.id,"branch",{id:"second",data:{report_preferences:{...gb,measurement_system:"imperial"}}});
    assert.deepEqual(await prefs.resolveOrderReportPreferences({...input,branch_id:"second"}),{...gb,measurement_system:"imperial"});
    await platform.upsertDocument(org.id,"branch",{id:"default",data:{report_preferences:us}});
    await platform.saveGlobal(org.id,{data:{app_flags:{firstmeasure:{report_localization:false}}}});
    const saved = await storage.readManifest(localized.manifest.id);
    assert.equal(saved.measurement_system,"metric");
    assert.equal(saved.report_language,"en-GB");
    assert.deepEqual(await prefs.resolveOrderReportPreferences(input),us);
    assert.throws(()=>createProjectSchema.parse({...input,measurement_system:"yards"}));
    assert.throws(()=>createProjectSchema.parse({...input,report_language:"fr"}));
    await assert.rejects(storage.patchManifest(saved.id,{report_language:"invalid"}));
    assert.deepEqual(prefs.normalizeReportPreferences({}),us);
  } finally {
    await (await import("../firstmeasure/project_index.js")).closeFirstMeasureProjectIndex();
  }
});
