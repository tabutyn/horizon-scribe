import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  throw new Error(message);
}

function options(values) {
  const result = {
    worker: "horizon-scribe",
    bucket: "horizon-scribe",
    prefix: "production/horizon-scribe/v1",
    allowedOrigins: "",
    force: false,
  };
  while (values.length) {
    const flag = values.shift();
    if (flag === "--worker") result.worker = values.shift();
    else if (flag === "--bucket") result.bucket = values.shift();
    else if (flag === "--prefix") result.prefix = values.shift();
    else if (flag === "--allowed-origins")
      result.allowedOrigins = values.shift();
    else if (flag === "--force") result.force = true;
    else fail(`Unknown option: ${flag}`);
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(result.worker ?? ""))
    fail("Worker name must use 3-63 lowercase letters, digits, or hyphens.");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(result.bucket ?? ""))
    fail("Bucket name must use 3-63 lowercase letters, digits, or hyphens.");
  result.prefix = String(result.prefix ?? "").replace(/^\/+|\/+$/g, "");
  if (
    !result.prefix ||
    result.prefix.includes("//") ||
    result.prefix.startsWith(".")
  )
    fail("Prefix is invalid.");
  const origins = String(result.allowedOrigins ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== "https:")
      fail(`Allowed origin must be an HTTPS origin: ${origin}`);
  }
  result.allowedOrigins = origins.join(",");
  return result;
}

async function main() {
  const input = options(process.argv.slice(2));
  const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const path = resolve(project, "cloudflare", "wrangler.jsonc");
  if (existsSync(path) && !input.force)
    fail(`${path} already exists; use --force to replace it.`);
  const config = {
    $schema: "../node_modules/wrangler/config-schema.json",
    name: input.worker,
    main: "src/index.mjs",
    compatibility_date: "2026-10-21",
    workers_dev: true,
    preview_urls: false,
    r2_buckets: [
      { binding: "HORIZON_SCRIBE_BUCKET", bucket_name: input.bucket },
    ],
    vars: {
      HORIZON_SCRIBE_PREFIX: input.prefix,
      ALLOWED_ORIGINS: input.allowedOrigins,
    },
    secrets: { required: ["HORIZON_SCRIBE_API_TOKEN"] },
  };
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", {
    flag: "wx",
  }).catch(async (error) => {
    if (error.code !== "EEXIST" || !input.force) throw error;
    await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  });
  console.log(
    JSON.stringify(
      {
        config: path,
        worker: input.worker,
        bucket: input.bucket,
        prefix: input.prefix,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(`configure-cloudflare: ${error.message}`);
  process.exitCode = 1;
});
