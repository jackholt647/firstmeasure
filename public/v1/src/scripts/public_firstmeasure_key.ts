import { createOrganization, readOrganization } from "../../platform/storage.js";
import {
  createPublicFirstMeasureApiKey,
  listPublicFirstMeasureApiKeys,
  revokePublicFirstMeasureApiKey,
  type PublicFirstMeasureScope
} from "../../public-firstmeasure/keys.js";
import { cleanText } from "../../public-firstmeasure/util.js";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]) {
  const args: Args = {};
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return { command: positional[0] ?? "help", args };
}

function argString(args: Args, key: string, fallback = "") {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

async function ensureTestOrg(orgId: string) {
  let organization;
  try {
    organization = await readOrganization(orgId);
  } catch {
    organization = await createOrganization({
      id: orgId,
      name: "Public FirstMeasure API Test Organization",
      global: {
        credits_balance: 0,
        credits_ledger: [],
        billing: {
          stripe: {
            has_payment_method: false
          },
          auto_topup: {
            enabled: false,
            threshold_dollars: 50,
            topup_dollars: 100,
            cooldown_minutes: 0,
            status: "idle"
          }
        }
      }
    });
  }
  return organization;
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (command === "help" || command === "--help") {
    console.log([
      "Usage:",
      "  npm run public:firstmeasure:key -- create --org <org_id> --name \"Partner\" [--mode test|live]",
      "  npm run public:firstmeasure:key -- list --org <org_id>",
      "  npm run public:firstmeasure:key -- revoke --key-id <key_id>",
      "  npm run public:firstmeasure:key -- create-test --org public_firstmeasure_test",
      "",
      "The full API key is printed only once when created."
    ].join("\n"));
    return;
  }

  if (command === "create-test") {
    const orgId = argString(args, "org", "public_firstmeasure_test");
    await ensureTestOrg(orgId);
    const created = await createPublicFirstMeasureApiKey({
      orgId,
      name: argString(args, "name", "Public FirstMeasure Test App"),
      mode: "test",
      createdBy: argString(args, "created-by", "local-script"),
      requireBilling: false
    });
    console.log(JSON.stringify({
      api_key: created.key,
      key_id: created.record.key_id,
      org_id: created.record.org_id,
      key_prefix: created.record.key_prefix,
      last4: created.record.last4
    }, null, 2));
    return;
  }

  if (command === "create") {
    const orgId = argString(args, "org");
    if (!orgId) throw new Error("--org is required.");
    const scopesText = argString(args, "scopes");
    const scopes = scopesText
      ? scopesText.split(",").map((scope) => scope.trim()).filter(Boolean) as PublicFirstMeasureScope[]
      : undefined;
    const created = await createPublicFirstMeasureApiKey({
      orgId,
      name: argString(args, "name", "FirstMeasure API key"),
      mode: argString(args, "mode", "live") === "test" ? "test" : "live",
      createdBy: argString(args, "created-by", "local-script"),
      scopes,
      requireBilling: args["skip-billing-check"] !== true
    });
    console.log(JSON.stringify({
      api_key: created.key,
      key_id: created.record.key_id,
      org_id: created.record.org_id,
      key_prefix: created.record.key_prefix,
      last4: created.record.last4
    }, null, 2));
    return;
  }

  if (command === "list") {
    const records = await listPublicFirstMeasureApiKeys(argString(args, "org") || undefined);
    console.log(JSON.stringify(records.map((record) => ({
      key_id: record.key_id,
      org_id: record.org_id,
      name: record.name,
      mode: record.mode,
      status: record.status,
      key_prefix: record.key_prefix,
      last4: record.last4,
      scopes: record.scopes,
      created_at: record.created_at,
      last_used_at: record.last_used_at,
      revoked_at: record.revoked_at
    })), null, 2));
    return;
  }

  if (command === "revoke") {
    const keyId = argString(args, "key-id");
    if (!keyId) throw new Error("--key-id is required.");
    const record = await revokePublicFirstMeasureApiKey(keyId);
    console.log(JSON.stringify({
      key_id: record.key_id,
      org_id: record.org_id,
      status: record.status,
      revoked_at: record.revoked_at
    }, null, 2));
    return;
  }

  throw new Error(`Unknown command '${command}'.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
