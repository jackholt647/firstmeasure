import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../firstmeasure/storage.ts', import.meta.url), 'utf8');
function section(start,end) { return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))); }
const selected = section('export async function saveArtifact(', 'export async function readArtifact(')
  + section('export async function refreshArtifactFlags(', 'async function backupManifestIfPresent(');
const script = ts.transpileModule(selected.replace(/^export /gm,'').replace('import("./project_index_postgres.js")','Promise.resolve(postgresIndex)'), {
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}
}).outputText;
function setup({spaces=true, listingError=null}={}) {
  let held=false;
  const state={existenceReads:0,listFiles:0,listSpaces:0,mirrors:0,committed:false};
  const manifest={id:'synthetic',artifacts:{has_report_pdf:true,has_main_pdf:true,has_google_image:true,has_renderable_image:true}};
  const names=['Report.pdf','google.png','pdf_state.json'];
  const listing=()=>{if(listingError)throw listingError;return names.map(name=>({name}));};
  const context=vm.createContext({
    console, Promise,
    FIRSTMEASURE_FILE_NAMES:{pdfState:'pdf_state.json',xmlStored:'model.xml'},
    PDF_FILE_NAMES:{main:'Report.pdf',summary:'Summary.pdf'},
    asRecord:value=>value&&typeof value==='object'?value:{},
    isSpacesArtifactStorageEnabled:()=>spaces,
    isFirstMeasurePostgresEnabled:()=>true,
    assertProjectExists:async()=>{assert.equal(held,false,'nested database existence read');state.existenceReads++;},
    sanitizeFileName:name=>name,
    projectArtifactReference:(id,name)=>`spaces/${id}/${name}`,
    projectDir:id=>`/synthetic/${id}`,
    putProjectArtifact:async()=>{assert.equal(held,false);},
    listProjectArtifacts:async()=>{state.listSpaces++;return listing();},
    listProjectFiles:async()=>{state.listFiles++;assert.equal(held,false,'redundant pooled existence read while row locked');return listing();},
    writeProjectManifestMirror:async()=>{assert.equal(held,false);state.mirrors++;},
    postgresIndex:{mutatePostgresManifest:async(id,mutate)=>{assert.equal(held,false);held=true;try{const result=await mutate(manifest);state.committed=true;return result;}finally{held=false;}}},
    notFound:(code,message)=>Object.assign(new Error(message),{code})
  });
  vm.runInContext(script,context);
  return {state,manifest,context};
}

test('Spaces artifact save uses the existing row lock without another database lookup',async()=>{
  const {state,manifest,context}=setup();
  const result=await context.saveArtifact('synthetic','Report.pdf',new Uint8Array([37,80,68,70]));
  assert.equal(result.name,'Report.pdf');
  assert.equal(state.existenceReads,1,'the pre-write project guard is still required');
  assert.equal(state.listFiles,0,'Spaces refresh must not re-enter generic existence guard');
  assert.equal(state.listSpaces,1);
  assert.equal(state.committed,true);assert.equal(state.mirrors,1);
  assert.equal(manifest.artifacts.has_report_pdf,true);assert.equal(manifest.artifacts.has_google_image,true);
});

test('failed Spaces listing fails the mutation and does not clear known artifact flags',async()=>{
  const {state,manifest,context}=setup({listingError:new Error('synthetic storage timeout')});
  await assert.rejects(context.saveArtifact('synthetic','Report.pdf',new Uint8Array([1])),/synthetic storage timeout/);
  assert.equal(state.committed,false);assert.equal(state.mirrors,0);
  assert.equal(manifest.artifacts.has_report_pdf,true);assert.equal(manifest.artifacts.has_google_image,true);
});

test('filesystem refresh still uses file listing and does not turn listing failures into empty results',async()=>{
  const healthy=setup({spaces:false});
  await healthy.context.refreshArtifactFlags('synthetic',healthy.manifest);
  assert.equal(healthy.state.listFiles,1);assert.equal(healthy.state.listSpaces,0);
  assert.equal(healthy.manifest.artifacts.has_report_pdf,true);
  assert.equal(healthy.manifest.artifacts.has_summary_pdf,false,'successful listing can clear absent artifacts');
  const broken=setup({spaces:false,listingError:new Error('synthetic disk error')});
  await assert.rejects(broken.context.refreshArtifactFlags('synthetic',broken.manifest),/synthetic disk error/);
  assert.equal(broken.manifest.artifacts.has_report_pdf,true);assert.equal(broken.manifest.artifacts.has_google_image,true);
});
