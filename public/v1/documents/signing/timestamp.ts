import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { OID, algorithm, bool, hashOids, integer, octets, oidString, parse, seq, timeValue } from "./der.js";
import { pemBlocks } from "./seal-ca.js";
import { verifyChain, verifySignedData } from "./cms.js";

/**
 * RFC 3161 timestamps from an outside authority: proof of when a seal (or the
 * signing ledger's head) existed that does not rest on our own clock.
 */
export type TimestampResult = { token: Buffer; time: string; authority: string; serial: string };

export function timestampAuthorities(): string[] {
  const configured = process.env.DOCUMENT_TIMESTAMP_URLS;
  if (configured !== undefined) return configured.split(",").map(s => s.trim()).filter(s => s && s !== "off");
  // Tests run offline unless they point at their own authority.
  const env = (process.env.FIRSTMATE_ENV ?? process.env.APP_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
  return env === "test" ? [] : ["http://timestamp.digicert.com", "http://ts.ssl.com"];
}
/** Node's bundled Mozilla roots, which every public timestamp authority chains to. */
let systemRoots: X509Certificate[] | null = null;
export function timestampAnchors(): X509Certificate[] {
  const extra = process.env.DOCUMENT_TIMESTAMP_TRUST_FILE ? pemBlocks(readFileSync(process.env.DOCUMENT_TIMESTAMP_TRUST_FILE, "utf8"), "CERTIFICATE").map(der => new X509Certificate(der)) : [];
  systemRoots ||= rootCertificates.map(p => new X509Certificate(p));
  return [...systemRoots, ...extra];
}

/** Checks a token covers `hash` and is signed by a trusted timestamping certificate. */
export function verifyTimestampToken(token: Buffer, data: Buffer, nonce?: Buffer) {
  const signed = verifySignedData(token);
  if (signed.contentType !== OID.tstInfo || !signed.content) throw new Error("timestamp_not_tst_info");
  const tst = parse(signed.content);
  const imprint = tst.children[2]!, hashAlgorithm = hashOids[oidString(imprint.children[0]!.children[0]!)];
  if (!hashAlgorithm || !imprint.children[1]!.value.equals(createHash(hashAlgorithm).update(data).digest())) throw new Error("timestamp_imprint_mismatch");
  const serial = tst.children[3]!.value.toString("hex"), time = timeValue(tst.children[4]!);
  if (nonce) {
    const found = tst.children.slice(5).find(c => c.tag === 0x02);
    if (!found || !found.value.equals(parse(integer(nonce)).value)) throw new Error("timestamp_nonce_mismatch");
  }
  if (!/1\.3\.6\.1\.5\.5\.7\.3\.8/.test(signed.signer.keyUsage?.join(",") || "")) throw new Error("timestamp_certificate_usage");
  verifyChain(signed.signer, signed.certificates, timestampAnchors(), time);
  return { time: time.toISOString(), serial, signer: signed.signer.subject.replace(/\n/g, ", ") };
}

/** Asks each configured authority in turn; the first verified token wins. */
export async function requestTimestamp(data: Buffer, urls = timestampAuthorities()): Promise<TimestampResult> {
  if (!urls.length) throw new Error("timestamp_unconfigured");
  const errors: string[] = [];
  for (const url of urls) {
    const nonce = randomBytes(8);
    const request = seq(integer(1), seq(algorithm(OID.sha256), octets(createHash("sha256").update(data).digest())), integer(nonce), bool(true));
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/timestamp-query", accept: "application/timestamp-reply" }, body: new Uint8Array(request), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const reply = parse(Buffer.from(await response.arrayBuffer()));
      const status = Number(reply.children[0]!.children[0]!.value.readUIntBE(0, reply.children[0]!.children[0]!.value.length));
      if (status > 1 || !reply.children[1]) throw new Error(`status ${status}`);
      const token = Buffer.from(reply.children[1].bytes);
      const verified = verifyTimestampToken(token, data, nonce);
      return { token, time: verified.time, authority: url, serial: verified.serial };
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`timestamp_failed (${errors.join("; ")})`);
}
