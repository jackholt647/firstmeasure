import type { FastifyInstance } from "fastify";
import { requirePlatformAuth } from "../platform/auth.js";
import { userPublicationContext } from "../platform/publication/context.js";
import { readMaterialsLedger, materialsCommand } from "./calculus.js";

export function registerCalculusApi(app: FastifyInstance) {
  const route = "/organizations/:orgId/projects/:projectId/calculus";
  app.get(route, async request => {
    const { orgId, projectId } = request.params as { orgId: string; projectId: string };
    const auth = await requirePlatformAuth(request, { orgId, permission: "view_materials" });
    return { ledger: await readMaterialsLedger(userPublicationContext(auth, { projectId }), projectId) };
  });
  app.post(`${route}/commands`, async request => {
    const { orgId, projectId } = request.params as { orgId: string; projectId: string };
    const auth = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    return materialsCommand(userPublicationContext(auth, { projectId }), projectId, request.body);
  });
}
