import {
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";

import { env } from "../config/env.js";

export type ProjectArtifactEntry = {
  name: string;
  size: number;
  updated_at: string;
};

export type ProjectArtifactInventoryEntry = ProjectArtifactEntry & {
  project_id: string;
  key: string;
  etag: string;
};

export type ProjectArtifactHead = {
  exists: boolean;
  size: number;
  etag: string;
  checksum_sha256: string;
  metadata: Record<string, string>;
};

export type ProjectArtifactFileOptions = {
  size: number;
  sourceSha256: string;
  sourceMtimeMs: number;
  syncRunId: string;
};

const PROJECT_ARTIFACT_UPLOAD_ATTEMPTS = 6;
const PROJECT_ARTIFACT_UPLOAD_RETRY_BASE_MS = 250;
const PROJECT_ARTIFACT_UPLOAD_RETRY_MAX_MS = 5_000;

let spacesClient: S3Client | null = null;

export function isSpacesArtifactStorageEnabled() {
  return env.firstmeasureArtifactStorage === "spaces";
}

export function validateArtifactStorageConfiguration() {
  if (!isSpacesArtifactStorageEnabled()) return;
  const missing = [
    ["SPACES_ENDPOINT", env.spacesEndpoint],
    ["SPACES_REGION", env.spacesRegion],
    ["SPACES_BUCKET", env.spacesBucket],
    ["SPACES_ACCESS_KEY_ID", env.spacesAccessKeyId],
    ["SPACES_SECRET_ACCESS_KEY", env.spacesSecretAccessKey]
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error(`FIRSTMEASURE_ARTIFACT_STORAGE=spaces requires ${missing.join(", ")}.`);
  }
}

function client() {
  validateArtifactStorageConfiguration();
  spacesClient ??= new S3Client({
    endpoint: env.spacesEndpoint,
    region: env.spacesRegion,
    forcePathStyle: env.spacesForcePathStyle,
    credentials: {
      accessKeyId: env.spacesAccessKeyId,
      secretAccessKey: env.spacesSecretAccessKey
    }
  });
  return spacesClient;
}

function sharedPrefix() {
  return env.spacesPrefix ? `${env.spacesPrefix}/` : "";
}

function safeSharedObjectKey(value: string) {
  const segments = String(value).replace(/\\/g, "/").split("/").filter(Boolean);
  if (!segments.length) throw new Error("Invalid shared object key.");
  return `${sharedPrefix()}${segments.map((segment) => safeSegment(segment, "object key")).join("/")}`;
}

export async function putSharedObject(keyValue: string, content: Uint8Array | string, contentType = "application/octet-stream") {
  const key = safeSharedObjectKey(keyValue);
  await client().send(new PutObjectCommand({
    Bucket: env.spacesBucket,
    Key: key,
    Body: typeof content === "string" ? Buffer.from(content, "utf8") : content,
    ContentType: contentType
  }));
  return { key, reference: `spaces://${env.spacesBucket}/${key}` };
}

export async function getSharedObject(keyValue: string) {
  const key = safeSharedObjectKey(keyValue);
  try {
    const response = await client().send(new GetObjectCommand({ Bucket: env.spacesBucket, Key: key }));
    if (!response.Body) return null;
    return Buffer.from(await response.Body.transformToByteArray());
  } catch (error) {
    if (isMissingObjectError(error)) return null;
    throw error;
  }
}

export async function deleteSharedObject(keyValue: string) {
  await client().send(new DeleteObjectCommand({
    Bucket: env.spacesBucket,
    Key: safeSharedObjectKey(keyValue)
  }));
}

function safeSegment(value: string, label: string, lowercase = false) {
  const raw = lowercase ? String(value).trim().toLowerCase() : String(value).trim();
  if (!raw || raw === "." || raw === ".." || /[\x00-\x1f\x7f]/.test(raw)) throw new Error(`Invalid ${label}.`);
  if (lowercase && !/^[a-z0-9._-]+$/.test(raw)) throw new Error(`Invalid ${label}.`);
  return raw;
}

function safeObjectPath(value: string) {
  const segments = String(value).replace(/\\/g, "/").split("/").filter(Boolean);
  if (!segments.length) throw new Error("Invalid project artifact path.");
  return segments.map((segment) => safeSegment(segment, "artifact path")).join("/");
}

function projectPrefix(projectId: string) {
  return `${sharedPrefix()}projects/${safeSegment(projectId, "project id", true)}/`;
}

export function projectArtifactKey(projectId: string, fileName: string) {
  return `${projectPrefix(projectId)}${safeObjectPath(fileName)}`;
}

export function projectArtifactReference(projectId: string, fileName = "") {
  const key = fileName ? projectArtifactKey(projectId, fileName) : projectPrefix(projectId).replace(/\/$/, "");
  return isSpacesArtifactStorageEnabled() ? `spaces://${env.spacesBucket}/${key}` : key;
}

export async function putProjectArtifact(projectId: string, fileName: string, content: Uint8Array | string) {
  const key = projectArtifactKey(projectId, fileName);
  await client().send(new PutObjectCommand({
    Bucket: env.spacesBucket,
    Key: key,
    Body: typeof content === "string" ? Buffer.from(content, "utf8") : content,
    ContentType: contentTypeFor(fileName)
  }));
  return { key, reference: `spaces://${env.spacesBucket}/${key}` };
}

export async function putProjectArtifactFile(
  projectId: string,
  fileName: string,
  filePath: string,
  options: ProjectArtifactFileOptions
) {
  const key = projectArtifactKey(projectId, fileName);
  const checksum = Buffer.from(options.sourceSha256, "hex").toString("base64");
  for (let attempt = 1; attempt <= PROJECT_ARTIFACT_UPLOAD_ATTEMPTS; attempt += 1) {
    // The AWS SDK cannot replay a consumed Node stream. Constructing the
    // command inside this loop gives every retry a fresh file descriptor and
    // stream while preserving the same idempotent object key and checksum.
    const body = createReadStream(filePath);
    try {
      await client().send(new PutObjectCommand({
        Bucket: env.spacesBucket,
        Key: key,
        Body: body,
        ContentLength: options.size,
        ContentType: contentTypeFor(fileName),
        ChecksumSHA256: checksum,
        Metadata: {
          "source-sha256": options.sourceSha256,
          "source-size": String(options.size),
          "source-mtime-ms": String(Math.floor(options.sourceMtimeMs)),
          "sync-run-id": options.syncRunId,
          "data-environment": env.dataEnvironment
        }
      }));
      break;
    } catch (error) {
      body.destroy();
      if (attempt >= PROJECT_ARTIFACT_UPLOAD_ATTEMPTS || !isRetryableObjectUploadError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, objectUploadRetryDelayMs(attempt)));
    }
  }
  return { key, reference: `spaces://${env.spacesBucket}/${key}` };
}

function isRetryableObjectUploadError(error: unknown) {
  const value = error as {
    name?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const status = Number(value?.$metadata?.httpStatusCode ?? 0);
  if (status) return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  const name = String(value?.name ?? value?.code ?? "");
  if (["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "NoSuchBucket"].includes(name)) return false;
  // Transport failures from a streaming request often surface from the SDK as
  // UnknownError without an HTTP status. Retrying here is safe because PUT to
  // this immutable key is idempotent and the next attempt opens a new stream.
  return true;
}

function objectUploadRetryDelayMs(attempt: number) {
  const exponential = Math.min(
    PROJECT_ARTIFACT_UPLOAD_RETRY_MAX_MS,
    PROJECT_ARTIFACT_UPLOAD_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1))
  );
  return exponential + Math.floor(Math.random() * Math.max(1, Math.floor(exponential / 4)));
}

export async function getProjectArtifact(projectId: string, fileName: string) {
  const key = projectArtifactKey(projectId, fileName);
  try {
    const response = await client().send(new GetObjectCommand({ Bucket: env.spacesBucket, Key: key }));
    if (!response.Body) return null;
    return Buffer.from(await response.Body.transformToByteArray());
  } catch (error) {
    if (isMissingObjectError(error)) return null;
    throw error;
  }
}

export async function headProjectArtifact(projectId: string, fileName: string): Promise<ProjectArtifactHead> {
  try {
    const response = await client().send(new HeadObjectCommand({
      Bucket: env.spacesBucket,
      Key: projectArtifactKey(projectId, fileName),
      ChecksumMode: "ENABLED"
    }));
    return {
      exists: true,
      size: Number(response.ContentLength ?? 0),
      etag: String(response.ETag ?? "").replace(/^"|"$/g, ""),
      checksum_sha256: String(response.ChecksumSHA256 ?? ""),
      metadata: Object.fromEntries(Object.entries(response.Metadata ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]))
    };
  } catch (error) {
    if (isMissingObjectError(error)) {
      return { exists: false, size: 0, etag: "", checksum_sha256: "", metadata: {} };
    }
    throw error;
  }
}

export async function deleteProjectArtifact(projectId: string, fileName: string) {
  await client().send(new DeleteObjectCommand({
    Bucket: env.spacesBucket,
    Key: projectArtifactKey(projectId, fileName)
  }));
}

export async function listProjectArtifacts(projectId: string): Promise<ProjectArtifactEntry[]> {
  const prefix = projectPrefix(projectId);
  const files: ProjectArtifactEntry[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await client().send(new ListObjectsV2Command({
      Bucket: env.spacesBucket,
      Prefix: prefix,
      ContinuationToken: continuationToken
    }));
    for (const object of response.Contents ?? []) {
      const key = String(object.Key ?? "");
      const name = key.startsWith(prefix) ? key.slice(prefix.length) : "";
      if (!name || name.includes("/")) continue;
      files.push({
        name,
        size: Number(object.Size ?? 0),
        updated_at: object.LastModified?.toISOString() ?? new Date(0).toISOString()
      });
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listProjectArtifactInventory(): Promise<ProjectArtifactInventoryEntry[]> {
  const prefix = `${sharedPrefix()}projects/`;
  const files: ProjectArtifactInventoryEntry[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await client().send(new ListObjectsV2Command({
      Bucket: env.spacesBucket,
      Prefix: prefix,
      ContinuationToken: continuationToken
    }));
    for (const object of response.Contents ?? []) {
      const key = String(object.Key ?? "");
      const relative = key.startsWith(prefix) ? key.slice(prefix.length) : "";
      const separator = relative.indexOf("/");
      if (separator <= 0 || separator === relative.length - 1) continue;
      files.push({
        project_id: relative.slice(0, separator),
        name: relative.slice(separator + 1),
        key,
        size: Number(object.Size ?? 0),
        etag: String(object.ETag ?? "").replace(/^"|"$/g, ""),
        updated_at: object.LastModified?.toISOString() ?? new Date(0).toISOString()
      });
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return files;
}

export async function checkProjectArtifactStorage(timeoutMs = env.readinessDependencyTimeoutMs) {
  if (!isSpacesArtifactStorageEnabled()) return { ok: true, mode: "local" as const };
  validateArtifactStorageConfiguration();
  await client().send(new ListObjectsV2Command({
    Bucket: env.spacesBucket,
    Prefix: env.spacesPrefix ? `${env.spacesPrefix}/` : undefined,
    MaxKeys: 1
  }), { abortSignal: AbortSignal.timeout(Math.max(250, timeoutMs)) });
  return { ok: true, mode: "spaces" as const };
}

function isMissingObjectError(error: unknown) {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value?.name === "NoSuchKey" || value?.name === "NotFound" || value?.$metadata?.httpStatusCode === 404;
}

function contentTypeFor(fileName: string) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
  if (lower.endsWith(".xml")) return "application/xml";
  return "application/octet-stream";
}
