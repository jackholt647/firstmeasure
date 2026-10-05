import { contentHash } from "../platform/publication/validation.js";
import { db, list, save } from "./storage.js";
import { object, type Obj } from "./contracts.js";
/** Called at authoring boundaries, never on publication reads. References are declarations, not guessed code behavior. */
export async function indexConnectionUses(
  org: string,
  owner: string,
  value: Obj,
) {
  const found: Obj[] = [];
  function visit(node: any, path: string, depth: number, inherited: Obj = {}) {
    if (depth > 30 || !node || typeof node !== "object") return;
    const meta = {
      title: String(node.title || node.name || inherited.title || owner),
      description: String(
        node.description || node.explainer || inherited.description || "",
      ),
      events:
        node.events ||
        (node.event
          ? [node.event]
          : inherited.events?.length
            ? inherited.events
            : null) ||
        (path.includes("/automation_bindings/")
          ? [path.split("/automation_bindings/")[1]!.split("/")[0]]
          : []),
      conditions: node.conditions || inherited.conditions || {},
      enabled:
        inherited.enabled !== false &&
        node.enabled !== false &&
        !["archived", "canceled"].includes(node.status),
      projectId: node.project_id || node.projectId || inherited.projectId || "",
    };
    const bindings = object(node.bindings);
    const connectionIds = [
      ...new Set(
        Object.values(bindings)
          .map((b) => {
            const v = object(b);
            return String(
              v.kind === "data"
                ? object(v.source).provider
                : object(v.action).action,
            ).match(/^external\.(conn_[a-f0-9]+)(?:\.|$)/)?.[1];
          })
          .filter(Boolean),
      ),
    ];
    if (connectionIds.length)
      found.push({
        id: `use_${contentHash({ owner, path })}`,
        owner,
        path,
        connections: connectionIds,
        ...meta,
        source: String(node.source || ""),
        bindings,
        revision: contentHash({ node, meta }),
      });
    for (const [key, child] of Object.entries(node))
      if (key !== "bindings") visit(child, `${path}/${key}`, depth + 1, meta);
  }
  visit(value, "", 0);
  // A single owner record makes removals and republishing atomic.
  if (found.length) await save(org, "usage-owner", owner, { uses: found });
  else
    await db()
      .prepare(
        "DELETE FROM integration_objects WHERE organization_id=? AND kind=? AND id=?",
      )
      .run(org, "usage-owner", owner);
}
export async function connectionUses(org: string, key: string) {
  return (await list(org, "usage-owner"))
    .flatMap((x) => x.uses)
    .filter((u) => u.connections.includes(key));
}
