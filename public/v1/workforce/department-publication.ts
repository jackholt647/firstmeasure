import {zodToJsonSchema} from 'zod-to-json-schema';
import {registerDataProvider} from '../platform/publication/providers.js';
import type {JsonSchema} from '../platform/publication/contracts.js';
import {forbidden} from '../platform/errors.js';
import {departmentCatalogSchema,assertDepartmentRead,readOrganizationDepartments} from './departments.js';

export function registerDepartmentPublication(){
  registerDataProvider({id:'workforce-departments',version:'1',apps:['settings','scheduling','crew'],exports:{catalog:{
    description:'Organization departments, categories, role and group-type defaults, and direct assignments.',
    schema:zodToJsonSchema(departmentCatalogSchema,{$refStrategy:'none'}) as JsonSchema,schemaVersion:'1',
    access:{scopes:['organization'],permissions:[],systemKinds:['module','work','agent'],authorize:ctx=>{
      if(!ctx.auth)throw forbidden('departments_denied','An authenticated department reader is required.');
      assertDepartmentRead(ctx.auth);
    }},
    read:async ctx=>{const result=await readOrganizationDepartments(ctx.organizationId);return {value:{departments:result.departments,groups:result.groups},revision:result.revision?String(result.revision):result.legacy_token};}
  }}});
}
