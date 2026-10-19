/**
 * FirstMate's own document certificate authority (docs/architecture/document-signing.md, "Seal").
 *
 *   npx tsx scripts/document-seal-authority.ts create <dir> [--organization "FirstMate"] [--crl-url https://app.1m8.ai/v1/documents/public/seal/crl]
 *   npx tsx scripts/document-seal-authority.ts crl <dir> --number <n>
 *
 * `create` writes root-key.pem (keep offline; never copy it to a host), root.pem,
 * seal-key.pem, seal-chain.pem and crl.pem. Hosts get seal-key.pem, seal-chain.pem
 * and crl.pem through DOCUMENT_SEAL_KEY_FILE, DOCUMENT_SEAL_CHAIN_FILE and
 * DOCUMENT_SEAL_CRL_FILE. `crl` renews the revocation list before its yearly expiry.
 */
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { createSealAuthority, renewRevocationList } from "../documents/signing/seal-ca.js";

const [command, dir, ...rest] = process.argv.slice(2);
const option = (name: string) => { const at = rest.indexOf(`--${name}`); return at >= 0 ? rest[at + 1] : undefined; };
if (!dir || !["create", "crl"].includes(command || "")) { console.error("Usage: document-seal-authority.ts create|crl <dir> [options]"); process.exit(2); }
const file = (name: string) => path.join(dir, name);

if (command === "create") {
  if (await access(file("root-key.pem")).then(() => true, () => false)) { console.error(`${file("root-key.pem")} exists; refusing to replace an authority.`); process.exit(1); }
  await mkdir(dir, { recursive: true });
  const authority = createSealAuthority({ organization: option("organization") || "FirstMate", crlUrl: option("crl-url"), years: Number(option("years") || 3) });
  await writeFile(file("root-key.pem"), authority.rootKeyPem, { mode: 0o600 });
  await writeFile(file("root.pem"), authority.rootCertPem);
  await writeFile(file("seal-key.pem"), authority.sealKeyPem, { mode: 0o600 });
  await writeFile(file("seal-chain.pem"), authority.sealCertPem + authority.rootCertPem);
  await writeFile(file("crl.pem"), authority.crlPem);
  console.log(`Created the authority in ${dir}. Move root-key.pem offline; install seal-key.pem, seal-chain.pem and crl.pem on the hosts.`);
} else {
  const number = Number(option("number"));
  if (!Number.isSafeInteger(number) || number < 2) { console.error("--number must be the next CRL number (2 or more)."); process.exit(2); }
  await writeFile(file("crl.pem"), renewRevocationList(await readFile(file("root-key.pem"), "utf8"), await readFile(file("root.pem"), "utf8"), number));
  console.log(`Renewed ${file("crl.pem")}; install it on the hosts.`);
}
