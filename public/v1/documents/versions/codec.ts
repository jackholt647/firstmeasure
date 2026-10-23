import { gunzipSync, gzipSync } from "node:zlib";

/**
 * How a revision's payload (a full state at a checkpoint, a patch otherwise)
 * becomes stored bytes. Every row names its encoding, so a new encoder (a
 * token dictionary over document vocabulary, a shared-dictionary compressor)
 * is added here as a new name and becomes CURRENT_ENCODING; rows written with
 * an older encoding keep decoding with it. Never change what an existing name
 * decodes. See docs/architecture/document-history.md.
 */

export type RevisionEncoding = "json-gzip-1";

export const CURRENT_ENCODING: RevisionEncoding = "json-gzip-1";

/** Shape of what a payload holds; bump when the state or patch format changes meaning. */
export const REVISION_FORMAT = 1;

type Codec = { encode(value: unknown): Buffer; decode(bytes: Buffer): unknown };

const CODECS: Record<RevisionEncoding, Codec> = {
  "json-gzip-1": {
    encode: (value) => gzipSync(Buffer.from(JSON.stringify(value ?? null), "utf8"), { level: 9 }),
    decode: (bytes) => JSON.parse(gunzipSync(bytes).toString("utf8"))
  }
};

function codecFor(encoding: string): Codec {
  const codec = CODECS[encoding as RevisionEncoding];
  if (!codec) throw new Error(`Unknown document revision encoding '${encoding}'.`);
  return codec;
}

export function encodePayload(value: unknown, encoding: RevisionEncoding = CURRENT_ENCODING): Buffer {
  return codecFor(encoding).encode(value);
}

export function decodePayload(bytes: unknown, encoding: string): unknown {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as Uint8Array);
  return codecFor(encoding).decode(buffer);
}
