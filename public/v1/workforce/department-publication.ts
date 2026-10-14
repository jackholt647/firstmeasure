import {zodToJsonSchema} from 'zod-to-json-schema';
import {registerDataProvider} from '../platform/publication/providers.js';
import type {JsonSchema} from '../platform/publication/contracts.js';
import {forbidden} from '../platform/errors.js';
import {departmentCatalogSchema,assertDepartmentRead,readOrganizationDepartments} from './departments.js';
import {branchScope,canSeeBranches} from './branch-scope.js';
import {registerBranchPublication} from './branch-publication.js';

export function registerDepartmentPublication(){
  registerBranchPublication();
  registerDataProvider({id:'workforce-departments',version:'1',apps:['settings','scheduling','crew'],exports:{catalog:{
    description:'Organization departments, each in one branch, with their role and group-type defaults and direct assignments; the regions that group branches; and department terminology. A viewer limited to some branches sees only the departments of those branches.',
    schema:zodToJsonSchema(departmentCatalogSchema,{$refStrategy:'none'}) as JsonSchema,schemaVersion:'1',
    access:{scopes:['organization'],permissions:[],systemKinds:['module','work','agent'],authorize:ctx=>{
      if(!ctx.auth)throw forbidden('departments_denied','An authenticated department reader is required.');
      assertDepartmentRead(ctx.auth);
    }},
    read:async ctx=>{const result=await readOrganizationDepartments(ctx.organizationId);const scope=ctx.auth?branchScope(ctx.auth):null;const shown=(ids:string[])=>!scope||canSeeBranches(scope,ids);return {value:{departments:result.departments.filter(d=>shown([d.branch_id])),regions:result.regions.map(r=>({...r,branch_ids:r.branch_ids.filter(id=>shown([id]))})).filter(r=>!scope?.restricted_view||r.branch_ids.length),terminology:result.terminology},revision:result.revision?String(result.revision):result.legacy_token};}
  }}});
}
