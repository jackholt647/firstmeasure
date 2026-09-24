import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePlatformAuth, hasPermission } from "../platform/auth.js";
import { canManageTestAppFlags } from "../platform/app_flags.js";
import { forbidden, badRequest, PlatformError } from "../platform/errors.js";
import { overview, createPrice, publishPrice, setAccount, subscribe, finalizeInvoice, addAdjustment } from "./service.js";
import { collectUsage } from "./metering.js";
import { checkout, reconcilePayments } from "./payments.js";
import { quoteSubscription, acceptSubscription, cancelRecurring, cancelPurchase, resumeRecurring, customerPortal } from "./subscriptions.js";
import { record } from "./storage.js";
import type { Price } from "./model.js";

export const registerPlatformBillingApi:FastifyPluginAsync=async app=>{
  app.setErrorHandler((error,_request,reply)=>{
    if(error instanceof z.ZodError) return reply.code(400).send({ok:false,error:"validation_error",message:"Check the billing form values.",issues:error.issues});
    if(error instanceof PlatformError) return reply.code(error.statusCode).send({ok:false,error:error.code,message:error.message});
    app.log.error({err:error},"Platform billing request failed");
    return reply.code(500).send({ok:false,error:"billing_error",message:"Platform billing is temporarily unavailable."});
  });
  async function auth(request:FastifyRequest,write=false,operatorOnly=false) {
    const org=String((request.params as any).orgId);
    const ctx=await requirePlatformAuth(request,{csrf:write,application:false,capability:"platform.platform_billing"});
    const operator=canManageTestAppFlags(ctx);
    if(org!==ctx.orgId && !operator) throw forbidden("organization_forbidden");
    if(org!==ctx.orgId) await (await import("../platform/storage.js")).readGlobal(org);
    if(operatorOnly && !operator) throw forbidden("billing_operator_required");
    if(!operator && !hasPermission(ctx,write?"manage_platform_billing":"view_platform_billing|manage_platform_billing")) throw forbidden("billing_permission_required");
    return {org,ctx,operator};
  }
  const base="/organizations/:orgId";
  app.get(base,async request=>{const {org,ctx,operator}=await auth(request); const query=z.object({period:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional()}).parse(request.query); return {ok:true,can_manage:operator||hasPermission(ctx,"manage_platform_billing"),...await overview(org,operator,query.period)};});
  app.post(`${base}/catalog/install`,async request=>{const {ctx}=await auth(request,true,true);return {ok:true,prices:await (await import("./catalog.js")).installStandardCatalog(ctx.identityId)};});
  app.post(`${base}/customer-portal`,async request=>{const {org}=await auth(request,true);return {ok:true,...await customerPortal(org)};});
  app.post(`${base}/subscriptions/:id/resume`,async request=>{const {org,ctx}=await auth(request,true);return {ok:true,subscription:await resumeRecurring(org,String((request.params as any).id),ctx.identityId)};});
  app.post(`${base}/prices`,async request=>{const {ctx}=await auth(request,true,true); return {ok:true,price:await createPrice(request.body,ctx.identityId)};});
  app.post(`${base}/prices/:priceId/publish`,async request=>{const {ctx}=await auth(request,true,true);return {ok:true,price:await publishPrice(String((request.params as any).priceId),ctx.identityId)};});
  app.put(`${base}/account`,async request=>{const {org,ctx}=await auth(request,true,true);const body=z.object({enforce:z.boolean()}).strict().parse(request.body);return {ok:true,account:await setAccount(org,body.enforce,ctx.identityId)};});
  app.post(`${base}/subscriptions`,async request=>{const {org,ctx}=await auth(request,true);const body=z.object({price_id:z.string().max(100),request_key:z.string().min(8).max(100),accept_terms:z.literal(true)}).strict().parse(request.body);const price=await record<Price>("_platform","price",body.price_id);if(price && (price.monthly_cents||price.rates.some(r=>r.unit_price_micros)))throw badRequest("billing_checkout_required","Review the subscription and complete checkout before activation.");return {ok:true,subscription:await subscribe(org,body.price_id,body.request_key,ctx.identityId)};});
  app.post(`${base}/subscription-quotes`,async request=>{const {org}=await auth(request,true);const body=z.object({price_id:z.string().max(100)}).strict().parse(request.body);return {ok:true,quote:await quoteSubscription(org,body.price_id)};});
  app.post(`${base}/subscription-checkouts`,async request=>{const {org,ctx}=await auth(request,true);const body=z.object({quote_id:z.string().uuid(),accept_terms:z.literal(true)}).strict().parse(request.body);return {ok:true,...await acceptSubscription(org,body.quote_id,ctx.identityId)};});
  app.post(`${base}/subscription-checkouts/refresh`,async request=>{const {org,ctx}=await auth(request,true);await reconcilePayments(org,ctx.identityId);return {ok:true};});
  app.post(`${base}/subscription-checkouts/:id/cancel`,async request=>{const {org}=await auth(request,true);await cancelPurchase(org,String((request.params as any).id));return {ok:true};});
  app.post(`${base}/subscriptions/:id/cancel`,async request=>{const {org,ctx}=await auth(request,true);return {ok:true,subscription:await cancelRecurring(org,String((request.params as any).id),ctx.identityId)};});
  app.post(`${base}/refresh`,async request=>{const {org,ctx}=await auth(request,true);await collectUsage(org);await reconcilePayments(org,ctx.identityId);return {ok:true};});
  app.post(`${base}/adjustments`,async request=>{const {org,ctx}=await auth(request,true,true);const body=z.object({period:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),amount_cents:z.number().int(),reason:z.string().trim().min(1).max(500),request_key:z.string().min(8).max(100)}).strict().parse(request.body);return {ok:true,adjustment:await addAdjustment(org,body.period,body.amount_cents,body.reason,body.request_key,ctx.identityId)};});
  app.post(`${base}/invoices`,async request=>{const {org,ctx}=await auth(request,true,true);const body=z.object({period:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)}).strict().parse(request.body);const result=await collectUsage(org);if(!("complete" in result)||!result.complete) throw badRequest("billing_sync_required","Enable monitoring and finish usage collection before closing an invoice.");return {ok:true,invoice:await finalizeInvoice(org,body.period,ctx.identityId)};});
  app.post(`${base}/invoices/:period/checkout`,async request=>{const {org,ctx}=await auth(request,true);throw badRequest("billing_automatic_collection","Charges are collected automatically. Update your subscription payment method in Billing.");});
};
