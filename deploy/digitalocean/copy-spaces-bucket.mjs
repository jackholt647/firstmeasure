#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";

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
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
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

async function mapLimit(items, concurrency, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
  const equals = entry.indexOf("=");
  return equals === -1 ? [entry, "true"] : [entry.slice(0, equals), entry.slice(equals + 1)];
}));

const sourceEnvPath = args["--source-env"];
const destinationEnvPath = args["--destination-env"];
const checkpointPath = args["--checkpoint"];
const concurrency = Math.max(1, Math.min(64, Number(args["--concurrency"] ?? 16)));
const prefix = args["--prefix"] ?? "";

if (!sourceEnvPath || !destinationEnvPath || !checkpointPath) {
  throw new Error("Usage: copy-spaces-bucket.mjs --source-env=PATH --destination-env=PATH --checkpoint=PATH [--concurrency=16]");
}

const sourceValues = parseEnv(await readFile(sourceEnvPath, "utf8"));
const destinationValues = parseEnv(await readFile(destinationEnvPath, "utf8"));
const sourceBucket = required(sourceValues, "SPACES_BUCKET", sourceEnvPath);
const destinationBucket = required(destinationValues, "SPACES_BUCKET", destinationEnvPath);
if (sourceBucket === destinationBucket) throw new Error("Source and destination buckets must differ.");

const sourceClient = client(sourceValues, sourceEnvPath);
const destinationClient = client(destinationValues, destinationEnvPath);

await destinationClient.send(new PutObjectCommand({
  Bucket: destinationBucket,
  Key: ".firstmeasure-migration-write-probe",
  Body: Buffer.from("ok\n", "utf8"),
  ContentType: "text/plain"
}));
console.log(JSON.stringify({ destinationWriteProbe: true }));

let checkpoint = { continuationToken: undefined, copiedObjects: 0, copiedBytes: 0, prefix };
try {
  checkpoint = { ...checkpoint, ...JSON.parse(await readFile(checkpointPath, "utf8")) };
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if ((checkpoint.prefix ?? "") !== prefix) {
  throw new Error(`Checkpoint prefix '${checkpoint.prefix ?? ""}' does not match requested prefix '${prefix}'.`);
}

let pageNumber = 0;
while (true) {
  const page = await sourceClient.send(new ListObjectsV2Command({
    Bucket: sourceBucket,
    Prefix: prefix || undefined,
    ContinuationToken: checkpoint.continuationToken,
    MaxKeys: 1000
  }));
  const objects = (page.Contents ?? []).filter((item) => item.Key);

  await mapLimit(objects, concurrency, async (item) => {
    const response = await sourceClient.send(new GetObjectCommand({
      Bucket: sourceBucket,
      Key: item.Key
    }));
    await destinationClient.send(new PutObjectCommand({
      Bucket: destinationBucket,
      Key: item.Key,
      Body: response.Body,
      ContentLength: response.ContentLength,
      ContentType: response.ContentType,
      ContentDisposition: response.ContentDisposition,
      ContentEncoding: response.ContentEncoding,
      CacheControl: response.CacheControl,
      Expires: response.Expires,
      Metadata: response.Metadata
    }));
  });

  checkpoint.copiedObjects += objects.length;
  checkpoint.copiedBytes += objects.reduce((sum, item) => sum + Number(item.Size ?? 0), 0);
  checkpoint.continuationToken = page.NextContinuationToken;
  checkpoint.updatedAt = new Date().toISOString();
  const temporaryCheckpoint = `${checkpointPath}.tmp`;
  await writeFile(temporaryCheckpoint, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
  await rename(temporaryCheckpoint, checkpointPath);

  pageNumber += 1;
  console.log(JSON.stringify({
    page: pageNumber,
    copiedObjects: checkpoint.copiedObjects,
    copiedBytes: checkpoint.copiedBytes,
    complete: !page.IsTruncated
  }));

  if (!page.IsTruncated) break;
}
