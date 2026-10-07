import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePlatformAuth } from "../../platform/auth.js";
import { userPublicationContext } from "../../platform/publication/context.js";
import * as presentations from "./presentation-service.js";

const object = z.record(z.unknown());
const revision = z.number().int().positive();
const params = (request: FastifyRequest) => request.params as Record<string, string>;
const change = z.object({ input: z.string().min(1).max(80), value: z.unknown() }).strict();
/** One change at a time is the normal call; a short batch applies atomically. */
const changes = z.union([
  z.object({ expectedRevision: revision, input: z.string().min(1).max(80), value: z.unknown() }).strict().transform(body => ({ expectedRevision: body.expectedRevision, changes: [{ input: body.input, value: body.value }] })),
  z.object({ expectedRevision: revision, changes: z.array(change).min(1).max(20) }).strict()
]);
const recipient = z.object({ name: z.string().max(200).optional(), email: z.string().max(320).optional(), phone: z.string().max(40).optional(), signer_id: z.string().max(80).optional(), role: z.string().max(80).optional() }).strict();
const audit = (request: FastifyRequest) => ({ ip: request.ip, userAgent: String(request.headers["user-agent"] || "").slice(0, 400) });
const privateResponse = (reply: FastifyReply) => { void reply.header("Cache-Control", "no-store"); void reply.header("Referrer-Policy", "no-referrer"); };

/** Mounted by the document-module plugin, under /v1/document-modules. */
export function registerPresentationRoutes(app: FastifyInstance) {
  async function context(request: FastifyRequest, manage = false) {
    const auth = await requirePlatformAuth(request, { orgId: params(request).orgId!, permission: manage ? "manage_company_settings" : "view_projects", csrf: !["GET", "HEAD"].includes(request.method), capability: manage ? "documents.templates_studio" : "platform.documents" });
    return userPublicationContext(auth, { executionKind: "module" });
  }
  app.get("/organizations/:orgId/presentation-modules", async request => ({ modules: await presentations.listPresentationModules(await context(request)) }));
  app.post("/organizations/:orgId/presentation-modules", async (request, reply) => {
    const body = z.object({ moduleId: z.string().max(200).optional(), definition: object }).strict().parse(request.body);
    return reply.code(201).send({ module: await presentations.publishPresentation(await context(request, true), body.definition, body.moduleId) });
  });
  app.get("/organizations/:orgId/documents/:documentId/presentation", async request => presentations.documentPresentationOptions(await context(request), params(request).documentId!));
  app.get("/organizations/:orgId/presentations", async request => {
    const query = z.object({ projectId: z.string().min(1) }).parse(request.query);
    return { presentations: await presentations.listPresentations(await context(request), query.projectId) };
  });
  app.post("/organizations/:orgId/presentations", async (request, reply) => {
    const body = z.object({ documentId: z.string().optional(), projectId: z.string().optional(), source: z.object({ instanceId: z.string().min(1), exportName: z.string().min(1) }).strict().optional(), moduleId: z.string().optional(), version: z.string().optional(), inputs: object.optional() }).strict()
      .refine(value => !(value.documentId && value.source), "Give one source.").parse(request.body);
    return reply.code(201).send({ presentation: await presentations.createPresentation(await context(request), body) });
  });
  app.get("/organizations/:orgId/presentations/:presentationId", async request => ({ presentation: await presentations.readPresentation(await context(request), params(request).presentationId!) }));
  app.patch("/organizations/:orgId/presentations/:presentationId/inputs", async request => {
    const body = changes.parse(request.body);
    return { presentation: await presentations.changePresentation(await context(request), params(request).presentationId!, body) };
  });
  app.post("/organizations/:orgId/presentations/:presentationId/evaluate", async request => {
    const body = z.object({ expectedRevision: revision, refresh: z.boolean().optional() }).strict().parse(request.body);
    return { presentation: await presentations.evaluatePresentation(await context(request), params(request).presentationId!, body) };
  });
  app.get("/organizations/:orgId/presentations/:presentationId/changes", async request => ({ changes: await presentations.presentationChanges(await context(request), params(request).presentationId!) }));
  app.post("/organizations/:orgId/presentations/:presentationId/contract", async request => {
    const body = z.object({ expectedRevision: revision, documentId: z.string().optional() }).strict().parse(request.body);
    return presentations.producePresentationContract(await context(request), params(request).presentationId!, body);
  });
  app.post("/organizations/:orgId/presentations/:presentationId/contract/send", async request => {
    const body = z.object({ expectedRevision: revision, documentId: z.string().optional(), recipients: z.array(recipient).max(50).optional(), consentContact: z.string().max(320).optional(), message: z.string().max(4000).optional(), includePdf: z.boolean().optional(), sharePresentation: z.boolean().optional() }).strict().parse(request.body);
    return presentations.sendPresentationContract(await context(request), params(request).presentationId!, body);
  });
  app.post("/organizations/:orgId/presentations/:presentationId/shares", async (request, reply) => {
    const body = z.object({ expectedRevision: revision, access: z.enum(["view", "choose"]).optional(), recipients: z.array(recipient).max(10).optional(), expiresAt: z.string().datetime().optional(), deliver: z.boolean().optional(), message: z.string().max(4000).optional(),
      contract: z.object({ mode: z.enum(["review", "direct"]).optional(), consentContact: z.string().max(320).optional(), includePdf: z.boolean().optional() }).strict().optional() }).strict().parse(request.body);
    privateResponse(reply);
    return reply.code(201).send(await presentations.sharePresentation(await context(request), params(request).presentationId!, body));
  });
  app.delete("/organizations/:orgId/presentations/:presentationId/shares/:shareId", async request => ({ presentation: await presentations.revokePresentationShare(await context(request), params(request).presentationId!, params(request).shareId!) }));

  // Token-only routes: the link is the credential, checked on every call.
  app.get("/public/presentations/:token", async (request, reply) => { privateResponse(reply); return { presentation: await presentations.publicPresentation(params(request).token!) }; });
  app.patch("/public/presentations/:token/inputs", async (request, reply) => {
    const body = changes.parse(request.body);
    privateResponse(reply);
    return { presentation: await presentations.publicPresentationChange(params(request).token!, body, audit(request)) };
  });
  app.post("/public/presentations/:token/submit", async (request, reply) => {
    const body = z.object({ expectedRevision: revision }).strict().parse(request.body);
    privateResponse(reply);
    return presentations.publicPresentationSubmit(params(request).token!, body, audit(request));
  });
}
