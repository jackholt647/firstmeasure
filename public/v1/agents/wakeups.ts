import { AsyncLocalStorage } from "node:async_hooks";
import { claimAgentWakeup, finishAgentWakeup, renewAgentWakeup } from "./storage.js";
import { asObject, cleanText, type JsonObject } from "./util.js";

const activeWakeup = new AsyncLocalStorage<() => void>();
export function assertAgentWakeupLease() { activeWakeup.getStore()?.(); }

/** Only pending jobs are executable. Interrupted provider/tool runs require review. */
export async function drainAgentWakeups(execute: (job: JsonObject) => Promise<void | "cancelled">, limit = 5, kind = "") {
  let handled = 0;
  for (; handled < limit; handled++) {
    const job = await claimAgentWakeup(120000, kind);
    if (!job) break;
    const id = cleanText(asObject(job).id), token = job.lease_owner;
    let valid = true;
    let renewal: Promise<void> | undefined;
    const check = () => { if (!valid) throw new Error("The scheduled agent's worker lease was lost."); };
    const timer = setInterval(() => {
      if (renewal) return;
      renewal = renewAgentWakeup(id, token).then(ok => { valid = ok; }).catch(() => { valid = false; }).finally(() => { renewal = undefined; });
    }, 30000);
    timer.unref();
    try {
      const outcome = await activeWakeup.run(check, () => execute(asObject(job)));
      check();
      await finishAgentWakeup(id, token, outcome === "cancelled" ? "cancelled" : "succeeded");
    } catch (error) {
      await finishAgentWakeup(id, token, [401, 403, 404].includes(Number((error as { statusCode?: number }).statusCode)) ? "cancelled" : "uncertain", error instanceof Error ? error.message : String(error));
    } finally { clearInterval(timer); await renewal; }
  }
  return handled;
}
