/**
 * Content address of a large replay string (a stylesheet, a data URL). Mirrors
 * blobKey() in public/libraries/session-replay/session-replay-codec.js exactly:
 * the recorder names a blob before sending it and the server recomputes the name,
 * so nobody can store one text under another text's key.
 */
function cyrb(text: string, seed: number): [number, number] {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return [h1 >>> 0, h2 >>> 0];
}

const hex8 = (n: number) => n.toString(16).padStart(8, "0");

export function replayBlobKey(text: string) {
  const a = cyrb(text, 0), b = cyrb(text, 0x5bd1e995);
  return `b${hex8(a[0])}${hex8(a[1])}${hex8(b[0])}${hex8(b[1])}-${text.length.toString(36)}`;
}

export const REPLAY_BLOB_KEY = /^b[0-9a-f]{32}-[0-9a-z]{1,8}$/;
