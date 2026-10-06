import type { AgentTool, AgentRun } from "../agents/types.js";
import { backgroundAuthContext, hasPermission, requireCapability } from "../platform/auth.js";
import { readBranchModule } from "../platform/storage.js";
import { forbidden, PlatformError } from "../platform/errors.js";
import { ensureLeadImportSettings, saveLeadImportSettings } from "../email/api.js";
import { leadDeliveries, reviewLeadDelivery } from "./intake.js";
async function actor(run:AgentRun,permission:string){
 if(!run.userId)throw forbidden("lead_user","A signed-in user is required.");
 const ctx=await backgroundAuthContext(run.orgId,run.userId);
 if(!hasPermission(ctx,permission))throw forbidden("lead_permission","Lead access is unavailable.");
 await requireCapability(ctx,"platform.lead_import");return ctx;
}
function tool(name:string,description:string,permission:string,write:boolean,properties:Record<string,unknown>,required:string[],execute:AgentTool["execute"]):AgentTool{
 return {name,description,permission,parameters:{type:"object",properties,required,additionalProperties:false},publication:{version:"1",effect:write?"write":"read"},
  gate:run=>write&&(run.settings.allow_actions===false||run.scratch.actionsAllowed===false)?"Assistant actions are disabled.":true,execute};
}
export const leadTools:AgentTool[]=[
 tool("leads_inbox","Read the current branch's unique lead inbox. Does not create an inbox.","manage_company_settings",false,{},[],async run=>{
  const ctx=await actor(run,"manage_company_settings");await requireCapability(ctx,"email.inbound_lead_import");
  try{return {settings:(await readBranchModule(ctx.orgId,ctx.branchId||"default","lead_import")).data};}catch(error){if(error instanceof PlatformError&&error.statusCode===404)return {configured:false};throw error;}
 }),
 tool("leads_inbox_configure","Provision or update this branch's lead inbox. Regeneration revokes prior inbox aliases; explain the provider update first.","manage_company_settings",true,{enabled:{type:"boolean"},regenerate:{type:"boolean"},notification_target_role_ids:{type:"array",items:{type:"string"}}},[],async(run,args)=>{
  const ctx=await actor(run,"manage_company_settings");await requireCapability(ctx,"email.inbound_lead_import");
  if(!Object.keys(args).length)return {settings:(await ensureLeadImportSettings(ctx.orgId,ctx.branchId||"default")).data};
  return saveLeadImportSettings(ctx.orgId,ctx.branchId||"default",args);
 }),
 tool("leads_deliveries","Inspect lead delivery history, duplicate attempts, failures and project IDs for this branch.","manage_projects",false,{after:{type:"string"},limit:{type:"integer",minimum:1,maximum:100}},[],async(run,args)=>{const ctx=await actor(run,"manage_projects");return leadDeliveries(ctx.orgId,{branchId:ctx.branchId||"default",after:String(args.after||""),limit:Number(args.limit||25)});}),
 tool("leads_delivery_review","Record the user's review of an uncertain delivery after checking its project and workflow. Does not replay lead creation.","manage_projects",true,{id:{type:"string"},decision:{type:"string",enum:["imported","dismissed"]},note:{type:"string"}},["id","decision","note"],async(run,args)=>{const ctx=await actor(run,"manage_projects");return reviewLeadDelivery(ctx.orgId,String(args.id),ctx.userId,{decision:args.decision,note:args.note});}),
];
