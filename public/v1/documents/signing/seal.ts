import { createHash, createPrivateKey, sign, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from "pdf-lib";
import { env } from "../../src/config/env.js";
import { OID, parse } from "./der.js";
import { buildSignedData, certHash, verifyChain, verifySignedData, type SignFunction } from "./cms.js";
import { createSealAuthority, pemBlocks } from "./seal-ca.js";
import { requestTimestamp, timestampAuthorities, verifyTimestampToken } from "./timestamp.js";
import { readSigningSetting, writeSigningSettingOnce } from "./store.js";

/**
 * Seals an executed agreement as a PAdES certification signature: the PDF is
 * signed with a document-sealing certificate, the signature is timestamped by
 * an outside authority, and any later change to the file breaks the seal.
 *
 * Where the key lives is the provider's business. `local` reads a PEM key and
 * chain from files (our own authority, or a purchased certificate whose key is
 * exportable); `development` keeps a generated authority in the signing store
 * on non-production hosts. A remote signer (a cloud HSM or a CSC API such as
 * SSL.com eSigner) is another provider returning the same chain and `sign`.
 */
export type Sealer = { provider: string; chain: Buffer[]; crls: Buffer[]; sign: SignFunction; anchors: X509Certificate[]; development: boolean };

const fileBlocks = (file: string | undefined, label: string) => file ? pemBlocks(readFileSync(file, "utf8"), label) : [];
const selfSigned = (der: Buffer) => { const c = new X509Certificate(der); return c.checkIssued(c) && c.verify(c.publicKey); };

let cached: { key: string; sealer: Promise<Sealer> } | null = null;
export function documentSealer(): Promise<Sealer> {
  const provider = process.env.DOCUMENT_SEAL_PROVIDER || (process.env.DOCUMENT_SEAL_KEY_FILE ? "local" : env.isProduction ? "" : "development");
  const key = [provider, process.env.DOCUMENT_SEAL_KEY_FILE, process.env.DOCUMENT_SEAL_CHAIN_FILE, process.env.DOCUMENT_SEAL_CRL_FILE, process.env.DOCUMENT_SEAL_TRUST_FILE, env.platformStorageRoot].join("|");
  if (cached?.key === key) return cached.sealer;
  const sealer = (async (): Promise<Sealer> => {
    const trusted = fileBlocks(process.env.DOCUMENT_SEAL_TRUST_FILE, "CERTIFICATE");
    if (provider === "local") {
      const privateKey = createPrivateKey(readFileSync(process.env.DOCUMENT_SEAL_KEY_FILE || "", "utf8"));
      const chain = fileBlocks(process.env.DOCUMENT_SEAL_CHAIN_FILE, "CERTIFICATE");
      if (!chain.length) throw new Error("document_seal_chain_missing");
      const anchors = [...trusted, ...chain.filter(selfSigned)].map(der => new X509Certificate(der));
      return { provider, chain, crls: fileBlocks(process.env.DOCUMENT_SEAL_CRL_FILE, "X509 CRL"), sign: async data => sign("sha256", data, privateKey), anchors, development: false };
    }
    if (provider === "development") {
      const authority = await developmentAuthority();
      const chain = [...pemBlocks(authority.sealCertPem, "CERTIFICATE"), ...pemBlocks(authority.rootCertPem, "CERTIFICATE")];
      const privateKey = createPrivateKey(authority.sealKeyPem);
      return { provider, chain, crls: pemBlocks(authority.crlPem, "X509 CRL"), sign: async data => sign("sha256", data, privateKey), anchors: [...trusted, chain[1]!].map(der => new X509Certificate(der)), development: true };
    }
    throw new Error(provider ? `document_seal_provider_unavailable (${provider})` : "document_seal_unconfigured");
  })();
  cached = { key, sealer };
  sealer.catch(() => { if (cached?.sealer === sealer) cached = null; });
  return sealer;
}
/** Generated once per environment and shared by every host through the signing store. */
async function developmentAuthority() {
  const existing = await readSigningSetting("development_seal_authority");
  if (existing) return existing as ReturnType<typeof createSealAuthority>;
  const created = createSealAuthority({ organization: "FirstMate", label: "FirstMate Development", crlUrl: `${env.publicBaseUrl}/v1/documents/public/seal/crl` });
  return (await writeSigningSettingOnce("development_seal_authority", created)) as ReturnType<typeof createSealAuthority>;
}
/** Roots a sealed PDF may chain to, including the development root where one exists. */
export async function sealTrustAnchors(): Promise<X509Certificate[]> {
  const anchors = [...fileBlocks(process.env.DOCUMENT_SEAL_TRUST_FILE, "CERTIFICATE").map(d => new X509Certificate(d))];
  try { anchors.push(...(await documentSealer()).anchors); } catch { /* verification still runs against configured roots */ }
  const dev = await readSigningSetting("development_seal_authority").catch(() => null);
  if (dev) anchors.push(...pemBlocks(String((dev as any).rootCertPem), "CERTIFICATE").map(d => new X509Certificate(d)));
  return anchors.filter((a, i) => anchors.findIndex(b => b.fingerprint256 === a.fingerprint256) === i);
}

const RANGE_PLACEHOLDER = 9999999999, CONTENTS_BYTES = 32768;
export type SealResult = { bytes: Buffer; sha256: string; signed_sha256: string; certificate_sha256: string; certificate_subject: string; provider: string; development: boolean; timestamp: { time: string; authority: string; serial: string } | null };

/** Adds a certification signature (DocMDP, no changes permitted) to `bytes`. */
export async function sealPdf(bytes: Buffer, options: { reason: string; name?: string; location?: string; contact?: string; requireTimestamp?: boolean }): Promise<SealResult> {
  const sealer = await documentSealer();
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const context = pdf.context, now = new Date();
  const sigDict = context.obj({
    Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "ETSI.CAdES.detached",
    ByteRange: [0, RANGE_PLACEHOLDER, RANGE_PLACEHOLDER, RANGE_PLACEHOLDER],
    Contents: PDFHexString.of("0".repeat(CONTENTS_BYTES * 2)),
    Reason: PDFString.of(options.reason), M: PDFString.fromDate(now),
    ...(options.name ? { Name: PDFString.of(options.name) } : {}), ...(options.location ? { Location: PDFString.of(options.location) } : {}), ...(options.contact ? { ContactInfo: PDFString.of(options.contact) } : {}),
    Reference: [{ Type: "SigRef", TransformMethod: "DocMDP", TransformParams: { Type: "TransformParams", P: 1, V: "1.2" } }]
  });
  const sigRef = context.register(sigDict);
  const page = pdf.getPage(0);
  const widgetRef = context.register(context.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig", Rect: [0, 0, 0, 0], V: sigRef, T: PDFString.of(`Seal ${now.toISOString()}`), F: 132, P: page.ref }));
  page.node.addAnnot(widgetRef);
  const form = pdf.catalog.getOrCreateAcroForm();
  form.dict.set(PDFName.of("SigFlags"), PDFNumber.of(3));
  form.addField(widgetRef);
  pdf.catalog.set(PDFName.of("Perms"), context.obj({ DocMDP: sigRef }));
  const prepared = Buffer.from(await pdf.save({ useObjectStreams: false, addDefaultPage: false }));

  const text = prepared.toString("latin1");
  const placeholder = `<${"0".repeat(CONTENTS_BYTES * 2)}>`;
  const start = text.indexOf(placeholder);
  if (start < 0 || text.indexOf(placeholder, start + 1) >= 0) throw new Error("document_seal_placeholder");
  const end = start + placeholder.length;
  const rangeText = `[ 0 ${RANGE_PLACEHOLDER} ${RANGE_PLACEHOLDER} ${RANGE_PLACEHOLDER} ]`, rangeAt = text.indexOf(rangeText);
  if (rangeAt < 0) throw new Error("document_seal_byte_range");
  const actual = `[ 0 ${start} ${end} ${prepared.length - end} ]`.padEnd(rangeText.length, " ");
  prepared.write(actual, rangeAt, "latin1");
  const signedBytes = Buffer.concat([prepared.subarray(0, start), prepared.subarray(end)]);
  const digest = createHash("sha256").update(signedBytes).digest();

  let timestamp: SealResult["timestamp"] = null;
  const { cms } = await buildSignedData({ digest, chain: sealer.chain, crls: sealer.crls, sign: sealer.sign, timestamp: async signature => {
    if (!timestampAuthorities().length) { if (options.requireTimestamp) throw new Error("timestamp_unconfigured"); return null; }
    const result = await requestTimestamp(signature);
    timestamp = { time: result.time, authority: result.authority, serial: result.serial };
    return result.token;
  } });
  const hex = cms.toString("hex");
  if (hex.length > CONTENTS_BYTES * 2) throw new Error("document_seal_too_large");
  prepared.write(hex.padEnd(CONTENTS_BYTES * 2, "0"), start + 1, "latin1");
  const leaf = new X509Certificate(sealer.chain[0]!);
  return { bytes: prepared, sha256: createHash("sha256").update(prepared).digest("hex"), signed_sha256: digest.toString("hex"), certificate_sha256: leaf.fingerprint256.replace(/:/g, "").toLowerCase(),
    certificate_subject: leaf.subject.replace(/\n/g, ", "), provider: sealer.provider, development: sealer.development, timestamp };
}

export type SealVerification = {
  sealed: boolean; intact: boolean; trusted: boolean; reason?: string; sha256: string;
  certificate?: { subject: string; issuer: string; sha256: string; development: boolean }; timestamp?: { time: string; authority: string } | null; certified?: boolean;
};
/** Checks a PDF's last signature covers the whole file, verifies, and chains to one of our roots. */
export async function verifySealedPdf(bytes: Buffer): Promise<SealVerification> {
  const sha256 = createHash("sha256").update(bytes).digest("hex"), text = bytes.toString("latin1");
  const ranges = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  if (!ranges.length) return { sealed: false, intact: false, trusted: false, reason: "No seal was found in this file.", sha256 };
  const [a, b, c, d] = ranges[ranges.length - 1]!.slice(1).map(Number) as [number, number, number, number];
  if (a !== 0 || b <= 0 || c <= b || c + d !== bytes.length || text[b] !== "<" || text[c - 1] !== ">") return { sealed: true, intact: false, trusted: false, reason: "The file was changed after it was sealed.", sha256 };
  try {
    const cms = parse(Buffer.from(text.slice(b + 1, c - 1), "hex")).bytes;
    const signed = verifySignedData(Buffer.from(cms), Buffer.concat([bytes.subarray(0, b), bytes.subarray(c)]));
    const essCert = signed.attributes.get(OID.signingCertificateV2);
    if (!essCert || !essCert.children[0]!.children[0]!.children.find(n => n.tag === 0x04)!.value.equals(certHash(Buffer.from(signed.signer.raw)))) throw new Error("seal_certificate_binding");
    const token = signed.unsigned.get(OID.timeStampToken);
    const stamp = token ? verifyTimestampToken(Buffer.from(token.bytes), signed.signature) : null;
    const anchors = await sealTrustAnchors();
    let trusted = true, root: X509Certificate | undefined;
    try { root = verifyChain(signed.signer, signed.certificates, anchors, stamp ? new Date(stamp.time) : new Date()).at(-1); } catch { trusted = false; }
    const dev = await readSigningSetting("development_seal_authority").catch(() => null);
    const development = !!(root && dev && pemBlocks(String((dev as any).rootCertPem), "CERTIFICATE").some(der => new X509Certificate(der).fingerprint256 === root!.fingerprint256));
    return { sealed: true, intact: true, trusted, sha256, certified: /\/DocMDP/.test(text),
      certificate: { subject: signed.signer.subject.replace(/\n/g, ", "), issuer: signed.signer.issuer.replace(/\n/g, ", "), sha256: signed.signer.fingerprint256.replace(/:/g, "").toLowerCase(), development },
      timestamp: stamp ? { time: stamp.time, authority: stamp.signer } : null, ...(trusted ? {} : { reason: "The seal is intact but was not made with a FirstMate certificate." }) };
  } catch (error) {
    return { sealed: true, intact: false, trusted: false, reason: "The seal does not match this file.", sha256 };
  }
}
