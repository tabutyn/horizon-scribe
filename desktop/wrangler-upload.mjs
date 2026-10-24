#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { isMain } from "./lib.mjs";
export function wranglerCLI() {
  return join(
    dirname(require.resolve("wrangler/package.json")),
    "bin",
    "wrangler.js",
  );
}

const PLAN_SCHEMA = "horizon-scribe-r2-upload-object/v1";
const STATE_SCHEMA = "horizon-scribe-r2-wrangler-upload-state/v1";
const HEX64 = /^[a-f0-9]{64}$/;
function fail(message) {
  throw new Error(message);
}
async function sha256Path(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
function parseOptions(values) {
  const result = { plan: null, bucket: "horizon-scribe", concurrency: 6 };
  while (values.length) {
    const flag = values.shift();
    if (flag === "--plan") result.plan = values.shift();
    else if (flag === "--bucket") result.bucket = values.shift();
    else if (flag === "--concurrency")
      result.concurrency = Number(values.shift());
    else fail(`Unknown option: ${flag}`);
  }
  if (!result.plan)
    fail(
      "Usage: node wrangler-upload.mjs --plan PLAN.jsonl [--bucket horizon-scribe] [--concurrency 6]",
    );
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(result.bucket))
    fail("Bucket name is invalid");
  if (
    !Number.isInteger(result.concurrency) ||
    result.concurrency < 1 ||
    result.concurrency > 12
  )
    fail("Concurrency must be an integer from 1 through 12");
  return result;
}
async function loadPlan(path) {
  const payload = await readFile(path),
    digest = createHash("sha256").update(payload).digest("hex");
  const records = payload
    .toString("utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        fail(`Upload plan line ${index + 1} is not JSON`);
      }
      if (
        value?.schema !== PLAN_SCHEMA ||
        typeof value.localPath !== "string" ||
        typeof value.key !== "string" ||
        !Number.isSafeInteger(value.bytes) ||
        value.bytes < 0 ||
        !HEX64.test(value.sha256) ||
        typeof value.contentType !== "string" ||
        typeof value.cacheControl !== "string" ||
        typeof value.immutable !== "boolean"
      )
        fail(`Upload plan line ${index + 1} is invalid`);
      return value;
    });
  if (!records.length) fail("Upload plan is empty");
  return { records, digest };
}
async function loadState(path, planDigest, bucket) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      value.schema !== STATE_SCHEMA ||
      value.planSha256 !== planDigest ||
      value.bucket !== bucket ||
      !Array.isArray(value.completed)
    )
      fail(
        "Existing Wrangler upload state does not match this plan and bucket",
      );
    return new Set(value.completed);
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
}
async function saveState(path, planDigest, bucket, completed) {
  const temporary = `${path}.tmp`,
    value = {
      schema: STATE_SCHEMA,
      planSha256: planDigest,
      bucket,
      updatedAt: new Date().toISOString(),
      completed: [...completed].sort(),
    };
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "w",
  });
  await rename(temporary, path);
}
function runWrangler(record, bucket) {
  const executable = process.execPath;
  const args = [
    wranglerCLI(),
    "r2",
    "object",
    "put",
    `${bucket}/${record.key}`,
    "--remote",
    "--force",
    "--file",
    record.localPath,
    "--content-type",
    record.contentType,
    "--cache-control",
    record.cacheControl,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        output = (output + chunk.toString("utf8")).slice(-8000);
      });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Wrangler failed for ${record.key} (exit ${code}): ${output.trim()}`,
            ),
          ),
    );
  });
}
async function verifyLocal(record) {
  const stats = await lstat(record.localPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== record.bytes)
    fail(`Local upload source changed: ${record.localPath}`);
  if ((await sha256Path(record.localPath)) !== record.sha256)
    fail(`Local upload checksum changed: ${record.localPath}`);
}
async function uploadPhase(records, options, state) {
  let cursor = 0,
    sinceSave = 0,
    uploaded = 0,
    saveChain = Promise.resolve();
  const persist = () => {
    sinceSave = 0;
    saveChain = saveChain.then(() =>
      saveState(state.path, state.planDigest, options.bucket, state.completed),
    );
    return saveChain;
  };
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= records.length) return;
      const record = records[index];
      if (state.completed.has(record.key)) continue;
      await verifyLocal(record);
      await runWrangler(record, options.bucket);
      state.completed.add(record.key);
      uploaded += 1;
      sinceSave += 1;
      if (sinceSave >= 20) void persist();
      if (uploaded % 20 === 0)
        process.stderr.write(
          `Uploaded ${state.completed.size}/${state.total} objects\n`,
        );
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, records.length || 1) },
      worker,
    ),
  );
  await persist();
  return uploaded;
}
async function main() {
  const options = parseOptions(process.argv.slice(2)),
    plan = await loadPlan(options.plan),
    statePath = `${options.plan}.wrangler-state.json`,
    completed = await loadState(statePath, plan.digest, options.bucket);
  const state = {
    path: statePath,
    planDigest: plan.digest,
    completed,
    total: plan.records.length,
  };
  const immutable = plan.records.filter((record) => record.immutable),
    mutable = plan.records.filter((record) => !record.immutable);
  const stableUploaded = await uploadPhase(immutable, options, state);
  const pointerUploaded = await uploadPhase(
    mutable,
    { ...options, concurrency: 1 },
    state,
  );
  console.log(
    JSON.stringify({
      status: "complete",
      bucket: options.bucket,
      objects: plan.records.length,
      uploaded: stableUploaded + pointerUploaded,
      resumed: plan.records.length - stableUploaded - pointerUploaded,
      stateFile: statePath,
    }),
  );
}
if (isMain(import.meta.url))
  main().catch((error) => {
    console.error(`horizon-scribe-r2-wrangler: ${error.message}`);
    process.exitCode = 1;
  });
