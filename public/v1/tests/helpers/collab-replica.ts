import Fastify from "fastify";
import * as hub from "../../documents/collab/service.js";
import { closePostgresPools } from "../../src/database/postgres.js";

const app = Fastify({ logger: false });
const org = process.env.TEST_COLLAB_ORG!;
app.get("/stream", async (request, reply) => {
  await hub.attachCollabStream(request, reply, { orgId: org, docId: "document", actor: { id: "viewer", name: "Viewer", email: "" } });
});
await app.listen({ host: "127.0.0.1", port: 0 });
process.on("message", async (message: { id: number; operation: string; actor?: string; revision?: number }) => {
  try {
    const actor = { id: message.actor || "author", name: message.actor || "Author", email: "" };
    const value = message.operation === "append"
      ? await hub.appendCollabCommands(org, "document", actor, { base_revision: message.revision || 0, commands: [{ text: "Shared edit" }] })
      : message.operation === "presence" ? await hub.updateCollabPresence(org, "document", actor, { cursor: { block_id: actor.id } })
      : await hub.collabHello(org, "document");
    process.send!({ id: message.id, value });
  } catch (error) { process.send!({ id: message.id, error: String(error) }); }
});
process.on("disconnect", async () => { await hub.resetCollabForTests(); await app.close(); await closePostgresPools(); process.exit(); });
process.send!({ ready: true, address: app.server.address() });
