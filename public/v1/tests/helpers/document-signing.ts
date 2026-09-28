/** Exercise the actual review/consent protocol in domain integration tests. */
export async function signingConsent(client: { request(method:string,url:string,payload?:unknown):Promise<any> }, token: string) {
  const review = await client.request("POST", `/v1/documents/public/${token}/signing/prepare`, {});
  return { challenge:review.challenge, content_hash:review.content_hash, consent:{ intent:true,electronic_records:true,can_access_and_retain:true,disclosure_hash:review.disclosure.hash } };
}
