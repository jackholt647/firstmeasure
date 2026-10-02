import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const app=readFileSync(new URL('../../libraries/apps/project-request/app.js',import.meta.url),'utf8');
test('saved report draft selects ordering only for an explicit report entry',()=>{
 const start=app.indexOf('  function hydrateFromBaseProject('),end=app.indexOf(';',app.indexOf('    reportSelection =',start))+1;
 const prefix=app.slice(start,end);
 assert.ok(end>start);
 const context={projectFormHydrating:0,loadProjectWorkPlans:async()=>{},isUnfinishedReportDraft:()=>true,projectHasReportOrder:()=>false,mobileTypeTransitionTimer:null,reportSelection:null,requestedWorkflow:'project'};
 vm.createContext(context);
 // Execute the actual hydration setup, stopping before unrelated form rendering.
 const assignmentEnd=prefix.indexOf(';',prefix.indexOf('    reportSelection ='))+1;
 vm.runInContext(prefix.slice(0,assignmentEnd)+'\n}finally{projectFormHydrating--;} }',context);
 const draft={id:'draft',address:'123 Main',workflow_intent:'report',report_selection:'roof'};
 context.hydrateFromBaseProject(draft,{deferRemoteContent:true});
 assert.equal(context.reportSelection,null);
 context.requestedWorkflow='report';context.hydrateFromBaseProject(draft,{deferRemoteContent:true});
 assert.equal(context.reportSelection,'roof');
 context.requestedWorkflow='project';context.reportSelection=null;context.hydrateFromBaseProject(draft,{deferRemoteContent:true});
 assert.equal(context.reportSelection,null);
});
test('remote draft hydration preserves ordinary open intent but honors explicit report entry',()=>{
 const start=app.indexOf('  function hydrateOpenProjectContent('),end=app.indexOf('\n  }',start)+4;
 const context={projectOpenGeneration:1,projectShellLoading:false,activePreviewTab:'overview',requestedWorkflow:'project',isUnfinishedReportDraft:()=>true,$:()=>({classList:{contains:()=>true}}),activeModalMatchesProject:()=>true,ensureOverviewDetails:()=>{},hydrateFromBaseProject:()=>{},applyReorderPrefillState:()=>{},setProjectShellLoading:()=>{},setActivePreviewTab:()=>{},renderContactContextBar:()=>{},syncProjectViewerTabs:()=>{},renderWorkflowState:()=>{},mountOverviewDetails:()=>{},mountProjectModalApps:()=>{},syncProjectModalAppActivation:()=>{},syncActiveProjectRoute:()=>{},projectOpenId:p=>p.id,window:{dispatchEvent:()=>{}},CustomEvent:class{},restoreProjectNoteRoute:()=>{}};
 vm.createContext(context);vm.runInContext(app.slice(start,end),context);
 assert.equal(context.hydrateOpenProjectContent({id:'draft',workflow_intent:'report'},{fromRoute:true},1,'draft'),true);
 assert.equal(context.requestedWorkflow,'project');
 context.hydrateOpenProjectContent({id:'draft'},{workflow:'report'},1,'draft');
 assert.equal(context.requestedWorkflow,'report');
});

