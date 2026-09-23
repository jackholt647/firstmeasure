import type { PlatformAuthContext } from "../auth.js";

/** Public, serializable contracts. Domain objects and credentials never cross this boundary. */
export type JsonSchema = Record<string, unknown>;
export type ExecutionKind = "api" | "work" | "agent" | "module";
export type Effect = "read" | "compute" | "write" | "external";
export type TargetScope = "global" | "organization" | "project";
export type TargetRef = {
  scope: TargetScope;
  organizationId?: string;
  branchId?: string;
  projectId?: string;
  id?: string;
};

export type SystemGrant = Readonly<{
  kind: ExecutionKind;
  organizationId: string;
  projectId?: string;
  operations: readonly string[];
}>;

export type PublicationContext = {
  auth: PlatformAuthContext | null;
  organizationId: string;
  branchId?: string;
  projectId?: string;
  executionKind: ExecutionKind;
  mode: "evaluate" | "command";
  invocationId?: string;
  /** Internal derived-source authorization path; never accepted from client JSON. */
  dependencyPath?: readonly string[];
  /** Server-owned nesting limit for composed programmable consumers. */
  executionDepth?: number;
  /** Created only by trusted server code; never deserialize this from an HTTP/code payload. */
  system?: SystemGrant;
};

export type AccessPolicy = {
  scopes: readonly TargetScope[];
  /** Defaults to management, matching requirePlatformAuth. false must be intentional. */
  applications?: readonly string[] | false;
  applicationPermission?: string;
  /** Entries are ANDed; each entry supports the platform's existing pipe-separated OR syntax. */
  permissions: readonly string[];
  capabilities?: readonly string[];
  systemKinds?: readonly ExecutionKind[];
  /** Resource/subject access checks in addition to organization and feature permissions. */
  authorize?: (ctx: PublicationContext, target: TargetRef) => Promise<void> | void;
};

export type SourceRef = {
  provider: string;
  version?: string;
  export: string;
  target: TargetRef;
  args?: Record<string, unknown>;
  /** JSON pointer within the declared export, never a path into private domain storage. */
  path?: string;
  revision?: string;
};

export type SourceIdentity = SourceRef & { version: string; revision: string };
export type DataResult = {
  status: "ready";
  value: unknown;
  source: SourceIdentity;
  schemaVersion: string;
  capturedAt: string;
  provenance: Record<string, unknown>;
} | {
  status: "missing" | "pending" | "denied" | "error";
  code: string;
  message: string;
};

export type ActionRef = { action: string; version?: string; target: TargetRef };
export type InvocationOptions = {
  idempotencyKey?: string;
  expectedImplementation?: string;
};

export type BindingPolicy = "live" | "frozen";
export type DataBinding = { kind: "data"; policy: BindingPolicy; source: SourceRef; required?: boolean };
export type ActionBinding = { kind: "action"; policy: BindingPolicy; action: ActionRef };
export type CodeBinding = { kind: "code"; policy: BindingPolicy; moduleId: string; version?: string };
export type BindingDefinition = DataBinding | ActionBinding | CodeBinding;

export const objectSchema: JsonSchema = { type: "object", additionalProperties: true };
export const jsonValueSchema: JsonSchema = { type: ["object", "array", "string", "number", "boolean", "null"] };
