import {randomBytes,createHash} from 'node:crypto';
import {z} from 'zod';
import {hasPermission,type PlatformAuthContext} from '../platform/auth.js';
import {badRequest,conflict,forbidden,notFound} from '../platform/errors.js';
import {readDocument,upsertDocument} from '../platform/storage.js';
import {DEFAULT_BRANCH_ID,type DepartmentCatalog} from './department-contracts.js';
import {readOrganizationDepartments} from './departments.js';
import {resolveOrganizationStructure,type OrganizationStructure} from './organization-structure.js';
import {assertBranchChange,branchScope,canManageBranches,canSeeBranches,multipleBranchesEnabled,userBranchIds,type BranchScope} from './branch-scope.js';

/**
 * Branches and regions: the organization's structure above departments. See docs/architecture/branches.md.
 *
 * A branch is a `branch` document (the organization's settings scope); `default` always exists and needs no name. A
 * region is a flat entry in the department catalog's `regions` that lists its branches; a branch is in at most one.
 * Everything here is behind the `platform.multiple_branches` feature. The structure read works without it and says
 * the feature is off, so a screen can tell there is nothing to show.
 */
const id=z.string().trim().min(1).max(120);
const name=z.string().trim().max(100);
export const branchAddSchema=z.object({name:name.min(1),region_id:id.optional()}).strict();
export const branchRenameSchema=z.object({branch_id:id,name}).strict();
export const branchArchiveSchema=z.object({branch_id:id,archived:z.boolean().default(true)}).strict();
export const regionSaveSchema=z.object({id:id.optional(),label:z.string().trim().min(1).max(100),status:z.enum(['active','archived']).optional(),expected_revision:z.number().int().nonnegative().optional()}).strict();
export const branchRegionSetSchema=z.object({branch_id:id,region_id:z.string().trim().max(120),expected_revision:z.number().int().nonnegative().optional()}).strict();
const assigneeRef=z.object({type:z.enum(['organization_user','resource_group','organization_connection']),id}).strict();
export const membershipSetSchema=z.object({assignee:z.union([assigneeRef,z.string().trim().regex(/^(organization_user|resource_group|organization_connection):.+$/)]),branch_ids:z.array(id).max(200),primary_branch_id:id.optional()}).strict();

const text=(value:unknown)=>String(value??'').trim();
const unique=(values:unknown[])=>[...new Set(values.map(text).filter(Boolean))];
const hash=(value:unknown)=>`sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

function requireFeature(ctx:PlatformAuthContext){
  if(!multipleBranchesEnabled(ctx))throw forbidden('multiple_branches_disabled','Multiple branches are not turned on for this organization.');
}
/** Adding or archiving a branch and changing regions is organization administration over every branch. */
function requireStructureAdministration(ctx:PlatformAuthContext,scope=branchScope(ctx)){
  requireFeature(ctx);
  if(!hasPermission(ctx,'manage_company_settings')||scope.manage!=='all')throw forbidden('branch_structure_denied','Managing branches and regions needs company settings and permission to manage every branch.');
}
async function freshScope(ctx:PlatformAuthContext){
  const structure=await resolveOrganizationStructure(ctx.orgId);
  return {structure,scope:branchScope({...ctx,organizationStructure:structure})};
}

export type BranchRow={id:string;name:string;status:'active'|'archived';is_default:boolean;is_mine:boolean;region_id:string;counts:{users:number;groups:number;companies:number;departments:number};can_manage:boolean};
export type RegionRow={id:string;label:string;status:'active'|'archived';branch_ids:string[];is_mine:boolean};

function branchCounts(structure:OrganizationStructure,branchId:string){
  return {
    users:structure.users.filter(u=>u.branch_ids.includes(branchId)).length,
    groups:structure.groups.filter(g=>g.branch_ids.includes(branchId)).length,
    companies:structure.connections.filter(c=>c.branch_ids.includes(branchId)).length,
    departments:structure.catalog.departments.filter(d=>d.status==='active'&&d.branch_id===branchId).length
  };
}

/** The structure a viewer may see, and what they may do with it. Reads only. */
export async function readBranchStructure(ctx:PlatformAuthContext){
  const {structure,scope}=await freshScope(ctx);
  const catalog=structure.catalog as DepartmentCatalog&{revision?:number};
  const settings=hasPermission(ctx,'manage_company_settings');
  const administer=scope.enabled&&settings&&scope.manage==='all';
  const regionOf=(branchId:string)=>catalog.regions.find(r=>r.status==='active'&&r.branch_ids.includes(branchId))?.id||'';
  const branches:BranchRow[]=structure.branches.filter(b=>canSeeBranches(scope,[b.id])).map(b=>({
    id:b.id,name:b.name,status:b.status,is_default:b.is_default,is_mine:scope.own_branch_ids.includes(b.id),region_id:regionOf(b.id),
    counts:branchCounts(structure,b.id),can_manage:scope.enabled&&settings&&canManageBranches(scope,[b.id])
  }));
  const visible=new Set(branches.map(b=>b.id));
  const regions:RegionRow[]=catalog.regions.map(r=>({id:r.id,label:r.label,status:r.status,branch_ids:r.branch_ids.filter(id=>visible.has(id)),is_mine:scope.my_region_ids.includes(r.id)}))
    .filter(r=>!scope.restricted_view||r.branch_ids.length);
  const value={
    feature_enabled:scope.enabled,
    multiple:scope.multiple,
    default_branch_id:DEFAULT_BRANCH_ID,
    my_branch_id:scope.my_branch_id,
    my_branch_ids:scope.own_branch_ids,
    my_region_ids:scope.my_region_ids,
    branches,
    regions,
    companies_in_every_branch:structure.connections.filter(c=>!c.branch_ids.length).length,
    access:{
      see:scope.see,manage:scope.manage,restricted:scope.restricted_view,
      visible_branch_ids:scope.visible_branch_ids.filter(id=>visible.has(id)),
      manageable_branch_ids:scope.manageable_branch_ids.filter(id=>visible.has(id)),
      can_add_branch:administer,can_archive_branch:administer,can_manage_regions:administer,
      can_rename_branch_ids:branches.filter(b=>b.can_manage).map(b=>b.id),
      can_set_membership:scope.enabled&&(hasPermission(ctx,'manage_company_users')||settings)
    },
    catalog_revision:Number(catalog.revision||0)
  };
  return {...value,revision:hash(value)};
}

async function writeRegions(ctx:PlatformAuthContext,expectedRevision:number|undefined,change:(regions:DepartmentCatalog['regions'])=>DepartmentCatalog['regions']){
  const current=await readOrganizationDepartments(ctx.orgId);
  if(expectedRevision!==undefined&&expectedRevision!==current.revision)throw conflict('stale_branch_structure','Branches changed. Reload before saving.');
  const regions=change(current.regions.map(r=>({...r,branch_ids:[...r.branch_ids]})));
  try{
    await upsertDocument(ctx.orgId,'organization_departments',{id:'catalog',data:{departments:current.departments,regions,terminology:current.terminology,...(current.unit_migration?{unit_migration:current.unit_migration}:{})},expected_revision:current.revision},{replace:true,createOnly:current.revision===0});
  }catch(error){
    if((error as {statusCode?:number}).statusCode===409)throw conflict('stale_branch_structure','Branches changed. Reload before saving.');
    throw error;
  }
}
async function branchDocument(orgId:string,branchId:string){
  const document=await readDocument(orgId,'branch',branchId).catch(error=>{if(error.statusCode===404)return null;throw error;});
  if(!document&&branchId!==DEFAULT_BRANCH_ID)throw notFound('branch_not_found','That branch is not in this organization.');
  return document;
}
function assertUniqueName(structure:OrganizationStructure,value:string,exceptId=''){
  if(value&&structure.branches.some(b=>b.id!==exceptId&&b.status==='active'&&b.name.toLowerCase()===value.toLowerCase()))throw badRequest('branch_name_taken','Another branch already has that name.');
}
const generated=(prefix:string)=>`${prefix}_${randomBytes(6).toString('hex')}`;

export async function addBranch(ctx:PlatformAuthContext,input:unknown){
  const change=branchAddSchema.parse(input);
  const {structure,scope}=await freshScope(ctx);
  requireStructureAdministration(ctx,scope);
  assertUniqueName(structure,change.name);
  if(change.region_id&&!structure.catalog.regions.some(r=>r.id===change.region_id&&r.status==='active'))throw badRequest('unknown_region','Choose an active region.');
  const branchId=generated('branch');
  await upsertDocument(ctx.orgId,'branch',{id:branchId,data:{name:change.name,status:'active',created_by:ctx.userId}},{createOnly:true});
  if(change.region_id)await writeRegions(ctx,undefined,regions=>regions.map(r=>({...r,branch_ids:r.id===change.region_id?unique([...r.branch_ids,branchId]).sort():r.branch_ids.filter(id=>id!==branchId)})));
  return readBranchStructure(ctx);
}

/** Renames a branch the caller manages. Only the default branch may have no name. */
export async function renameBranch(ctx:PlatformAuthContext,input:unknown){
  const change=branchRenameSchema.parse(input);
  requireFeature(ctx);
  const {structure,scope}=await freshScope(ctx);
  if(!hasPermission(ctx,'manage_company_settings')||!canManageBranches(scope,[change.branch_id]))throw forbidden('branch_scope_denied','You cannot rename this branch.');
  await branchDocument(ctx.orgId,change.branch_id);
  if(!change.name&&change.branch_id!==DEFAULT_BRANCH_ID)throw badRequest('branch_name_required','A branch needs a name.');
  assertUniqueName(structure,change.name,change.branch_id);
  await upsertDocument(ctx.orgId,'branch',{id:change.branch_id,data:{name:change.name}},{replace:false});
  return readBranchStructure(ctx);
}

/** Archives (or restores) a branch. The default branch cannot be archived, nor a branch anyone or any department still depends on. */
export async function archiveBranch(ctx:PlatformAuthContext,input:unknown){
  const change=branchArchiveSchema.parse(input);
  const {structure,scope}=await freshScope(ctx);
  requireStructureAdministration(ctx,scope);
  if(change.branch_id===DEFAULT_BRANCH_ID)throw badRequest('default_branch_required','The organization\'s first branch cannot be archived.');
  await branchDocument(ctx.orgId,change.branch_id);
  if(change.archived){
    const only=(rows:Array<{branch_ids:string[]}>)=>rows.filter(row=>row.branch_ids.length===1&&row.branch_ids[0]===change.branch_id).length;
    const blocking={users:only(structure.users),groups:only(structure.groups),departments:structure.catalog.departments.filter(d=>d.status==='active'&&d.branch_id===change.branch_id).length};
    if(blocking.users||blocking.groups||blocking.departments)throw badRequest('branch_in_use','Move its people, groups and departments to another branch first.',blocking);
  }
  await upsertDocument(ctx.orgId,'branch',{id:change.branch_id,data:change.archived?{status:'archived',archived_at:new Date().toISOString()}:{status:'active',archived_at:''}},{replace:false});
  return readBranchStructure(ctx);
}

/** Adds a region, or renames or archives one. Regions are flat; archiving one leaves its branches in no region. */
export async function saveRegion(ctx:PlatformAuthContext,input:unknown){
  const change=regionSaveSchema.parse(input);
  const {structure,scope}=await freshScope(ctx);
  requireStructureAdministration(ctx,scope);
  const regionId=change.id||generated('region');
  const existing=structure.catalog.regions.find(r=>r.id===regionId);
  if(change.id&&!existing)throw notFound('region_not_found','That region is not in this organization.');
  const status=change.status||existing?.status||'active';
  if(status==='active'&&structure.catalog.regions.some(r=>r.id!==regionId&&r.status==='active'&&r.label.toLowerCase()===change.label.toLowerCase()))throw badRequest('region_name_taken','Another region already has that name.');
  await writeRegions(ctx,change.expected_revision,regions=>existing
    ?regions.map(r=>r.id===regionId?{...r,label:change.label,status,branch_ids:status==='archived'?[]:r.branch_ids}:r)
    :[...regions,{id:regionId,label:change.label,status,branch_ids:[]}]);
  return {...await readBranchStructure(ctx),region_id:regionId};
}

/** Puts a branch in a region, or in none (`region_id: ""`). A branch is in at most one region. */
export async function setBranchRegion(ctx:PlatformAuthContext,input:unknown){
  const change=branchRegionSetSchema.parse(input);
  const {structure,scope}=await freshScope(ctx);
  requireStructureAdministration(ctx,scope);
  if(!structure.branches.some(b=>b.id===change.branch_id))throw notFound('branch_not_found','That branch is not in this organization.');
  if(change.region_id&&!structure.catalog.regions.some(r=>r.id===change.region_id&&r.status==='active'))throw badRequest('unknown_region','Choose an active region.');
  await writeRegions(ctx,change.expected_revision,regions=>regions.map(r=>({...r,branch_ids:r.id===change.region_id?unique([...r.branch_ids,change.branch_id]).sort():r.branch_ids.filter(id=>id!==change.branch_id)})));
  return readBranchStructure(ctx);
}

/**
 * Sets the branches a person, group or outside company belongs to, in the home each already has: a user document's
 * `branch_id` and `branch_ids`, a group's `branch_id` and `metadata.branch_ids`, a company's branch rows. A person or a
 * group needs at least one branch; `primary_branch_id` (default: the current one if kept, else the first) becomes their
 * own branch. An outside company with no branches works in every branch.
 */
export async function setAssigneeBranches(ctx:PlatformAuthContext,input:unknown){
  const change=membershipSetSchema.parse(input);
  requireFeature(ctx);
  const ref=typeof change.assignee==='string'?{type:change.assignee.slice(0,change.assignee.indexOf(':')),id:change.assignee.slice(change.assignee.indexOf(':')+1)}:change.assignee;
  const {structure,scope}=await freshScope(ctx);
  const branchIds=unique(change.branch_ids);
  const active=new Set(structure.branches.filter(b=>b.status==='active').map(b=>b.id));
  if(branchIds.some(id=>!active.has(id)))throw badRequest('unknown_branch','Choose active branches from this organization.');
  if(ref.type!=='organization_connection'&&!branchIds.length)throw badRequest('branch_required','A person or a group belongs to at least one branch.');
  const primaryFor=(current:string)=>change.primary_branch_id&&branchIds.includes(change.primary_branch_id)?change.primary_branch_id:branchIds.includes(current)?current:branchIds[0];
  if(change.primary_branch_id&&!branchIds.includes(change.primary_branch_id))throw badRequest('primary_branch_invalid','The main branch must be one of the branches chosen.');
  if(ref.type==='organization_user'){
    if(!hasPermission(ctx,'manage_company_users'))throw forbidden('branch_membership_denied','Managing users is required.');
    const document=await readDocument(ctx.orgId,'users',ref.id).catch(()=>null);
    if(!document)throw notFound('workforce_user_not_found','Organization user was not found.');
    const before=userBranchIds(document.data);
    assertBranchChange(scope,before,branchIds);
    const primary=primaryFor(text(document.data.branch_id)||DEFAULT_BRANCH_ID);
    await upsertDocument(ctx.orgId,'users',{id:ref.id,data:{branch_id:primary,branch_ids:[primary,...branchIds.filter(id=>id!==primary)]},expected_revision:document.revision},{replace:false});
    return {assignee:`${ref.type}:${ref.id}`,branch_ids:[primary,...branchIds.filter(id=>id!==primary)],primary_branch_id:primary};
  }
  if(!hasPermission(ctx,'manage_company_settings'))throw forbidden('branch_membership_denied','Company settings permission is required.');
  if(ref.type==='resource_group'){
    const storage=await import('./storage.js');
    const group=await storage.readResourceGroup(ctx.orgId,ref.id);
    const before=storage.groupBranchIds(group);
    assertBranchChange(scope,before,branchIds);
    const primary=primaryFor(text(group.branch_id)||DEFAULT_BRANCH_ID);
    const ordered=[primary,...branchIds.filter(id=>id!==primary)];
    await storage.patchResourceGroup(ctx.orgId,ref.id,{branch_id:primary,metadata:{branch_ids:ordered},expected_revision:group.revision});
    return {assignee:`${ref.type}:${ref.id}`,branch_ids:ordered,primary_branch_id:primary};
  }
  const connections=await import('../connections/storage.js');
  const connection=await connections.readOrganizationConnection(ctx.orgId,ref.id);
  const before=Array.isArray(connection.branch_ids)?connection.branch_ids.map(String):[];
  assertBranchChange(scope,before,branchIds,true);
  await connections.patchOrganizationConnection(ctx.orgId,ref.id,{branch_ids:branchIds,expected_revision:Number(connection.revision)});
  return {assignee:`${ref.type}:${ref.id}`,branch_ids:branchIds,primary_branch_id:branchIds[0]||''};
}
export type {BranchScope};
