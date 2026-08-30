#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals < 1) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function required(values, name, source) {
  const value = values[name];
  if (!value) throw new Error(`${name} is missing from ${source}`);
  return value;
}

function client(values, source) {
  return new S3Client({
    endpoint: required(values, "SPACES_ENDPOINT", source),
    region: required(values, "SPACES_REGION", source),
    forcePathStyle: values.SPACES_FORCE_PATH_STYLE === "true",
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: required(values, "SPACES_ACCESS_KEY_ID", source),
      secretAccessKey: required(values, "SPACES_SECRET_ACCESS_KEY", source)
    }
  });
}

async function fingerprint(envPath, prefix) {
  const values = parseEnv(await readFile(envPath, "utf8"));
  const s3 = client(values, envPath);
  const bucket = required(values, "SPACES_BUCKET", envPath);
  const hash = createHash("sha256");
  let continuationToken;
  let objects = 0;
  let bytes = 0;

  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix || undefined,
      ContinuationToken: continuationToken,
      MaxKeys: 1000
    }));
    for (const item of page.Contents ?? []) {
      if (!item.Key || item.Key.startsWith(".firstmeasure-")) continue;
      const size = Number(item.Size ?? 0);
      hash.update(item.Key).update("\0").update(String(size)).update("\0").update(item.ETag ?? "").update("\n");
      objects += 1;
      bytes += size;
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);

  return { bucket, objects, bytes, fingerprint: hash.digest("hex") };
}

const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
  const equals = entry.indexOf("=");
  return equals === -1 ? [entry, "true"] : [entry.slice(0, equals), entry.slice(equals + 1)];
}));
const sourceEnvPath = args["--source-env"];
const destinationEnvPath = args["--destination-env"];
const prefix = args["--prefix"] ?? "";
if (!sourceEnvPath || !destinationEnvPath) {
  throw new Error("Usage: verify-spaces-bucket.mjs --source-env=PATH --destination-env=PATH [--prefix=PREFIX]");
}

const [source, destination] = await Promise.all([
  fingerprint(sourceEnvPath, prefix),
  fingerprint(destinationEnvPath, prefix)
]);
const match = source.objects === destination.objects &&
  source.bytes === destination.bytes &&
  source.fingerprint === destination.fingerprint;
console.log(JSON.stringify({ prefix, source, destination, match }));
if (!match) process.exitCode = 2;
