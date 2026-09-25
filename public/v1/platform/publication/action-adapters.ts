/** Domain services remain the authority for business invariants; no HTTP proxy or generic DB writes. */
import { registerAction, type ActionDefinition } from "./actions.js";
import type { PublicationContext, TargetRef, JsonSchema } from "./contracts.js";
import { jsonValueSchema } from "./contracts.js";
import { contentHash } from "./validation.js";
import { badRequest, forbidden } from "../errors.js";
import { backendImplementationDigest } from "./implementation.js";
import { actionInputContract } from "./action-schemas.js";

const string: JsonSchema = { type: "string", minLength: 1 };
const object: JsonSchema = { type: "object", additionalProperties: true };
const integer: JsonSchema = { type: "integer", minimum: 0 };
type Input = Record<string, unknown>;
function auth(ctx: PublicationContext) { if (!ctx.auth) throw forbidden("action_user_required", "This domain action requires an authenticated user."); return ctx.auth; }
function id(target: TargetRef) { if (!target.id) throw badRequest("action_target_id_required", "A resource id is required."); return target.id; }
function project(target: TargetRef) { if (!target.projectId) throw badRequest("action_project_required", "A project id is required."); return target.projectId; }
function values(input: Input) { return (input.values || {}) as Input; }
async function authorizeDomainTarget(action: string, ctx: PublicationContext, target: TargetRef) {
  const principal = auth(ctx);
  if (action.startsWith("comms.project.")) await (await import("../../comms/calls/service.js")).projectContext(principal,project(target));
  if (action.startsWith("canvassing.")) {
    await (await import("../../canvassing/service.js")).requireCanvassingAppFlag(ctx.organizationId);
    const settings = await (await import("../storage.js")).readBranchModule(ctx.organizationId,ctx.branchId || "default","canvassing").catch(() => null);
    if (settings?.data?.enabled === false) throw forbidden("canvassing_disabled","Canvassing is disabled for this branch.");
  }
  if (action.startsWith("media.")) {
    const media = await (await import("../storage.js")).readMediaMetadata(ctx.organizationId,id(target));
    const access = await import("../media_access.js");
    const allowed = action === "media.item.read" ? access.canReadReceiptMedia(media,principal) : access.canWriteReceiptMedia(media,principal);
    if (!allowed) throw forbidden("receipt_media_forbidden", "This media is not available to this user.");
    if (ctx.projectId) {
      const metadata = (media.metadata || {}) as Input, owner = (media.owner || {}) as Input;
      if ((metadata.project_id || (owner.type === "project" ? owner.id : "")) !== ctx.projectId) throw forbidden("publication_project_denied", "This media is outside the project context.");
    }
  }
  if (action === "channels.messages.list") await (await import("../../channels/service.js")).requireChannelAccess(principal,id(target));
  if (action === "channels.message.react") {
    const message = await (await import("../../channels/storage.js")).readMessageRecord(ctx.organizationId,id(target));
    if (!message) throw badRequest("message_not_found", "This message does not exist.");
    await (await import("../../channels/service.js")).requireChannelAccess(principal,message.channel_id,{write:true});
  }
  if (ctx.projectId && target.scope === "organization" && target.id && !action.startsWith("media.")) {
    let resource: Input | undefined;
    if (action.startsWith("work.node.")) resource = await (await import("../../work/storage.js")).readNodeRecord(ctx.organizationId,id(target)) as Input;
    else if (action.startsWith("work.plan.")) resource = await (await import("../../work/storage.js")).readPlanRecord(ctx.organizationId,id(target)) as Input;
    else if (action.startsWith("documents.")) resource = await (await import("../../documents/service.js")).readDocumentInstance(ctx.organizationId,id(target));
    else if (action.startsWith("materials.list.")) resource = await (await import("../../materials/storage.js")).readMaterialList(ctx.organizationId,id(target));
    else if (action.startsWith("materials.order.")) resource = await (await import("../../materials/storage.js")).readMaterialOrder(ctx.organizationId,id(target));
    else if (action.startsWith("payments.invoice.")) resource = await (await import("../../payments/invoices.js")).readInvoice(ctx.organizationId,id(target));
    else if (action.startsWith("payments.payment.")) resource = await (await import("../../payments/storage.js")).readPayment(ctx.organizationId,id(target));
    else if (action.startsWith("proposals.")) resource = await (await import("../../proposals/storage.js")).readProposal(ctx.organizationId,id(target));
    else if (action.startsWith("chat.conversation.")) resource = await (await import("../../messaging/communications_storage.js")).readConversationRecord(ctx.organizationId,id(target)) as Input;
    if (resource && resource.project_id !== ctx.projectId) throw forbidden("publication_project_denied", "This resource is outside the project context.");
  }
}
type DomainAction = {
  id: string; description: string; permission: string; capabilities?: string[];
  effect?: ActionDefinition["effect"]; scopes?: TargetRef["scope"][];
  properties?: Record<string, JsonSchema>; required?: string[];
  applications?: readonly string[] | false;
  execute: ActionDefinition["execute"];
};
function publish(def: DomainAction) {
  const effect = def.effect || "write";
  const contract = actionInputContract(def.id, !!def.required?.includes("values"));
  const fieldAccessible = def.id.startsWith("channels.") || def.id === "training.courses.mine" || (def.id.startsWith("equipment.") && !def.id.startsWith("equipment.maintenance."));
  registerAction({ id: def.id, version: "1", implementation: contentHash({ artifact: backendImplementationDigest(), adapter: def.execute.toString(), contract: "domain-actions-1" }),
    domain: def.id.split(".")[0]!, description: def.description,
    inputSchema: contract?.inputSchema || { type: "object", properties: def.properties || {}, required: def.required || [], additionalProperties: false },
    validateInput: contract?.validateInput,
    outputSchema: jsonValueSchema, effect, executionKinds: ["api", "module", "agent", "work"],
    idempotency: effect === "read" || effect === "compute" ? "none" : "required",
    policy: { scopes: def.scopes || ["organization"], applications: def.applications ?? (fieldAccessible ? ["management", "field"] : ["management"]), permissions: def.permission ? [def.permission] : [], capabilities: def.capabilities || [], authorize: (ctx,target) => authorizeDomainTarget(def.id,ctx,target) },
    execute: async (ctx, target, input, execution) => JSON.parse(JSON.stringify((await def.execute(ctx, target, input, execution)) ?? null))
  });
}
let registered = false;
export function registerDomainActions() {
  if (registered) return;
  const view = "view_projects";
  const manage = "manage_projects";
  const equipmentView = "equipment.view|equipment.manage|equipment.service|manage_company_settings";
  const equipmentService = "equipment.manage|equipment.service|manage_company_settings";
  publish({ id: "equipment.fleet.list", description: "List the organization equipment fleet.", permission: equipmentView, capabilities: ["apps.equipment"], effect: "read", execute: async c => (await import("../../equipment/service.js")).fleetUnits(c.organizationId) });
  publish({ id: "equipment.unit.history", description: "Read equipment meter and maintenance history.", permission: equipmentView, capabilities: ["apps.equipment"], effect: "read", execute: async (c,t) => (await import("../../equipment/service.js")).unitHistory(c.organizationId,id(t)) });
  publish({ id: "equipment.meter.record", description: "Record a meter reading for the target equipment unit.", permission: equipmentService, capabilities: ["apps.equipment"], properties: { values: object }, required: ["values"], execute: async (c,t,i) => {
    const schema = await import("../../equipment/schemas.js");
    return (await import("../../equipment/service.js")).logMeterEntry(c.organizationId, { ...schema.meterEntrySchema.parse(values(i)), unit_id: id(t), user_id: auth(c).userId });
  } });
  publish({ id: "equipment.unit.checkOut", description: "Check out a unit to the authenticated user.", permission: equipmentView, capabilities: ["equipment.custody"], properties: { values: object }, execute: async (c,t,i) => (await import("../../equipment/service.js")).checkOutUnit(c.organizationId,id(t),values(i),auth(c).userId) });
  publish({ id: "equipment.unit.checkIn", description: "Return the target equipment unit.", permission: equipmentView, capabilities: ["equipment.custody"], execute: async (c,t) => (await import("../../equipment/service.js")).checkInUnit(c.organizationId,id(t)) });
  publish({ id: "equipment.maintenance.open", description: "Open a validated maintenance work order.", permission: equipmentService, capabilities: ["equipment.maintenance"], properties: { values: object }, required: ["values"], execute: async (c,_t,i) => (await import("../../equipment/service.js")).openWorkOrder(c.organizationId,(await import("../../equipment/schemas.js")).createWorkOrderSchema.parse(values(i))) });
  publish({ id: "equipment.maintenance.complete", description: "Complete the target maintenance work order.", permission: equipmentService, capabilities: ["equipment.maintenance"], properties: { values: object }, required: ["values"], execute: async (c,t,i) => (await import("../../equipment/service.js")).completeWorkOrder(c.organizationId,id(t),(await import("../../equipment/schemas.js")).completeWorkOrderSchema.parse(values(i)),auth(c).userId) });
  publish({ id: "equipment.maintenance.cancel", description: "Cancel the target maintenance work order.", permission: equipmentService, capabilities: ["equipment.maintenance"], execute: async (c,t) => (await import("../../equipment/service.js")).cancelWorkOrder(c.organizationId,id(t)) });

  publish({ id: "work.plan.read", description: "Read a work plan tree.", permission: view, effect: "read", execute: async (c,t) => (await import("../../work/service.js")).workPlanTree(c.organizationId,id(t)) });
  publish({ id: "work.node.transition", description: "Transition a work node with its existing dependency and lifecycle checks.", permission: manage, properties: { values: object }, required: ["values"], execute: async (c,t,i) => {
    const input = (await import("../../work/schemas.js")).transitionWorkNodeSchema.parse(values(i));
    return (await import("../../work/service.js")).transitionWorkNode(c.organizationId,id(t),input.status,{...input,actor_user_id:auth(c).userId,actor_email:String(auth(c).identity.email || "")});
  } });
  publish({ id: "work.node.patch", description: "Update the editable work node fields.", permission: manage, properties: { values: object }, required: ["values"], execute: async (c,t,i) => (await import("../../work/service.js")).patchWorkNode(c.organizationId,id(t),(await import("../../work/schemas.js")).patchWorkNodeSchema.parse(values(i))) });
  publish({ id: "work.project.projection", description: "Read a project's current work projection.", permission: view, scopes: ["project"], effect: "read", execute: async (c,t) => (await import("../../work/service.js")).projectWorkProjection(c.organizationId,project(t)) });

  publish({ id: "materials.project.lists", description: "Read material lists for a project.", permission: view, scopes: ["project"], effect: "read", execute: async (c,t) => (await import("../../materials/storage.js")).listProjectMaterialLists(c.organizationId,project(t)) });
  publish({ id: "materials.list.read", description: "Read the target material list.", permission: view, effect: "read", execute: async (c,t) => (await import("../../materials/storage.js")).readMaterialList(c.organizationId,id(t)) });
  publish({ id: "materials.order.read", description: "Read the target material order.", permission: view, effect: "read", execute: async (c,t) => (await import("../../materials/storage.js")).readMaterialOrder(c.organizationId,id(t)) });

  publish({ id: "documents.instance.read", description: "Read the target document instance through the document service.", permission: view, effect: "read", execute: async (c,t) => (await import("../../documents/service.js")).documentWorkflowDetail(c.organizationId,id(t)) });
  publish({ id: "documents.workflow.update", description: "Update document workflow state with document service lifecycle validation.", permission: view, properties: { values: object }, required: ["values"], execute: async (c,t,i) => (await import("../../documents/service.js")).updateDocumentWorkflowState(c.organizationId,id(t),values(i),auth(c)) });
  publish({ id: "documents.instance.issue", description: "Issue an existing document instance.", permission: view, properties: { values: object }, execute: async (c,t,i) => (await import("../../documents/service.js")).issueDocument(c.organizationId,id(t),values(i),auth(c)) });

  publish({ id: "payroll.upcoming.read", description: "Read upcoming payroll for authorized payroll managers.", permission: "manage_payroll|manage_company_settings", capabilities: ["apps.payroll"], effect: "read", execute: async c => (await import("../../payroll/service.js")).upcomingPayroll(c.organizationId) });
  publish({ id: "workforce.users.list", description: "Read the workforce user directory.", permission: "manage_company_users|manage_company_user_permissions|manage_company_settings", effect: "read", execute: async c => (await import("../../workforce/service.js")).listWorkforceUsers(c.organizationId) });

  publish({ id: "training.courses.mine", description: "Read courses assigned to the authenticated learner.", permission: "", capabilities: ["apps.training"], effect: "read", execute: async c => {
    const principal = auth(c);
    return (await import("../../training/service.js")).listMyCourses(c.organizationId,{userId:principal.userId,roleIds:[...new Set([principal.role,...(principal.accessProfile?.access_role_ids || [])])]},{initialize:false});
  } });
  publish({ id: "training.course.progress", description: "Read a course's progress report as a training manager.", permission: "manage_training|manage_company_settings", capabilities: ["training.studio"], effect: "read", execute: async (c,t) => (await import("../../training/service.js")).courseProgressReport(c.organizationId,id(t)) });

  publish({ id: "channels.list", description: "List channels the authenticated user can access.", permission: "", capabilities: ["apps.channels"], effect: "read", execute: async c => (await import("../../channels/service.js")).listChannelsForUser(auth(c),{initialize:false}) });
  publish({ id: "channels.messages.list", description: "Read messages with channel membership authorization.", permission: "", capabilities: ["apps.channels"], effect: "read", properties: { limit: {type:"integer",minimum:1,maximum:100} }, execute: async (c,t,i) => (await import("../../channels/service.js")).listMessages(auth(c),id(t),{limit:Number(i.limit || 50)}) });
  publish({ id: "channels.message.react", description: "Set a reaction on a visible channel message.", permission: "", capabilities: ["apps.channels"], properties: { emoji: string, on: {type:"boolean"} }, required: ["emoji","on"], execute: async (c,t,i) => (await import("../../channels/service.js")).toggleReaction(auth(c),id(t),String(i.emoji),Boolean(i.on)) });

  publish({ id: "websites.sites.list", description: "Read websites for the organization.", permission: "view_projects|manage_company_settings", capabilities: ["apps.web_editor"], effect: "read", execute: async c => (await import("../../websites/service.js")).siteListing(c.organizationId) });
  publish({ id: "websites.page.publish", description: "Publish a site page at an expected revision.", permission: "manage_company_settings", capabilities: ["apps.web_editor"], effect: "external", properties: { pageId:string, expectedRevision:integer }, required:["pageId","expectedRevision"], execute: async (c,t,i) => (await import("../../websites/service.js")).publishSitePage(c.organizationId,id(t),String(i.pageId),Number(i.expectedRevision),auth(c)) });
  publish({ id: "websites.page.discard", description: "Discard the draft at an expected revision.", permission: "manage_company_settings", capabilities: ["apps.web_editor"], properties: { pageId:string, expectedRevision:integer }, required:["pageId","expectedRevision"], execute: async (c,t,i) => (await import("../../websites/service.js")).discardSitePageDraft(c.organizationId,id(t),String(i.pageId),Number(i.expectedRevision),auth(c)) });

  publish({ id: "pricebook.catalog.validate", description: "Validate a supplied catalog graph without writing it.", permission: "view_projects|manage_company_settings", effect:"compute", properties:{catalog:object}, required:["catalog"], execute: async (_c,_t,i) => (await import("../../pricebook/resolver.js")).validateCatalogGraph(i.catalog) });
  publish({ id: "pricebook.item.resolve", description: "Calculate a supplied catalog item with component overrides.", permission: "view_projects|manage_company_settings", effect:"compute", properties:{catalog:object,itemId:string,overrides:object}, required:["catalog","itemId"], execute: async (_c,_t,i) => (await import("../../pricebook/resolver.js")).resolveCatalogItemToScopeItem(i.catalog,String(i.itemId),(i.overrides || {}) as Input) });
  publish({ id: "customFields.defaults.compute", description: "Calculate defaults on a supplied project value without persistence.", permission: view, effect:"compute", properties:{project:object}, required:["project"], execute: async (_c,_t,i) => (await import("../../custom_fields/service.js")).applyProjectCustomFieldDefaults(i.project) });
  publish({ id:"payments.project.summary",description:"Read the project financial summary.",permission:view,scopes:["project"],effect:"read",execute:async(c,t)=>(await import("../../payments/storage.js")).projectMoneySummary(c.organizationId,project(t)) });
  publish({ id:"payments.invoice.create",description:"Create an invoice using the existing signed-proposal and obligation checks.",permission:manage,scopes:["project"],properties:{values:object},required:["values"],execute:async(c,t,i)=>(await import("../../payments/invoices.js")).createInvoice(c.organizationId,project(t),(await import("../../payments/schemas.js")).createInvoiceSchema.parse(values(i)),auth(c)) });
  publish({ id:"payments.invoice.due",description:"Mark an invoice due.",permission:manage,properties:{values:object},execute:async(c,t,i)=>(await import("../../payments/invoices.js")).markInvoiceDue(c.organizationId,id(t),(await import("../../payments/schemas.js")).markInvoiceDueSchema.parse(values(i)),auth(c)) });
  publish({ id:"payments.invoice.void",description:"Void an invoice under existing accounting rules.",permission:manage,properties:{values:object},execute:async(c,t,i)=>(await import("../../payments/invoices.js")).voidInvoice(c.organizationId,id(t),(await import("../../payments/schemas.js")).voidInvoiceSchema.parse(values(i)),auth(c)) });
  publish({ id:"payments.payment.clear",description:"Reconcile a payment as cleared.",permission:manage,properties:{values:object},execute:async(c,t,i)=>(await import("../../payments/storage.js")).setPaymentCleared(c.organizationId,id(t),(await import("../../payments/schemas.js")).clearPaymentSchema.parse(values(i)),auth(c)) });
  publish({ id:"payments.payment.refund",description:"Refund a payment through its provider; uncertain outcomes require reconciliation.",permission:manage,effect:"external",properties:{values:object},required:["values"],execute:async(c,t,i)=>(await import("../../payments/storage.js")).refundPayment(c.organizationId,id(t),(await import("../../payments/schemas.js")).refundPaymentSchema.parse(values(i)),auth(c)) });
  publish({ id:"payments.ledger.list",description:"Read the organization financial ledger.",permission:view,effect:"read",execute:async c=>(await import("../../payments/storage.js")).listLedger(c.organizationId) });

  publish({ id:"canvassing.pins.list",description:"Read pins in the execution branch after checking canvassing settings.",permission:"",capabilities:["canvassing.app"],effect:"read",execute:async c=>{
    const service=await import("../../canvassing/service.js");
    return service.listPins(c.organizationId,c.branchId || "default");
  } });
  publish({ id:"canvassing.pin.save",description:"Create or update a canvassing pin, retaining actor and event provenance.",permission:"",capabilities:["canvassing.app"],properties:{values:object},required:["values"],execute:async(c,t,i)=>{
    const service=await import("../../canvassing/service.js");
    const branch=c.branchId || "default";
    await service.ensureCanvassingEnabled(c.organizationId,branch);
    const body={...values(i),...(t.id?{id:t.id}:{})};
    if(!t.id && body.id) throw badRequest("action_target_id_required","Existing pin ids must be supplied as target ids.");
    const pin=await service.savePin(c.organizationId,branch,body,service.actorFromContext(auth(c) as unknown as Input));
    if(!t.id) await (await import("../../work/engine.js")).emitWorkEvent({organization_id:c.organizationId,branch_id:branch,type:"canvassing.pin.created",idempotency_key:`canvassing.pin.created:${pin.id}`,payload:{pin_id:pin.id,address:pin.address,status_id:pin.status_id},context:{actor_user_id:auth(c).userId}});
    return pin;
  } });
  publish({ id:"firstmeasure.exteriors.quote",description:"Calculate current full-house report pricing with exterior feature access enforced.",permission:view,properties:{count:{type:"integer",minimum:1,maximum:10},projectType:{type:"string",enum:["residential","commercial","multifamily"]}},effect:"read",execute:async(c,_t,i)=>{
    const service=await import("../../firstmeasure/exteriors.js");
    await service.requireExteriorAccess(c.organizationId,String(i.projectType || "residential"));
    const {withOrganizationCommerce}=await import("../../commerce/profile.js");
    const {pricingContext,readExpeditePricing}=await import("../../firstmeasure/pricing_config.js");
    const pricing=await readExpeditePricing();
    return withOrganizationCommerce(c.organizationId,()=>pricingContext.run({...pricing,now:new Date()},()=>service.exteriorQuote(Number(i.count || 1))));
  } });
  publish({ id:"media.item.read",description:"Read media metadata with receipt privacy filtering.",permission:"",effect:"read",execute:async(c,t)=>{
    const media=await (await import("../storage.js")).readMediaMetadata(c.organizationId,id(t));
    const access=await import("../media_access.js");
    if(!access.canReadReceiptMedia(media,auth(c))) throw forbidden("receipt_media_forbidden","This media is not available to this user.");
    return access.publicMediaMetadata(media);
  } });
  publish({ id:"media.item.rename",description:"Rename media with receipt write restrictions and a media lifecycle event.",permission:"",properties:{name:string},required:["name"],execute:async(c,t,i)=>{
    const storage=await import("../storage.js"),access=await import("../media_access.js");
    const old=await storage.readMediaMetadata(c.organizationId,id(t));
    if(!access.canWriteReceiptMedia(old,auth(c))) throw forbidden("receipt_media_forbidden","This media cannot be changed by this user.");
    const media=await storage.renameMedia(c.organizationId,id(t),i.name);
    const metadata=(media.metadata || {}) as Input,owner=(media.owner || {}) as Input;
    const projectId=String(metadata.project_id || (owner.type==="project"?owner.id:"") || "");
    await (await import("../../work/engine.js")).emitWorkEvent({organization_id:c.organizationId,branch_id:c.branchId || "default",...(projectId?{project_id:projectId}:{}),type:"media.renamed",idempotency_key:`media.renamed:${id(t)}:${media.updated_at}`,payload:{media_id:id(t),file_name:media.file_name,previous_file_name:old.file_name},context:{actor_user_id:auth(c).userId}});
    return access.publicMediaMetadata(media);
  } });
  publish({ id:"projects.search",description:"Search accessible projects and customer contacts within the current project context when present.",permission:view,effect:"read",properties:{query:{type:"string",maxLength:500},types:{type:"string",enum:["projects","contacts","all"]},limit:{type:"integer",minimum:1,maximum:100}},execute:async(c,_t,i)=>(await import("../api.js")).searchPlatformProjectsAndContacts(c.organizationId,{query:String(i.query || ""),types:i.types === "all" ? "" : String(i.types || ""),limit:Number(i.limit || 25),...(c.projectId?{projectIds:new Set([c.projectId])}:{})}) });
  publish({ id:"projects.lead.create",description:"Create a project lead through canonical lead intake, including contacts and workflow events.",permission:manage,properties:{address:string,title:string,summary:{type:"string",maxLength:10000},contacts:{type:"array",items:object,maxItems:30}},required:["address"],execute:async(c,_t,i)=>(await import("../api.js")).createPlatformLead(c.organizationId,{branch_id:c.branchId || "default",source_kind:"publication",address:String(i.address),title:String(i.title || i.address),summary:String(i.summary || ""),contacts:(i.contacts || []) as unknown[]}) });
  publish({ id:"customerPortal.ensure",description:"Create or retrieve a project's customer portal using the canonical portal service.",permission:manage,scopes:["project"],execute:async(c,t)=>(await import("../api.js")).ensureCustomerPortalRecord(c.organizationId,project(t),{actor_user_id:auth(c).userId}) });

  publish({ id:"scheduling.availability",description:"Read appointment slot availability for the execution branch.",permission:"manage_schedule|view_projects",capabilities:["scheduling.appointment_slots"],scopes:["organization","project"],effect:"read",properties:{values:object},execute:async(c,t,i)=>(await import("../../appointments/availability.js")).appointmentAvailability(c.organizationId,c.branchId || "default",{...values(i),...(t.projectId?{project_id:t.projectId}:{})}) });
  publish({ id:"scheduling.slot.hold",description:"Hold an available appointment slot for the target project.",permission:"manage_schedule|manage_projects",capabilities:["scheduling.appointment_slots"],scopes:["project"],properties:{values:object},required:["values"],execute:async(c,t,i)=>(await import("../../appointments/availability.js")).holdAppointmentSlot(c.organizationId,c.branchId || "default",{...values(i),project_id:project(t)}) });
  publish({ id:"scheduling.confirmation.set",description:"Confirm, decline or reset a project's appointment confirmation.",permission:"manage_schedule|manage_projects",scopes:["project"],properties:{outcome:{type:"string",enum:["confirmed","declined","reset"]}},required:["outcome"],execute:async(c,t,i)=>(await import("../../appointments/service.js")).setAppointmentConfirmation(c.organizationId,project(t),id(t),i.outcome as "confirmed"|"declined"|"reset",{user_id:auth(c).userId}) });
  publish({ id:"scheduling.reschedule.review",description:"Approve or decline a customer's rescheduling request.",permission:"manage_schedule|manage_projects",capabilities:["scheduling.customer_rescheduling"],scopes:["project"],properties:{decision:{type:"string",enum:["approved","declined"]},note:{type:"string",maxLength:2000}},required:["decision"],execute:async(c,t,i)=>(await import("../../appointments/availability.js")).reviewAppointmentReschedule(c.organizationId,project(t),id(t),i.decision as "approved"|"declined",{actor:auth(c).userId,branch_id:c.branchId || "default",note:String(i.note || "")}) });

  publish({ id:"proposals.project.list",description:"Read proposals for a project.",permission:view,scopes:["project"],effect:"read",execute:async(c,t)=>(await import("../../proposals/storage.js")).listProjectProposals(c.organizationId,project(t)) });
  publish({ id:"proposals.create",description:"Create a proposal using the existing pricing and scope validation.",permission:manage,scopes:["project"],properties:{values:object},required:["values"],execute:async(c,t,i)=>(await import("../../proposals/storage.js")).createProposal(c.organizationId,project(t),(await import("../../proposals/schemas.js")).createProposalSchema.parse(values(i)),auth(c)) });
  publish({ id:"proposals.patch",description:"Update an editable proposal with revision checks.",permission:manage,properties:{values:object},required:["values"],execute:async(c,t,i)=>(await import("../../proposals/storage.js")).patchProposal(c.organizationId,id(t),(await import("../../proposals/schemas.js")).patchProposalSchema.parse(values(i)),auth(c)) });
  publish({ id:"proposals.snapshot",description:"Capture a proposal snapshot for customer review.",permission:manage,properties:{values:object},execute:async(c,t,i)=>(await import("../../proposals/storage.js")).createProposalSnapshot(c.organizationId,id(t),(await import("../../proposals/schemas.js")).createSnapshotSchema.parse(values(i)),auth(c)) });
  publish({ id:"proposals.send",description:"Send a proposal through the existing delivery service.",permission:manage,effect:"external",properties:{values:object},execute:async(c,t,i)=>(await import("../../proposals/storage.js")).sendProposal(c.organizationId,id(t),(await import("../../proposals/schemas.js")).sendProposalSchema.parse(values(i)),auth(c)) });
  publish({ id:"feedback.project.request",description:"Request customer feedback for the target project.",permission:manage,effect:"external",scopes:["project"],properties:{channels:{type:"array",items:{type:"string",enum:["sms","email"]},maxItems:2},sourceKey:{type:"string",maxLength:240},resend:{type:"boolean"}},execute:async(c,t,i)=>(await import("../../feedback/service.js")).requestProjectFeedback(c.organizationId,{project_id:project(t),branch_id:c.branchId || "default",...(i.channels?{channels:i.channels as string[]} : {}),...(i.sourceKey?{source_key:String(i.sourceKey)}:{}),resend:i.resend===true,source:{type:"user",user_id:auth(c).userId}}) });
  publish({ id:"feedback.project.summary",description:"Read feedback request and rating status for the target project.",permission:view,effect:"read",scopes:["project"],execute:async(c,t)=>(await import("../../feedback/service.js")).feedbackRequestSummary(c.organizationId,{project_id:project(t)}) });

  publish({ id:"comms.project.feed",description:"Read project communications history.",permission:"view_comms|view_projects|manage_projects|manage_company_settings",capabilities:["apps.comms"],scopes:["project"],effect:"read",properties:{limit:{type:"integer",minimum:1,maximum:200}},execute:async(c,t,i)=>(await import("../../comms/service.js")).projectCommsFeed(c.organizationId,project(t),{limit:Number(i.limit || 50)}) });
  publish({ id:"comms.project.sendSms",description:"Send a project SMS with existing consent and messaging checks.",permission:"send_comms|send_communications|manage_projects|manage_company_settings",capabilities:["comms.sms"],scopes:["project"],effect:"external",properties:{text:{type:"string",minLength:1,maxLength:1600,pattern:"\\S"},to:{type:"string",maxLength:40}},required:["text"],execute:async(c,t,i,e)=>(await import("../../comms/service.js")).sendProjectSms(c.organizationId,c.branchId || "default",project(t),{text:String(i.text),...(i.subject?{subject:String(i.subject)}:{}),...(i.to?{to:String(i.to)}:{}),idempotency_key:e.receiptId,source:{type:"user",user_id:auth(c).userId}},auth(c)) });
  publish({ id:"comms.project.sendEmail",description:"Send a project email through the configured organization mail service.",permission:"send_comms|send_communications|manage_projects|manage_company_settings",capabilities:["comms.email"],scopes:["project"],effect:"external",properties:{subject:{type:"string",minLength:1,maxLength:998},text:{type:"string",minLength:1,maxLength:100000},to:{type:"string",maxLength:500}},required:["subject","text"],execute:async(c,t,i,e)=>(await import("../../comms/service.js")).sendProjectEmail(c.organizationId,c.branchId || "default",project(t),{text:String(i.text),subject:String(i.subject),...(i.to?{to:String(i.to)}:{}),idempotency_key:e.receiptId,source:{type:"user",user_id:auth(c).userId}},auth(c)) });

  publish({ id:"chat.inbox",description:"Read the team live-chat inbox for the authenticated user.",permission:"view_live_chat",capabilities:["apps.live_chat"],effect:"read",execute:async c=>{const service=await import("../../chat/service.js");return service.inboxSnapshot(c.organizationId,auth(c),await service.loadChatSettings(c.organizationId,c.branchId || "default"));} });
  publish({ id:"chat.conversation.claim",description:"Claim a live-chat conversation under the configured claiming policy.",permission:"send_live_chat",capabilities:["apps.live_chat"],execute:async(c,t)=>{const service=await import("../../chat/service.js");return service.claimConversation(c.organizationId,auth(c),await service.loadChatSettings(c.organizationId,c.branchId || "default"),id(t));} });
  publish({ id:"chat.conversation.release",description:"Release the authenticated user's conversation claim.",permission:"send_live_chat",capabilities:["apps.live_chat"],execute:async(c,t)=>(await import("../../chat/service.js")).releaseConversation(c.organizationId,auth(c),id(t)) });
  publish({ id:"chat.conversation.send",description:"Send a live-chat message using claim, consent and delivery rules.",permission:"send_live_chat",capabilities:["apps.live_chat"],effect:"external",properties:{message:{type:"string",minLength:1,maxLength:8000},internal_note:{type:"boolean"}},required:["message"],execute:async(c,t,i,e)=>{const service=await import("../../chat/service.js");return service.teamSendMessage(c.organizationId,auth(c),await service.loadChatSettings(c.organizationId,c.branchId || "default"),id(t),{...i,idempotency_key:e.receiptId});} });
  publish({ id:"referrals.customer.ensure",description:"Ensure a referral offer for the authenticated organization user without exposing global partner administration.",permission:"view_reports",execute:async c=>{
    const principal=auth(c);const service=await import("../../internal/crm/referrals_service.js");
    return service.customerReferralStatus({org_id:c.organizationId,email:String(principal.identity.email || ""),name:String(principal.user.name || ""),company:String(principal.organization.name || "")});
  } });
  publish({ id:"stats.refresh",description:"Explicitly refresh the stats warehouse from domain records.",permission:"manage_projects|manage_company_settings",execute:async c=>(await import("../../stats/sync.js")).ensureStatsFreshness(c.organizationId) });
  publish({ id:"stats.schema",description:"Read the metric and dimension catalog.",permission:"view_projects|manage_projects|manage_company_settings",effect:"read",execute:async c=>{return (await import("../../stats/service.js")).statsSchema(c.organizationId);} });
  publish({ id:"stats.query",description:"Execute validated named metric queries through the stats warehouse.",permission:"view_projects|manage_projects|manage_company_settings",effect:"read",properties:{queries:object},required:["queries"],execute:async(c,_t,i)=>{return (await import("../../stats/metrics.js")).executeStatsQueries(c.organizationId,i.queries as Input);} });
  publish({ id:"stats.views.list",description:"Read saved dashboards.",permission:"view_projects|manage_projects|manage_company_settings",effect:"read",execute:async c=>(await import("../../stats/service.js")).listStatsViews(c.organizationId) });
  publish({ id:"stats.view.fromPreset",description:"Create a dashboard from an existing validated preset.",permission:"manage_projects|manage_company_settings",properties:{presetId:string},required:["presetId"],execute:async(c,_t,i)=>(await import("../../stats/service.js")).createViewFromPreset(c.organizationId,String(i.presetId),auth(c).userId) });
  registered = true;
}
