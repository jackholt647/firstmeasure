const root='../public/measure/internal/editor_scripts/';
const G=require(root+'wall_geometry'),B=require(root+'base_geometry'),D=require(root+'wall_gaps'),R=require(root+'wall_rake_cleanup'),C=require(root+'wall_chimneys'),A=require(root+'wall_chimney_cleanup');
function build(fixture,soffit=24){
 const state=structuredClone(fixture);state.options={...state.options,soffit,defaultSoffitInches:24,roofContacts:true};state.wallEdits={};
 state.sources=G.buildSources(state.roof,state.options).sources;
 const run=ground=>{const extruded=G.extrude(state.roof,state.sources,B.usesRoofEnvelope(state.base,state.ground)?state.ground:ground),dedup=G.deduplicate(extruded.walls,state.options.tolerance);if(state.base)dedup.walls=B.reconcileRoofWalls(dedup.walls,state.roof,state.sources,state.base,state.ground);const gaps=D.repair(dedup.walls,ground,{sliverWidth:Math.min(.25,Math.max(.03,2*(state.context?.mpp||.1)))}),merged=G.mergeCoplanar(gaps.walls),clean=R.cleanup(merged.walls,state.sources,ground);return {extruded,dedup,gaps,merged,clean};};
 const pre=run(state.ground);state.chimneys=fixture.chimneys?structuredClone(fixture.chimneys):C.detect(state.roof);
 state.base=B.fromRoof(state.roof,state.ground,pre.clean.walls,(soffit==='auto'?24:soffit)*G.INCH,state.chimneys,state.sources);C.syncFoundation(state);C.syncVolumes(state);
 const stages=run(B.terrain(state.base));state.base=R.foundation(state.base,stages.clean.report);
 const aligned=A.cleanup(stages.clean.walls,state.sources,C.definitions(state),B.terrain(state.base));state.base=A.foundation(state.base,aligned.report);
 const composed=A.compose(C.compose(aligned.walls,state),aligned.report);
 return {state,pre,...stages,aligned,composed,open:D.detect(composed,state.ground)};
}
module.exports={build};
