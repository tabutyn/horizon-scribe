#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import process from "node:process";
import { isMain } from "./lib.mjs";
import {
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const PLAN_SCHEMA = "horizon-scribe-r2-upload-object/v1";
const DEFAULT_PREFIX = "production/horizon-scribe/v1";
const HEX64 = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(message);
}
function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}
function configuration() {
  const endpoint = requiredEnvironment("HORIZON_SCRIBE_R2_ENDPOINT");
  const parsed = new URL(endpoint);
  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/" ||
    !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(parsed.hostname)
  )
    fail(
      "HORIZON_SCRIBE_R2_ENDPOINT must be the HTTPS R2 account endpoint without a bucket path",
    );
  const bucket = requiredEnvironment("HORIZON_SCRIBE_R2_BUCKET");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))
    fail("HORIZON_SCRIBE_R2_BUCKET is invalid");
  const prefix = (
    process.env.HORIZON_SCRIBE_R2_PREFIX?.trim() || DEFAULT_PREFIX
  ).replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.includes("//") || prefix.startsWith("."))
    fail("HORIZON_SCRIBE_R2_PREFIX is invalid");
  return {
    endpoint,
    bucket,
    prefix,
    region: process.env.HORIZON_SCRIBE_R2_REGION?.trim() || "auto",
    credentials: {
      accessKeyId: requiredEnvironment("HORIZON_SCRIBE_R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnvironment(
        "HORIZON_SCRIBE_R2_SECRET_ACCESS_KEY",
      ),
    },
  };
}
function clientFor(config) {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    maxAttempts: 4,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: config.credentials,
  });
}
function parseOptions(values) {
  const command = values.shift();
  const options = { command, concurrency: 6, plan: null };
  while (values.length) {
    const flag = values.shift();
    if (flag === "--plan") options.plan = values.shift();
    else if (flag === "--concurrency")
      options.concurrency = Number(values.shift());
    else fail(`Unknown option: ${flag}`);
  }
  if (!["check", "upload"].includes(command))
    fail(
      "Usage: node r2-sync.mjs check | upload --plan PLAN.jsonl [--concurrency 6]",
    );
  if (command === "upload" && !options.plan)
    fail("--plan is required for upload");
  if (
    !Number.isInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > 24
  )
    fail("--concurrency must be an integer from 1 through 24");
  return options;
}
function validateRecord(value, prefix) {
  if (!value || value.schema !== PLAN_SCHEMA)
    fail("Upload plan record schema is invalid");
  if (typeof value.localPath !== "string" || !value.localPath)
    fail("Upload plan localPath is invalid");
  if (
    typeof value.key !== "string" ||
    !value.key.startsWith(`${prefix}/`) ||
    value.key.includes("..")
  )
    fail(`Upload key escapes configured prefix: ${value.key}`);
  if (
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    !HEX64.test(value.sha256)
  )
    fail(`Upload evidence is invalid: ${value.key}`);
  if (
    typeof value.contentType !== "string" ||
    !value.contentType ||
    typeof value.cacheControl !== "string"
  )
    fail(`Upload metadata is invalid: ${value.key}`);
  if (typeof value.immutable !== "boolean")
    fail(`Upload immutability is invalid: ${value.key}`);
  return value;
}
async function readPlan(path, prefix) {
  const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean);
  if (!lines.length) fail("Upload plan is empty");
  const records = lines.map((line, index) => {
    try {
      return validateRecord(JSON.parse(line), prefix);
    } catch (error) {
      throw new Error(
        `Invalid upload plan line ${index + 1}: ${error.message}`,
      );
    }
  });
  const keys = new Set();
  for (const record of records) {
    if (keys.has(record.key)) fail(`Duplicate upload key: ${record.key}`);
    keys.add(record.key);
  }
  return records;
}
function missing(error) {
  return (
    error?.$metadata?.httpStatusCode === 404 ||
    error?.name === "NotFound" ||
    error?.name === "NoSuchKey"
  );
}
async function headObject(client, bucket, record) {
  try {
    return await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: record.key }),
    );
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
function matches(head, record) {
  return (
    head &&
    Number(head.ContentLength) === record.bytes &&
    head.Metadata?.sha256 === record.sha256
  );
}
async function sha256Path(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
export async function uploadOne(client, bucket, record) {
  const stats = await lstat(record.localPath);
  if (!stats.isFile() || stats.isSymbolicLink())
    fail(`Upload source must be a real file: ${record.localPath}`);
  if (stats.size !== record.bytes)
    fail(`Upload source size changed: ${record.localPath}`);
  if ((await sha256Path(record.localPath)) !== record.sha256)
    fail(`Upload source checksum changed: ${record.localPath}`);
  const before = await headObject(client, bucket, record);
  if (matches(before, record)) return "skipped";
  if (before && record.immutable)
    fail(`Immutable R2 object exists with different evidence: ${record.key}`);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: record.key,
        Body: createReadStream(record.localPath),
        ContentLength: record.bytes,
        ContentType: record.contentType,
        CacheControl: record.cacheControl,
        Metadata: {
          sha256: record.sha256,
          schema: "horizon-scribe-r2-object-v1",
        },
        ...(record.immutable ? { IfNoneMatch: "*" } : {}),
      }),
    );
  } catch (error) {
    if (
      record.immutable &&
      error?.$metadata?.httpStatusCode === 412 &&
      matches(await headObject(client, bucket, record), record)
    )
      return "skipped";
    throw error;
  }
  const after = await headObject(client, bucket, record);
  if (!matches(after, record))
    fail(`R2 verification failed after upload: ${record.key}`);
  return "uploaded";
}
async function runPool(records, concurrency, operation) {
  let cursor = 0,
    completed = 0,
    uploaded = 0,
    skipped = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= records.length) return;
      const result = await operation(records[index]);
      completed += 1;
      if (result === "uploaded") uploaded += 1;
      else skipped += 1;
      if (completed % 25 === 0 || completed === records.length)
        process.stderr.write(
          `Verified ${completed}/${records.length} objects (${uploaded} uploaded, ${skipped} already present)\n`,
        );
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, records.length) }, worker),
  );
  return {
    uploaded,
    skipped,
    objects: records.length,
    bytes: records.reduce((sum, record) => sum + record.bytes, 0),
  };
}
async function main() {
  const options = parseOptions(process.argv.slice(2)),
    config = configuration(),
    client = clientFor(config);
  if (options.command === "check") {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    const sample = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: `${config.prefix}/`,
        MaxKeys: 1,
      }),
    );
    console.log(
      JSON.stringify({
        status: "ready",
        bucket: config.bucket,
        prefix: config.prefix,
        matchingObjects: Number(sample.KeyCount) || 0,
      }),
    );
    return;
  }
  const records = await readPlan(options.plan, config.prefix);
  const immutable = records.filter((record) => record.immutable),
    mutable = records.filter((record) => !record.immutable);
  const stableResult = await runPool(immutable, options.concurrency, (record) =>
    uploadOne(client, config.bucket, record),
  );
  const pointerResult = await runPool(mutable, 1, (record) =>
    uploadOne(client, config.bucket, record),
  );
  console.log(
    JSON.stringify({
      status: "complete",
      bucket: config.bucket,
      prefix: config.prefix,
      uploaded: stableResult.uploaded + pointerResult.uploaded,
      skipped: stableResult.skipped + pointerResult.skipped,
      objects: records.length,
      bytes: stableResult.bytes + pointerResult.bytes,
    }),
  );
}
if (isMain(import.meta.url))
  main().catch((error) => {
    console.error(`horizon-scribe-r2: ${error.message}`);
    process.exitCode = 1;
  });
