import {
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";

import { env } from "../config/env.js";

export type ProjectArtifactEntry = {
  name: string;
  size: number;
  updated_at: string;
};

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
