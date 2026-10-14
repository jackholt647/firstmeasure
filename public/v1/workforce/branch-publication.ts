import {zodToJsonSchema} from 'zod-to-json-schema';
import {registerAction} from '../platform/publication/actions.js';
import type {JsonSchema,PublicationContext} from '../platform/publication/contracts.js';
import {backendImplementationDigest} from '../platform/publication/implementation.js';
import {registerDataProvider} from '../platform/publication/providers.js';
import {forbidden} from '../platform/errors.js';
import type {PlatformAuthContext} from '../platform/auth.js';
import {BRANCH_FEATURE} from './branch-scope.js';
import {addBranch,archiveBranch,branchAddSchema,branchArchiveSchema,branchRegionSetSchema,branchRenameSchema,membershipSetSchema,readBranchStructure,regionSaveSchema,renameBranch,saveRegion,setAssigneeBranches,setBranchRegion} from './branches.js';

/**
 * What branches publish. See docs/architecture/branches.md for the contract the People screens use.
 * `organization-branches.structure` is readable by any member (they always may know their own branch); the actions
 * need the multiple-branches feature, and each checks company settings and branch reach itself.
 */
type Obj=Record<string,unknown>;
const strings={type:'array',items:{type:'string'}};
const counts={type:'object',required:['users','groups','companies','departments'],properties:{users:{type:'integer'},groups:{type:'integer'},companies:{type:'integer'},departments:{type:'integer'}},additionalProperties:false};
const branchRow={type:'object',required:['id','name','status','is_default','is_mine','region_id','counts','can_manage'],properties:{id:{type:'string'},name:{type:'string'},status:{enum:['active','archived']},is_default:{type:'boolean'},is_mine:{type:'boolean'},region_id:{type:'string'},counts,can_manage:{type:'boolean'}},additionalProperties:false};
const regionRow={type:'object',required:['id','label','status','branch_ids','is_mine'],properties:{id:{type:'string'},label:{type:'string'},status:{enum:['active','archived']},branch_ids:strings,is_mine:{type:'boolean'}},additionalProperties:false};
const reach={enum:['own','region','all']};
export const branchStructureSchema:JsonSchema={
  type:'object',
  required:['feature_enabled','multiple','default_branch_id','my_branch_id','my_branch_ids','my_region_ids','branches','regions','companies_in_every_branch','access','catalog_revision','revision'],
  properties:{
    feature_enabled:{type:'boolean'},multiple:{type:'boolean'},default_branch_id:{type:'string'},my_branch_id:{type:'string'},my_branch_ids:strings,my_region_ids:strings,
    branches:{type:'array',items:branchRow},regions:{type:'array',items:regionRow},companies_in_every_branch:{type:'integer'},
    access:{type:'object',required:['see','manage','restricted','visible_branch_ids','manageable_branch_ids','can_add_branch','can_archive_branch','can_manage_regions','can_rename_branch_ids','can_set_membership'],properties:{
      see:reach,manage:reach,restricted:{type:'boolean'},visible_branch_ids:strings,manageable_branch_ids:strings,can_add_branch:{type:'boolean'},can_archive_branch:{type:'boolean'},can_manage_regions:{type:'boolean'},can_rename_branch_ids:strings,can_set_membership:{type:'boolean'}
    },additionalProperties:false},
    catalog_revision:{type:'integer'},region_id:{type:'string'},revision:{type:'string'}
  },
  additionalProperties:false
};
const membershipResult={type:'object',required:['assignee','branch_ids','primary_branch_id'],properties:{assignee:{type:'string'},branch_ids:strings,primary_branch_id:{type:'string'}},additionalProperties:false};
const args=(schema:Parameters<typeof zodToJsonSchema>[0])=>zodToJsonSchema(schema,{$refStrategy:'none'}) as Obj;
const person=(ctx:PublicationContext):PlatformAuthContext=>{if(!ctx.auth)throw forbidden('branch_structure_denied','A signed-in person is required.');return ctx.auth;};

let registered=false;
export function registerBranchPublication(){
  if(registered)return;
  registered=true;
  registerDataProvider({id:'organization-branches',version:'1',apps:['settings','scheduling','crew','sales','payroll'],exports:{structure:{
    description:'The organization\'s branches and regions as the viewer may see them: each branch with its name (empty for an unnamed default branch), region, member counts and whether it is the viewer\'s own; each region with its branches; which branch is the viewer\'s; and what the viewer may see and do (`access`). `multiple` is false for an organization with one branch or without the multiple-branches feature: then nothing about branches is shown.',
    schema:branchStructureSchema,schemaVersion:'1',
    access:{scopes:['organization'],permissions:[],systemKinds:['module','work','agent'],authorize:ctx=>{person(ctx);}},
    read:async ctx=>{const value=await readBranchStructure(person(ctx));return {value,revision:value.revision};}
  }}});
  const write={effect:'write' as const,executionKinds:['api','module','agent','work'] as const,idempotency:'required' as const,version:'1',domain:'workforce',implementation:backendImplementationDigest()};
  const structure={scopes:['organization'] as const,permissions:['manage_company_settings'],capabilities:[BRANCH_FEATURE]};
  const output=branchStructureSchema as Obj;
  registerAction({...write,id:'organization-branches.branch.add',description:'add a branch, optionally in a region. Needs company settings and permission to manage every branch.',inputSchema:args(branchAddSchema),outputSchema:output,policy:structure,execute:(ctx,_t,input)=>addBranch(person(ctx),input)});
  registerAction({...write,id:'organization-branches.branch.rename',description:'rename a branch the caller manages. Only the default branch may be left without a name.',inputSchema:args(branchRenameSchema),outputSchema:output,policy:structure,execute:(ctx,_t,input)=>renameBranch(person(ctx),input)});
  registerAction({...write,id:'organization-branches.branch.archive',description:'archive a branch, or restore it with `archived: false`. The default branch, and a branch that is the only branch of a person or group or still has departments, cannot be archived.',inputSchema:args(branchArchiveSchema),outputSchema:output,policy:structure,execute:(ctx,_t,input)=>archiveBranch(person(ctx),input)});
  registerAction({...write,id:'organization-branches.region.save',description:'add a region (no `id`), or rename or archive one. Regions are flat and only group branches. Archiving one leaves its branches in no region.',inputSchema:args(regionSaveSchema),outputSchema:output,policy:structure,execute:(ctx,_t,input)=>saveRegion(person(ctx),input)});
  registerAction({...write,id:'organization-branches.branch.region.set',description:'put a branch in a region, or in none with `region_id: ""`. A branch is in at most one region.',inputSchema:args(branchRegionSetSchema),outputSchema:output,policy:structure,execute:(ctx,_t,input)=>setBranchRegion(person(ctx),input)});
  registerAction({...write,id:'organization-branches.membership.set',description:'set the branches a person, group or outside company belongs to. A person or group needs at least one; `primary_branch_id` becomes their own branch. A company with no branches works in every branch. Needs manage_company_users for a person and company settings for a group or company, and every branch added or removed must be one the caller manages.',inputSchema:args(membershipSetSchema),outputSchema:membershipResult as Obj,policy:{scopes:['organization'] as const,permissions:[],capabilities:[BRANCH_FEATURE]},execute:(ctx,_t,input)=>setAssigneeBranches(person(ctx),input)});
}
