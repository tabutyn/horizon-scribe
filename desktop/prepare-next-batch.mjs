import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SOURCE_SCHEMA = "horizon-scribe-next-batch-source/v1";
const SELECTION_SCHEMA = "horizon-scribe-next-pass-selection/v1";
const SNAPSHOT_SCHEMA = "horizon-scribe-r2-snapshot/v1";
const PLAN_SCHEMA = "horizon-scribe-r2-upload-object/v1";

function fail(message) {
  throw new Error(message);
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseOptions(values) {
  const result = { snapshot: null, selection: null, output: null };
  while (values.length) {
    const flag = values.shift();
    if (flag === "--snapshot") result.snapshot = resolve(values.shift());
    else if (flag === "--selection") result.selection = resolve(values.shift());
    else if (flag === "--output") result.output = resolve(values.shift());
    else fail(`Unknown option: ${flag}`);
  }
  if (!result.snapshot || !result.selection)
    fail(
      "Usage: node desktop/prepare-next-batch.mjs --snapshot manifest.json --selection next-batch.json [--output directory]",
    );
  result.output ??= dirname(result.selection);
  return result;
}

async function prepare(options) {
  const manifest = JSON.parse(await readFile(options.snapshot, "utf8"));
  const source = JSON.parse(await readFile(options.selection, "utf8"));
  if (
    manifest?.schema !== SNAPSHOT_SCHEMA ||
    !/^[a-f0-9]{64}$/.test(String(manifest.datasetId ?? ""))
  )
    fail("Snapshot manifest is invalid.");
  if (
    source?.schema !== SOURCE_SCHEMA ||
    !Array.isArray(source.images) ||
    source.images.length === 0
  )
    fail(`Selection must use ${SOURCE_SCHEMA} and contain at least one image.`);
  if (source.datasetId && source.datasetId !== manifest.datasetId)
    fail("Selection belongs to a different snapshot.");
  if (source.images.length > 500)
    fail("Next batch cannot contain more than 500 images.");
  const available = new Set(
    manifest.sets.flatMap((set) =>
      set.images.map((image) => `${set.id}\n${image.name}`),
    ),
  );
  const seen = new Set();
  const selectedImages = source.images
    .map((item, index) => {
      const setId = String(item?.setId ?? ""),
        image = String(item?.image ?? ""),
        identity = `${setId}\n${image}`;
      if (!available.has(identity))
        fail(`Selection is not in the snapshot: ${setId}/${image}`);
      if (seen.has(identity)) fail(`Duplicate selection: ${setId}/${image}`);
      seen.add(identity);
      if (
        item.rank !== undefined &&
        (!Number.isSafeInteger(item.rank) || item.rank < 0)
      )
        fail("Ranks must be nonnegative integers.");
      return {
        setId,
        image,
        rank:
          Number.isSafeInteger(item.rank) && item.rank >= 0 ? item.rank : index,
      };
    })
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.setId.localeCompare(right.setId) ||
        left.image.localeCompare(right.image),
    );
  if (
    new Set(selectedImages.map((item) => item.rank)).size !==
    selectedImages.length
  )
    fail("Ranks must be unique.");
  const batch = {
    schema: SELECTION_SCHEMA,
    datasetId: manifest.datasetId,
    runId: source.runId ?? null,
    modelId: source.modelId ?? null,
    predictionSetId: source.predictionSetId ?? null,
    updatedAt: new Date().toISOString(),
    selectedImages,
  };
  await mkdir(options.output, { recursive: true });
  const batchPath = resolve(options.output, "next-pass.json");
  const bytes = Buffer.from(JSON.stringify(batch, null, 2) + "\n");
  await writeFile(batchPath, bytes);
  const prefix = String(manifest.prefix).replace(/^\/+|\/+$/g, "");
  const record = {
    schema: PLAN_SCHEMA,
    localPath: batchPath,
    key: `${prefix}/next-pass/${manifest.datasetId}/current.json`,
    bytes: bytes.length,
    sha256: sha256(bytes),
    contentType: "application/json",
    cacheControl: "no-store",
    immutable: false,
    roles: ["next-pass-pointer"],
  };
  const planPath = resolve(options.output, "next-pass-upload-plan.jsonl");
  await writeFile(planPath, JSON.stringify(record) + "\n");
  return {
    schema: "horizon-scribe-next-batch-result/v1",
    datasetId: manifest.datasetId,
    imageCount: selectedImages.length,
    batch: batchPath,
    uploadPlan: planPath,
  };
}

prepare(parseOptions(process.argv.slice(2)))
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(`prepare-next-batch: ${error.message}`);
    process.exitCode = 1;
  });
