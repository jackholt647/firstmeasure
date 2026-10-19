import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { OID, algorithm, explicit, generalizedTime, implicitConstructed, integer, octets, oid, parse, seq, set, tlv } from "../../documents/signing/der.js";
import { issueCertificate, pem } from "../../documents/signing/seal-ca.js";

/** An RFC 3161 authority on localhost, for tests that must not reach the internet. */
export async function startTestTimestampAuthority(options: { clock?: () => Date } = {}) {
  const root = generateKeyPairSync("rsa", { modulusLength: 2048 }), tsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rootName: Array<[string, string]> = [[OID.organization, "Test TSA"], [OID.commonName, "Test TSA Root"]];
  const now = new Date(), notBefore = new Date(now.getTime() - 86400_000), notAfter = new Date(now.getTime() + 365 * 86400_000);
  const rootDer = issueCertificate({ subject: rootName, issuer: rootName, publicKey: root.publicKey, issuerKey: root.privateKey, issuerPublicKey: root.publicKey, notBefore, notAfter, ca: true, usage: "ca" });
  const tsaDer = issueCertificate({ subject: [[OID.organization, "Test TSA"], [OID.commonName, "Test Timestamping"]], issuer: rootName, publicKey: tsa.publicKey, issuerKey: root.privateKey, issuerPublicKey: root.publicKey, notBefore, notAfter, ca: false, usage: "timestamp" });
  let requests = 0, failNext = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      requests++;
      if (failNext > 0) { failNext--; res.writeHead(503).end(); return; }
      const request = parse(Buffer.concat(chunks));
      const imprint = request.children[1]!.bytes, nonce = request.children.find((c, i) => i > 1 && c.tag === 0x02);
      const tstInfo = seq(integer(1), oid("1.2.3.4.1"), imprint, integer(randomBytes(8)), generalizedTime(options.clock ? options.clock() : new Date()), ...(nonce ? [nonce.bytes] : []));
      const tbs = parse(tsaDer).children[0]!;
      const attrs = set(seq(oid(OID.contentType), set(oid(OID.tstInfo))), seq(oid(OID.messageDigest), set(octets(createHash("sha256").update(tstInfo).digest()))),
        seq(oid(OID.signingCertificateV2), set(seq(seq(seq(octets(createHash("sha256").update(tsaDer).digest())))))));
      const signerInfo = seq(integer(1), seq(tbs.children[3]!.bytes, tbs.children[1]!.bytes), algorithm(OID.sha256), tlv(0xa0, parse(attrs).value), algorithm(OID.rsaEncryption), octets(sign("sha256", attrs, tsa.privateKey)));
      const signedData = seq(integer(3), set(algorithm(OID.sha256)), seq(oid(OID.tstInfo), explicit(0, octets(tstInfo))), implicitConstructed(0, tsaDer), set(signerInfo));
      const token = seq(oid(OID.signedData), explicit(0, signedData));
      res.writeHead(200, { "content-type": "application/timestamp-reply" }).end(seq(seq(integer(0)), token));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/tsr`, rootPem: pem("CERTIFICATE", rootDer),
    get requests() { return requests; }, failNext(n: number) { failNext = n; },
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}
