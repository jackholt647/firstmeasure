import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import { OID, algorithm, bits, bool, explicit, integer, name, octets, oid, oidString, parse, seq, time, tlv } from "./der.js";

/**
 * FirstMate's own document certificate authority: an offline root that issues
 * the sealing certificate and its revocation list. The same chain layout is
 * what a commercial (Adobe-trusted) certificate provides, so the sealer does
 * not care which one it holds.
 */
export type IssuedCertificate = { der: Buffer; key?: KeyObject };
const sha256WithRsa = () => algorithm(OID.sha256WithRSA);
const spki = (key: KeyObject) => (key.type === "public" ? key : createPublicKey(key)).export({ type: "spki", format: "der" }) as Buffer;
/** RFC 5280 method 1: SHA-1 of the subject public key bits. */
export function keyIdentifier(publicKey: KeyObject) {
  const info = parse(spki(publicKey));
  return createHash("sha1").update(info.children[1]!.value.subarray(1)).digest();
}
const extension = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

export function issueCertificate(input: {
  subject: Array<[string, string]>; issuer: Array<[string, string]>; publicKey: KeyObject; issuerKey: KeyObject; issuerPublicKey: KeyObject;
  notBefore: Date; notAfter: Date; ca: boolean; pathLength?: number; usage: "ca" | "seal" | "timestamp"; crlUrl?: string;
}): Buffer {
  const serial = Buffer.concat([Buffer.from([0x40 | (randomBytes(1)[0]! & 0x3f)]), randomBytes(15)]);
  const keyUsage = input.usage === "ca" ? bits(Buffer.from([0x06]), 1) : bits(Buffer.from([0xc0]), 6);
  const extensions = [
    extension(OID.basicConstraints, true, input.ca ? seq(bool(true), ...(input.pathLength !== undefined ? [integer(input.pathLength)] : [])) : seq()),
    extension(OID.keyUsage, true, keyUsage),
    extension(OID.subjectKeyId, false, octets(keyIdentifier(input.publicKey))),
    extension(OID.authorityKeyId, false, seq(Buffer.concat([Buffer.from([0x80, 20]), keyIdentifier(input.issuerPublicKey)]))),
    ...(input.usage === "seal" ? [extension(OID.extKeyUsage, false, seq(oid(OID.documentSigning), oid(OID.adobeAuthenticDocuments)))] : []),
    ...(input.usage === "timestamp" ? [extension(OID.extKeyUsage, true, seq(oid(OID.timeStamping)))] : []),
    // CRL distribution point: fullName URI, so a PDF reader can refresh revocation.
    ...(input.crlUrl ? [extension("2.5.29.31", false, seq(seq(explicit(0, explicit(0, tlv(0x86, Buffer.from(input.crlUrl)))))))] : [])
  ];
  const tbs = seq(explicit(0, integer(2)), integer(serial), sha256WithRsa(), name(input.issuer), seq(time(input.notBefore), time(input.notAfter)), name(input.subject), spki(input.publicKey), explicit(3, seq(...extensions)));
  return seq(tbs, sha256WithRsa(), bits(sign("sha256", tbs, input.issuerKey)));
}

export function issueRevocationList(input: { issuer: Array<[string, string]>; issuerKey: KeyObject; issuerPublicKey: KeyObject; thisUpdate: Date; nextUpdate: Date; number: number; revoked?: Array<{ serial: Buffer; at: Date }> }) {
  const revoked = input.revoked?.length ? [seq(...input.revoked.map(r => seq(integer(r.serial), time(r.at))))] : [];
  const tbs = seq(integer(1), sha256WithRsa(), name(input.issuer), time(input.thisUpdate), time(input.nextUpdate), ...revoked,
    explicit(0, seq(extension(OID.authorityKeyId, false, seq(Buffer.concat([Buffer.from([0x80, 20]), keyIdentifier(input.issuerPublicKey)]))), extension(OID.crlNumber, false, integer(input.number)))));
  return seq(tbs, sha256WithRsa(), bits(sign("sha256", tbs, input.issuerKey)));
}

export const pem = (label: string, der: Buffer) => `-----BEGIN ${label}-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END ${label}-----\n`;
export function pemBlocks(text: string, label: string) {
  return [...text.matchAll(new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`, "g"))].map(m => Buffer.from(m[1]!.replace(/\s+/g, ""), "base64"));
}

export type SealAuthority = { rootKeyPem: string; rootCertPem: string; sealKeyPem: string; sealCertPem: string; crlPem: string };
/**
 * A two-level authority. The root key belongs offline (only the CLI needs it
 * again, to renew the CRL or issue the next sealing certificate).
 */
export function createSealAuthority(options: { organization: string; label?: string; years?: number; crlUrl?: string; now?: Date } ) {
  const now = options.now || new Date(), years = options.years || 3;
  const root = generateKeyPairSync("rsa", { modulusLength: 4096 }), seal = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const rootName: Array<[string, string]> = [[OID.country, "US"], [OID.organization, options.organization], [OID.commonName, `${options.label || options.organization} Document Root CA`]];
  const sealName: Array<[string, string]> = [[OID.country, "US"], [OID.organization, options.organization], [OID.organizationalUnit, "Document Sealing"], [OID.commonName, `${options.label || options.organization} Document Seal`]];
  const backdate = new Date(now.getTime() - 3600_000);
  const rootDer = issueCertificate({ subject: rootName, issuer: rootName, publicKey: root.publicKey, issuerKey: root.privateKey, issuerPublicKey: root.publicKey, notBefore: backdate, notAfter: new Date(Date.UTC(now.getUTCFullYear() + 20, now.getUTCMonth(), now.getUTCDate())), ca: true, pathLength: 0, usage: "ca" });
  const sealDer = issueCertificate({ subject: sealName, issuer: rootName, publicKey: seal.publicKey, issuerKey: root.privateKey, issuerPublicKey: root.publicKey, notBefore: backdate, notAfter: new Date(Date.UTC(now.getUTCFullYear() + years, now.getUTCMonth(), now.getUTCDate())), ca: false, usage: "seal", crlUrl: options.crlUrl });
  const crl = issueRevocationList({ issuer: rootName, issuerKey: root.privateKey, issuerPublicKey: root.publicKey, thisUpdate: backdate, nextUpdate: new Date(now.getTime() + 400 * 86400_000), number: 1 });
  return {
    rootKeyPem: root.privateKey.export({ type: "pkcs8", format: "pem" }) as string, rootCertPem: pem("CERTIFICATE", rootDer),
    sealKeyPem: seal.privateKey.export({ type: "pkcs8", format: "pem" }) as string, sealCertPem: pem("CERTIFICATE", sealDer), crlPem: pem("X509 CRL", crl)
  } satisfies SealAuthority;
}
/** A fresh CRL from the offline root, for the yearly renewal. */
export function renewRevocationList(rootKeyPem: string, rootCertPem: string, number: number, revoked: Array<{ serial: Buffer; at: Date }> = []) {
  const cert = new X509Certificate(rootCertPem), key = createPrivateKey(rootKeyPem);
  const issuer = parse(cert.raw).children[0]!.children[5]!;
  const attrs = issuer.children.map(rdn => { const at = rdn.children[0]!; return [oidString(at.children[0]!), at.children[1]!.value.toString("utf8")] as [string, string]; });
  const now = new Date();
  return pem("X509 CRL", issueRevocationList({ issuer: attrs, issuerKey: key, issuerPublicKey: cert.publicKey, thisUpdate: new Date(now.getTime() - 3600_000), nextUpdate: new Date(now.getTime() + 400 * 86400_000), number, revoked }));
}
