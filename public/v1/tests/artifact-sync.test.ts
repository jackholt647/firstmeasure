import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

type StoredObject = { content: Buffer; etag: string; metadata: Record<string, string>; checksum: string };

function xml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function runArtifactSync(environment: NodeJS.ProcessEnv, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--experimental-sqlite", "--import", "tsx", "src/scripts/firstmeasure_artifacts_migrate.ts", ...args
    ], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("artifact synchronization uploads once, verifies, and skips unchanged files", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "firstmeasure-artifact-sync-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const sourceRoot = path.join(fixtureRoot, "firstmeasure");
  const projectRoot = path.join(sourceRoot, "projects", "project-1");
  await mkdir(path.join(projectRoot, "nested"), { recursive: true });
  await writeFile(path.join(projectRoot, "manifest.json"), JSON.stringify({ id: "project-1" }));
  await writeFile(path.join(projectRoot, "nested", "report.pdf"), Buffer.from("pdf-version-one"));

  const objects = new Map<string, StoredObject>();
  let putCount = 0;
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const key = decodeURIComponent(requestUrl.pathname.replace(/^\/firstmeasure-test\/?/, ""));
    if (request.method === "GET" && requestUrl.searchParams.get("list-type") === "2") {
      const prefix = requestUrl.searchParams.get("prefix") ?? "";
      const contents = Array.from(objects.entries())
        .filter(([objectKey]) => objectKey.startsWith(prefix))
        .map(([objectKey, object]) => [
          "<Contents>",
          `<Key>${xml(objectKey)}</Key>`,
          `<LastModified>2026-08-26T00:00:00.000Z</LastModified>`,
          `<ETag>&quot;${xml(object.etag)}&quot;</ETag>`,
          `<Size>${object.content.length}</Size>`,
          "<StorageClass>STANDARD</StorageClass>",
          "</Contents>"
        ].join(""))
        .join("");
      response.writeHead(200, { "Content-Type": "application/xml" });
      response.end([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
        "<Name>firstmeasure-test</Name>",
        `<Prefix>${xml(prefix)}</Prefix>`,
        "<KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>",
        contents,
        "</ListBucketResult>"
      ].join(""));
      return;
    }
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        putCount += 1;
        const metadata = Object.fromEntries(Object.entries(request.headers)
          .filter(([name]) => name.startsWith("x-amz-meta-"))
          .map(([name, value]) => [name.slice("x-amz-meta-".length), String(value ?? "")]));
        const content = Buffer.concat(chunks);
        const etag = `etag-${putCount}`;
        objects.set(key, {
          content,
          etag,
          metadata,
          checksum: String(request.headers["x-amz-checksum-sha256"] ?? "")
        });
        response.writeHead(200, { ETag: `"${etag}"` });
        response.end();
      });
      return;
    }
    if (request.method === "HEAD") {
      const object = objects.get(key);
      if (!object) {
        response.writeHead(404);
        response.end();
        return;
      }
      const headers: Record<string, string> = {
        "Content-Length": String(object.content.length),
        ETag: `"${object.etag}"`
      };
      for (const [name, value] of Object.entries(object.metadata)) headers[`x-amz-meta-${name}`] = value;
      if (object.checksum) headers["x-amz-checksum-sha256"] = object.checksum;
      response.writeHead(200, headers);
      response.end();
      return;
    }
    response.writeHead(404, { "Content-Type": "application/xml" });
    response.end("<Error><Code>NoSuchKey</Code></Error>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const environment = {
    ...process.env,
    FIRSTMATE_ENV: "test",
    FIRSTMEASURE_DATA_ENVIRONMENT: "development",
    FIRSTMEASURE_ARTIFACT_STORAGE: "spaces",
    SPACES_ENDPOINT: `http://127.0.0.1:${address.port}`,
    SPACES_REGION: "us-east-1",
    SPACES_BUCKET: "firstmeasure-test",
    SPACES_ACCESS_KEY_ID: "test-access-key",
    SPACES_SECRET_ACCESS_KEY: "test-secret-key",
    SPACES_FORCE_PATH_STYLE: "true",
    SPACES_PREFIX: "development/test",
    FIRSTMEASURE_CLONE_SYNC_STATE_PATH: path.join(fixtureRoot, "artifact-ledger.sqlite")
  };
  const commonArguments = [
    "--apply", "--verify",
    "--source-root", sourceRoot,
    "--source-id", "snapshot-1",
    "--target-environment", "development",
    "--concurrency", "2"
  ];

  const first = await runArtifactSync(environment, commonArguments);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  assert.equal(putCount, 2);
  assert.match(first.stdout, /"uploaded":2/);

  const second = await runArtifactSync(environment, commonArguments);
  assert.equal(second.code, 0, second.stderr || second.stdout);
  assert.equal(putCount, 2);
  assert.match(second.stdout, /"uploaded":0/);
  assert.match(second.stdout, /"skipped":2/);

  await writeFile(path.join(projectRoot, "nested", "report.pdf"), Buffer.from("pdf-version-two-is-different"));
  const third = await runArtifactSync(environment, [...commonArguments.slice(0, 5), "snapshot-2", ...commonArguments.slice(6)]);
  assert.equal(third.code, 0, third.stderr || third.stdout);
  assert.equal(putCount, 3);
  assert.match(third.stdout, /"uploaded":1/);
  assert.match(third.stdout, /"skipped":1/);
});
