import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { containedFile, identity, isMain, options, sha256, writeJSON } from "./lib.mjs";

const HEX64 = /^[a-f0-9]{64}$/;

export function validateFullReview(review) {
  const { width, height, rows } = review;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > 8192 || height > 8192 ||
      !Array.isArray(rows) || rows.length !== height ||
      typeof review.approved !== "boolean" || typeof review.humanReviewed !== "boolean")
    throw new Error("Invalid full-raster review dimensions or flags");
  if (review.approved && !review.humanReviewed)
    throw new Error("An unreviewed prediction cannot be human-approved");
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    if (row?.y !== y || !Array.isArray(row.runs)) throw new Error("Invalid review row");
    let edge = 0;
    for (const run of row.runs) {
      if (!Array.isArray(run) || run.length !== 3) throw new Error("Invalid review run");
      const [x0, x1, label] = run;
      if (![x0, x1, label].every(Number.isInteger) || x0 !== edge || x1 <= x0 ||
          x1 > width || label < 1 || label > 3) throw new Error("Invalid full-raster review run");
      edge = x1;
    }
    if (edge !== width) throw new Error("Incomplete full-raster review");
  }
}

export async function importBackup({ backup, output, prefix = "production/label-lab/v1" }, progress = () => {}) {
  backup = resolve(backup);
  output = resolve(output);
  const outputRelative = relative(backup, output);
  if (!outputRelative || (!isAbsolute(outputRelative) && outputRelative !== ".." && !outputRelative.startsWith(".." + sep)))
    throw new Error("Output must be outside the unchanged backup");
  const rawInventory = await readFile(join(backup, "inventory.json"));
  const expected = (await readFile(join(backup, "inventory.sha256"), "utf8")).trim().split(/\s+/)[0];
  if (!HEX64.test(expected) || sha256(rawInventory) !== expected) throw new Error("Backup inventory checksum mismatch");
  const inventory = JSON.parse(rawInventory);
  if (inventory.schema !== "ballroller-r2-local-backup/v1" ||
      !Array.isArray(inventory.objects) || inventory.objects.length !== inventory.objectCount)
    throw new Error("Unsupported backup inventory");
  const entries = new Map();
  for (const entry of inventory.objects) {
    if (typeof entry.key !== "string" || entries.has(entry.key) ||
        !HEX64.test(entry.localSha256) || !Number.isSafeInteger(entry.size) || entry.size < 0)
      throw new Error("Invalid or duplicate inventory entry");
    entries.set(entry.key, entry);
  }
  const verified = new Map();
  async function verify(key) {
    if (verified.has(key)) return verified.get(key);
    const entry = entries.get(key);
    if (!entry) throw new Error("Missing backup object: " + key);
    const path = await containedFile(join(backup, "objects"), key);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(path)) { hash.update(chunk); size += chunk.length; }
    if (size !== entry.size || hash.digest("hex") !== entry.localSha256)
      throw new Error("Backup object checksum mismatch: " + key);
    verified.set(key, path);
    return path;
  }
  const json = async (key) => JSON.parse(await readFile(await verify(key), "utf8"));
  const current = await json(prefix + "/current.json");
  if (current.schema !== "brg-label-lab-r2-current/v1" || !HEX64.test(current.datasetId) ||
      current.manifest?.key !== prefix + "/snapshots/" + current.datasetId + "/manifest.json")
    throw new Error("Unsupported source current pointer");
  async function descriptorPath(descriptor) {
    const entry = entries.get(descriptor?.key);
    if (!entry || descriptor.sha256 !== entry.localSha256 || descriptor.bytes !== entry.size)
      throw new Error("Source descriptor disagrees with backup inventory");
    return verify(descriptor.key);
  }
  const manifest = JSON.parse(await readFile(await descriptorPath(current.manifest), "utf8"));
  if (manifest.schema !== "brg-label-lab-r2-snapshot/v1" || manifest.datasetId !== current.datasetId ||
      manifest.prefix !== prefix || !manifest.pixelLabels || Object.keys(manifest.pixelLabels).length !== 4 ||
      !Object.entries({ automatic: 0, land: 1, sea: 2, sky: 3 }).every(([key, value]) => manifest.pixelLabels[key] === value))
    throw new Error("Unsupported source snapshot or pixel-label mapping");
  await mkdir(output); // Refuse to overwrite any previous export.
  await mkdir(join(output, "media"));
  const copied = new Map();
  async function materialize(descriptor) {
    const source = await descriptorPath(descriptor);
    if (copied.has(descriptor.key)) return copied.get(descriptor.key);
    const extension = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/json": ".json" }[descriptor.contentType];
    if (!extension) throw new Error("Unsupported source content type");
    const relative = "media/" + descriptor.sha256 + extension;
    await copyFile(source, join(output, relative));
    copied.set(descriptor.key, relative);
    return relative;
  }
  const source = { schema: "horizon-scribe-source/v1", pixelLabels: manifest.pixelLabels, sets: [] };
  const reviews = [];
  const seen = new Set();
  let imageCount = 0;
  for (const set of manifest.sets) {
    const converted = { id: set.id, label: set.label, sourceProfile: set.sourceProfile, images: [] };
    if (set.scene) converted.scene = await materialize(set.scene);
    for (const image of set.images) {
      const id = identity(set.id, image.name);
      if (seen.has(id)) throw new Error("Duplicate source image identity");
      seen.add(id);
      const item = { name: image.name, width: image.width, height: image.height,
        pixelDomain: image.pixelDomain, photo: await materialize(image.photo), baseMask: await materialize(image.baseMask) };
      if (image.review) {
        item.review = { ...image.review,
          classMask: await materialize(image.review.classMask), effectiveMask: await materialize(image.review.effectiveMask) };
      }
      const key = prefix + "/cloud-reviews/" + current.datasetId + "/" + set.id + "/" + image.name + "/current.json";
      if (entries.has(key)) {
        const latest = await json(key);
        if (latest.schema !== "brg-label-lab-cloud-review-current/v1" && latest.schema !== "brg-label-lab-cloud-review-pointer/v1")
          throw new Error("Unsupported source review pointer schema: " + latest.schema);
        if (latest.datasetId !== current.datasetId || latest.setId !== set.id || latest.image !== image.name ||
            latest.representation !== "full-class-raster/v1" || !HEX64.test(latest.cloudRevision))
          throw new Error("Source review identity or representation mismatch");
        const review = { setId: set.id, image: image.name, width: image.width, height: image.height,
          sourceRevision: latest.cloudRevision, snapshotRevision: image.review?.revision ?? null,
          approved: latest.approved, humanReviewed: latest.humanReviewed ?? true,
          rows: latest.rows, updatedAt: latest.updatedAt ?? null };
        validateFullReview(review);
        reviews.push(review);
      }
      converted.images.push(item);
      imageCount++;
      if (imageCount % 250 === 0) progress("Verified/copied " + imageCount + " photos and matching artifacts");
    }
    source.sets.push(converted);
  }
  const pointerKeys = [...entries.keys()].filter((key) => key.startsWith(prefix + "/cloud-reviews/" + current.datasetId + "/") && key.endsWith("/current.json"));
  if (pointerKeys.length !== reviews.length) throw new Error("Backup contains current reviews outside the source snapshot");
  let queue = null;
  const queueKey = prefix + "/next-pass/" + current.datasetId + "/current.json";
  if (entries.has(queueKey)) {
    const previous = await json(queueKey);
    if (previous.schema !== "brg-label-lab-next-pass-selection/v1" || previous.datasetId !== current.datasetId || !Array.isArray(previous.selectedImages))
      throw new Error("Invalid source queue");
    queue = { schema: "horizon-scribe-next-batch-source/v1", runId: previous.runId ?? null,
      modelId: previous.modelId ?? null, predictionSetId: previous.predictionSetId ?? null,
      images: previous.selectedImages };
    for (const image of queue.images) if (!seen.has(identity(image.setId, image.image))) throw new Error("Source queue image is missing");
    await writeJSON(join(output, "next-batch.json"), queue);
  }
  await writeJSON(join(output, "reviews.json"), { schema: "horizon-scribe-review-restore/v1", sourceDatasetId: current.datasetId, reviews });
  await writeJSON(join(output, "source.json"), source);
  const report = { schema: "horizon-scribe-backup-import/v1", sourceDatasetId: current.datasetId,
    backupInventorySha256: expected, source: join(output, "source.json"), reviews: join(output, "reviews.json"),
    queue: queue ? join(output, "next-batch.json") : null, sets: source.sets.length, images: imageCount,
    latestReviews: reviews.length, humanApproved: reviews.filter((r) => r.approved && r.humanReviewed).length,
    unreviewedPredictions: reviews.filter((r) => !r.humanReviewed).length, queueImages: queue?.images.length ?? 0,
    verifiedObjects: verified.size, copiedBlobs: copied.size,
    note: "Photos/masks copied without re-encoding. Latest cloud reviews must be restored separately through the API. Original revision history remains in the unchanged backup." };
  await writeJSON(join(output, "import-report.json"), report);
  return report;
}

if (isMain(import.meta.url)) {
  try { console.log(JSON.stringify(await importBackup(options(process.argv.slice(2),
    { backup: null, output: null, prefix: "production/label-lab/v1" }, ["backup", "output"]), console.error), null, 2)); }
  catch (error) { console.error("import-label-lab-backup: " + error.message); process.exitCode = 1; }
}
