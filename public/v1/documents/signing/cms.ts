import { createHash, verify, X509Certificate } from "node:crypto";
import { OID, algorithm, explicit, hashOids, implicitConstructed, integer, octets, oid, oidString, parse, seq, set, tlv, type Node } from "./der.js";

/**
 * CMS SignedData (RFC 5652) for PDF seals and RFC 3161 timestamp tokens:
 * building a detached CAdES signature and verifying either kind.
 */
export type SignFunction = (data: Buffer) => Promise<Buffer>;
const attribute = (type: string, ...values: Buffer[]) => seq(oid(type), set(...values));
export const certHash = (der: Buffer) => createHash("sha256").update(der).digest();

function issuerAndSerial(certDer: Buffer) {
  const tbs = parse(certDer).children[0]!;
  return seq(tbs.children[3]!.bytes, tbs.children[1]!.bytes);
}

/** A detached CAdES-BES signature over `digest` (SHA-256 of the signed bytes). */
export async function buildSignedData(input: { digest: Buffer; chain: Buffer[]; crls: Buffer[]; sign: SignFunction; timestamp?: (signature: Buffer) => Promise<Buffer | null> }) {
  const leaf = input.chain[0]!;
  const attrs = [
    attribute(OID.contentType, oid(OID.data)),
    attribute(OID.messageDigest, octets(input.digest)),
    attribute(OID.signingCertificateV2, seq(seq(seq(octets(certHash(leaf)))))),
    ...(input.crls.length ? [attribute(OID.revocationInfoArchival, seq(explicit(0, seq(...input.crls))))] : [])
  ];
  const signedAttrs = set(...attrs);
  const signature = await input.sign(signedAttrs);
  const token = input.timestamp ? await input.timestamp(signature) : null;
  const signerInfo = seq(integer(1), issuerAndSerial(leaf), algorithm(OID.sha256), tlv(0xa0, parse(signedAttrs).value), algorithm(OID.rsaEncryption), octets(signature),
    ...(token ? [implicitConstructed(1, attribute(OID.timeStampToken, token))] : []));
  const signedData = seq(integer(1), set(algorithm(OID.sha256)), seq(oid(OID.data)), implicitConstructed(0, Buffer.concat(input.chain)), set(signerInfo));
  return { cms: seq(oid(OID.signedData), explicit(0, signedData)), signature, timestampToken: token };
}

export type VerifiedSignedData = {
  signer: X509Certificate; certificates: X509Certificate[]; signature: Buffer; digestAlgorithm: string;
  attributes: Map<string, Node>; unsigned: Map<string, Node>; content: Buffer | null; contentType: string; crls: Buffer[];
};
/** Verifies the signer's signature over its signed attributes and the content digest. */
export function verifySignedData(contentInfoDer: Buffer, detached?: Buffer): VerifiedSignedData {
  const info = parse(contentInfoDer);
  if (oidString(info.children[0]!) !== OID.signedData) throw new Error("cms_not_signed_data");
  const sd = info.children[1]!.children[0]!;
  let at = 2;
  const encap = sd.children[at++]!, contentType = oidString(encap.children[0]!);
  const content = encap.children[1] ? encap.children[1].children[0]!.value : null;
  const certificates: X509Certificate[] = [], crls: Buffer[] = [];
  while (sd.children[at] && sd.children[at]!.tag === 0xa0) { for (const c of sd.children[at]!.children) if (c.tag === 0x30) certificates.push(new X509Certificate(c.bytes)); at++; }
  while (sd.children[at] && sd.children[at]!.tag === 0xa1) { for (const c of sd.children[at]!.children) crls.push(c.bytes); at++; }
  const signers = sd.children[at]!;
  if (signers.children.length !== 1) throw new Error("cms_signer_count");
  const si = signers.children[0]!;
  let i = 1;
  const sid = si.children[i++]!, digestAlgorithm = hashOids[oidString(si.children[i++]!.children[0]!)];
  if (!digestAlgorithm) throw new Error("cms_digest_algorithm");
  const attributes = new Map<string, Node>(), unsigned = new Map<string, Node>();
  let signedAttrBytes: Buffer | null = null;
  if (si.children[i]!.tag === 0xa0) { signedAttrBytes = Buffer.concat([Buffer.from([0x31]), si.children[i]!.bytes.subarray(1)]); for (const a of si.children[i]!.children) attributes.set(oidString(a.children[0]!), a.children[1]!.children[0]!); i++; }
  const sigAlg = oidString(si.children[i++]!.children[0]!), signature = si.children[i++]!.value;
  if (si.children[i]?.tag === 0xa1) for (const a of si.children[i]!.children) unsigned.set(oidString(a.children[0]!), a.children[1]!.children[0]!);
  const signer = certificates.find(cert => {
    if (sid.tag === 0x30) { const tbs = parse(cert.raw).children[0]!; return tbs.children[3]!.bytes.equals(sid.children[0]!.bytes) && tbs.children[1]!.value.equals(sid.children[1]!.value); }
    return false;
  }) || certificates.find(cert => sid.tag === 0x80 && createHash("sha1").update(parse(parse(cert.raw).children[0]!.children[6]!.bytes).children[1]!.value.subarray(1)).digest().equals(sid.value));
  if (!signer) throw new Error("cms_signer_certificate_missing");
  const body = detached ?? content;
  if (!body) throw new Error("cms_content_missing");
  const contentDigest = createHash(digestAlgorithm).update(body).digest();
  if (signedAttrBytes) {
    const md = attributes.get(OID.messageDigest);
    if (!md || !md.value.equals(contentDigest)) throw new Error("cms_digest_mismatch");
    const ct = attributes.get(OID.contentType);
    if (!ct || oidString(ct) !== contentType) throw new Error("cms_content_type_mismatch");
  }
  if (![OID.rsaEncryption, OID.sha256WithRSA, "1.2.840.113549.1.1.12", "1.2.840.113549.1.1.13", "1.2.840.10045.4.3.2", "1.2.840.10045.4.3.3", "1.2.840.10045.2.1"].includes(sigAlg)) throw new Error("cms_signature_algorithm");
  if (!verify(digestAlgorithm, signedAttrBytes || body, signer.publicKey, signature)) throw new Error("cms_signature_invalid");
  return { signer, certificates, signature, digestAlgorithm, attributes, unsigned, content, contentType, crls };
}

/** Builds a path from `leaf` to one of `anchors`, every certificate valid at `at`. */
export function verifyChain(leaf: X509Certificate, pool: X509Certificate[], anchors: X509Certificate[], at: Date) {
  const valid = (c: X509Certificate) => Date.parse(c.validFrom) <= at.getTime() && at.getTime() <= Date.parse(c.validTo);
  const path = [leaf];
  for (let current = leaf, depth = 0; depth < 6; depth++) {
    if (!valid(current)) throw new Error("certificate_not_valid_at_time");
    const anchor = anchors.find(a => a.fingerprint256 === current.fingerprint256 || (current.checkIssued(a) && current.verify(a.publicKey)));
    if (anchor) { if (anchor.fingerprint256 !== current.fingerprint256) path.push(anchor); return path; }
    const next = pool.find(c => c.fingerprint256 !== current.fingerprint256 && current.checkIssued(c) && current.verify(c.publicKey) && c.ca);
    if (!next) throw new Error("certificate_untrusted");
    path.push(next); current = next;
  }
  throw new Error("certificate_chain_too_long");
}
