import type { PlatformAuthContext } from "../platform/auth.js";
import { list, save, id, requireObject, immutable } from "./storage.js";
import { manage, connection, definition, saveConnection } from "./service.js";
import { contentHash } from "../platform/publication/validation.js";
import { z } from "zod";
const builtins = [
  {
    id: "companycam",
    name: "CompanyCam",
    aliases: ["company cam"],
    domain: "companycam.com",
    connector: null,
    status: "guidance",
    verifiedAt: null,
    instructions:
      "Setup guidance only; no prebuilt connector is installed. Consult the current official CompanyCam developer documentation and the customer account settings to determine available API access and authentication. Ask which account and workflows they want connected. If a token is required, collect it only through the secure credential widget. Do not assume a specific settings menu or plan entitlement without verification.",
    documentation: ["https://docs.companycam.com/"],
    logo: null,
  },
  {
    id: "custom-api",
    name: "Custom API",
    aliases: ["rest", "json", "http"],
    domain: "",
    connector: null,
    status: "guidance",
    verifiedAt: null,
    instructions:
      "Ask for the API base URL, documentation or a redacted sample, desired data/actions and authentication method. Use public HTTPS only. Start with a read-only draft and a small preview. Flexible response schemas are permitted. Describe observed fields as observations. Configure paging, stable record identities, error handling and resource mapping from actual responses. Never request secrets in chat.",
    documentation: [],
    logo: null,
  },
];
export async function searchLibrary(org: string, query = "") {
  const q = query.toLowerCase();
  return [
    ...(await list(org, "connector-package")),
    ...(await list(org, "playbook")),
    ...builtins,
  ]
    .filter(
      (e) =>
        !q ||
        JSON.stringify([e.name, e.aliases, e.domain]).toLowerCase().includes(q),
    )
    .slice(0, 30);
}
/** Packages contain reviewed definitions, never credentials, grants or live account state. */
export async function savePackage(ctx: PlatformAuthContext, raw: unknown) {
  manage(ctx);
  const input = z
    .object({
      connectionId: z.string(),
      name: z.string().min(1).max(120),
      instructions: z.string().max(30000).default(""),
      aliases: z.array(z.string()).max(20).default([]),
    })
    .strict()
    .parse(raw);
  const c = await connection(ctx, input.connectionId),
    d = await definition(ctx.orgId, c, c.draftVersion);
  const version = contentHash(d),
    key = `package_${contentHash({ name: input.name, version })}`;
  await immutable(ctx.orgId, "package-version", `${key}:${version}`, {
    definition: d,
  });
  return save(ctx.orgId, "connector-package", key, {
    name: input.name,
    aliases: input.aliases,
    domain: new URL(d.baseUrl).hostname,
    instructions: input.instructions,
    connector: `${key}@${version}`,
    status: "connector",
    author: ctx.userId,
  });
}
export async function installPackage(
  ctx: PlatformAuthContext,
  reference: string,
) {
  manage(ctx);
  const [key, version, ...extra] = reference.split("@");
  if (!key || !version || extra.length)
    throw new Error("Choose a versioned connector package.");
  const pkg = await requireObject(
    ctx.orgId,
    "package-version",
    `${key}:${version}`,
  );
  return saveConnection(ctx, { definition: pkg.definition });
}
export async function savePlaybook(ctx: PlatformAuthContext, raw: unknown) {
  manage(ctx);
  const value = z
    .object({
      id: z.string().optional(),
      name: z.string().min(1).max(120),
      aliases: z.array(z.string()).max(20).default([]),
      domain: z.string().max(250).default(""),
      instructions: z.string().max(30000),
      documentation: z.array(z.string().url()).max(20).default([]),
      connector: z.string().nullable().default(null),
      expectedRevision: z.number().optional(),
    })
    .strict()
    .parse(raw);
  return save(
    ctx.orgId,
    "playbook",
    value.id || id("playbook"),
    {
      ...value,
      status: value.connector ? "connector" : "guidance",
      verifiedAt: null,
      author: ctx.userId,
    },
    value.expectedRevision,
  );
}
