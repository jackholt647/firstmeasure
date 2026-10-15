import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who or what is making a change, carried with the work rather than passed through every writer.
 *
 * A request from a person's browser is a person. A published action run by an agent, an automation or a document
 * module says so where actions are invoked (platform/publication/actions.ts). A generator (a pay sheet pricing a work
 * order, a document's calculation, a scope building its lists) wraps its writes, so what it wrote is told apart from
 * what anyone did to it afterwards. An inner source keeps what the outer one said: a generation an agent started is a
 * generator run, and still names the agent's action. See docs/architecture/project-history.md.
 */
export type ChangeKind = "person" | "agent" | "automation" | "module" | "generator" | "system";
export type ChangeSource = {
  kind: ChangeKind;
  user_id?: string;
  /** The published action this happened inside, and its receipt. */
  action?: string;
  invocation_id?: string;
  /** A generator's id, its version (what it was configured with when it ran) and the run. */
  generator?: string;
  generator_version?: string;
  generation_id?: string;
  /** A tool in the interface that made the change for a person, such as Fix all. */
  tool?: string;
};

const sources = new AsyncLocalStorage<ChangeSource>();

export function withChangeSource<T>(source: Partial<ChangeSource>, run: () => Promise<T>): Promise<T> {
  const outer = sources.getStore();
  return sources.run({ ...(outer || { kind: "person" }), ...source } as ChangeSource, run);
}

/** The source of a change being made now. With nothing declared, a signed-in user is a person and anything else is the system. */
export function currentChangeSource(userId = ""): ChangeSource {
  const declared = sources.getStore();
  const user = String(declared?.user_id || userId || "").trim();
  if (declared) return { ...declared, ...(user ? { user_id: user } : {}) };
  return user ? { kind: "person", user_id: user } : { kind: "system" };
}

/** How a published action's caller is recorded. */
export function changeKindForExecution(kind: string): ChangeKind {
  return kind === "agent" ? "agent" : kind === "work" ? "automation" : kind === "module" ? "module" : "person";
}
