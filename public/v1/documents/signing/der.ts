/**
 * The small part of ASN.1 DER that sealing needs: building certificates, CMS
 * signatures and RFC 3161 requests, and reading them back. Node's crypto signs
 * and verifies; this only lays out and parses the bytes.
 */
export type Der = Buffer;
export type Node = { tag: number; header: number; length: number; bytes: Buffer; value: Buffer; children: Node[] };

function length(n: number) {
  if (n < 0x80) return Buffer.from([n]);
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return Buffer.from([0x80 | out.length, ...out]);
}
export const tlv = (tag: number, value: Buffer): Der => Buffer.concat([Buffer.from([tag]), length(value.length), value]);
export const seq = (...items: Der[]) => tlv(0x30, Buffer.concat(items));
/** DER orders SET OF members by their encodings. */
export const set = (...items: Der[]) => tlv(0x31, Buffer.concat([...items].sort(Buffer.compare)));
export const explicit = (n: number, inner: Der) => tlv(0xa0 + n, inner);
export const implicitConstructed = (n: number, content: Buffer) => tlv(0xa0 + n, content);
export const nul = () => Buffer.from([0x05, 0x00]);
export const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
export const octets = (v: Buffer) => tlv(0x04, v);
export const utf8 = (v: string) => tlv(0x0c, Buffer.from(v, "utf8"));
export const bits = (v: Buffer, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), v]));
export function integer(v: number | bigint | Buffer): Der {
  let bytes: Buffer;
  if (Buffer.isBuffer(v)) bytes = v;
  else {
    let hex = BigInt(v).toString(16); if (hex.length % 2) hex = "0" + hex;
    bytes = Buffer.from(hex, "hex");
  }
  let i = 0; while (i < bytes.length - 1 && bytes[i] === 0 && !(bytes[i + 1]! & 0x80)) i++;
  bytes = bytes.subarray(i);
  if (bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}
export function oid(dotted: string): Der {
  const parts = dotted.split(".").map(Number), out = [parts[0]! * 40 + parts[1]!];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
/** X.509 validity: UTCTime through 2049, GeneralizedTime after. */
export function time(d: Date): Der {
  const y = d.getUTCFullYear(), rest = `${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return y < 2050 ? tlv(0x17, Buffer.from(`${pad(y % 100)}${rest}`)) : tlv(0x18, Buffer.from(`${y}${rest}`));
}
export const generalizedTime = (d: Date) => tlv(0x18, Buffer.from(`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`));
export const algorithm = (id: string, params: Der | null = nul()) => params ? seq(oid(id), params) : seq(oid(id));
export function name(attrs: Array<[string, string]>): Der {
  return seq(...attrs.map(([type, value]) => set(seq(oid(type), utf8(value)))));
}

export function parse(bytes: Buffer, offset = 0): Node {
  const tag = bytes[offset]!;
  let len = bytes[offset + 1]!, header = 2;
  if (len === undefined) throw new Error("der_truncated");
  if (len & 0x80) {
    const count = len & 0x7f; if (count < 1 || count > 4) throw new Error("der_length");
    len = 0; for (let i = 0; i < count; i++) len = len * 256 + bytes[offset + 2 + i]!;
    header += count;
  }
  if (offset + header + len > bytes.length) throw new Error("der_truncated");
  const node: Node = { tag, header, length: len, bytes: bytes.subarray(offset, offset + header + len), value: bytes.subarray(offset + header, offset + header + len), children: [] };
  if (tag & 0x20) for (let at = 0; at < len;) { const child = parse(node.value, at); node.children.push(child); at += child.bytes.length; }
  return node;
}
export function oidString(node: Node): string {
  const v = node.value, out = [Math.floor(v[0]! / 40), v[0]! % 40];
  let acc = 0;
  for (const byte of v.subarray(1)) { acc = acc * 128 + (byte & 0x7f); if (!(byte & 0x80)) { out.push(acc); acc = 0; } }
  return out.join(".");
}
export function timeValue(node: Node): Date {
  const s = node.value.toString("latin1");
  const m = node.tag === 0x17 ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s) : /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(?:\.(\d+))?Z$/.exec(s);
  if (!m) throw new Error("der_time");
  const year = node.tag === 0x17 ? (Number(m[1]) < 50 ? 2000 : 1900) + Number(m[1]) : Number(m[1]);
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), m[7] ? Number(`0.${m[7]}`) * 1000 : 0));
}
export const OID = {
  rsaEncryption: "1.2.840.113549.1.1.1", sha256WithRSA: "1.2.840.113549.1.1.11", sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2", sha512: "2.16.840.1.101.3.4.2.3", sha1: "1.3.14.3.2.26",
  data: "1.2.840.113549.1.7.1", signedData: "1.2.840.113549.1.7.2", contentType: "1.2.840.113549.1.9.3", messageDigest: "1.2.840.113549.1.9.4",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47", timeStampToken: "1.2.840.113549.1.9.16.2.14", tstInfo: "1.2.840.113549.1.9.16.1.4",
  revocationInfoArchival: "1.2.840.113583.1.1.8",
  commonName: "2.5.4.3", organization: "2.5.4.10", organizationalUnit: "2.5.4.11", country: "2.5.4.6",
  basicConstraints: "2.5.29.19", keyUsage: "2.5.29.15", extKeyUsage: "2.5.29.37", subjectKeyId: "2.5.29.14", authorityKeyId: "2.5.29.35", crlNumber: "2.5.29.20",
  documentSigning: "1.3.6.1.4.1.311.10.3.12", adobeAuthenticDocuments: "1.2.840.113583.1.1.5", timeStamping: "1.3.6.1.5.5.7.3.8"
};
export const hashOids: Record<string, string> = { [OID.sha256]: "sha256", [OID.sha384]: "sha384", [OID.sha512]: "sha512", [OID.sha1]: "sha1" };
