import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import sharp from "sharp";
import { maskPixels } from "./lib.mjs";

const SOURCE_SCHEMA = "horizon-scribe-source/v1";
const SNAPSHOT_SCHEMA = "horizon-scribe-r2-snapshot/v1";
const CURRENT_SCHEMA = "horizon-scribe-r2-current/v1";
const PLAN_SCHEMA = "horizon-scribe-r2-upload-object/v1";
const DEFAULT_PREFIX = "production/horizon-scribe/v1";

function fail(message) {
  throw new Error(message);
}

function parseOptions(values) {
  const result = {
    source: null,
    output: resolve("snapshots"),
    prefix: DEFAULT_PREFIX,
  };
  while (values.length) {
    const flag = values.shift();
    if (flag === "--source") result.source = values.shift();
    else if (flag === "--output") result.output = resolve(values.shift());
    else if (flag === "--prefix") result.prefix = values.shift();
    else fail(`Unknown option: ${flag}`);
  }
  if (!result.source)
    fail(
      "Usage: node desktop/prepare-dataset.mjs --source source.json [--output snapshots] [--prefix production/horizon-scribe/v1]",
    );
  result.source = resolve(result.source);
  result.prefix = String(result.prefix ?? "").replace(/^\/+|\/+$/g, "");
  if (
    !result.prefix ||
    result.prefix.includes("//") ||
    result.prefix.startsWith(".")
  )
    fail("R2 prefix is invalid.");
  return result;
}

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalized(value[key])]),
    );
  return value;
}

function canonical(value) {
  return Buffer.from(JSON.stringify(normalized(value)) + "\n");
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function contentType(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".json") return "application/json";
  return "application/octet-stream";
}

function safeComponent(value, label) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 200 ||
    value === "." ||
    value === ".." ||
    /[\\/\x00-\x1f\x7f]/.test(value)
  )
    fail(`Invalid ${label}: ${JSON.stringify(value)}`);
  return value;
}

class BlobIndex {
  constructor(prefix, sourceDirectory) {
    this.prefix = prefix;
    this.sourceDirectory = sourceDirectory;
    this.byDigest = new Map();
  }

  async add(relativePath, role) {
    if (typeof relativePath !== "string" || !relativePath)
      fail(`${role} path is required.`);
    const path = resolve(this.sourceDirectory, relativePath);
    const metadata = await stat(path);
    if (!metadata.isFile()) fail(`${role} is not a file: ${path}`);
    const bytes = await readFile(path);
    const digest = sha256(bytes);
    let blob = this.byDigest.get(digest);
    if (blob) {
      if (blob.bytes !== metadata.size)
        fail(`SHA-256 collision with differing sizes: ${path}`);
      blob.roles.add(role);
      return blob;
    }
    blob = {
      path,
      key: `${this.prefix}/blobs/sha256/${digest.slice(0, 2)}/${digest}`,
      bytes: metadata.size,
      sha256: digest,
      contentType: contentType(path),
      roles: new Set([role]),
    };
    this.byDigest.set(digest, blob);
    return blob;
  }
}

function descriptor(blob) {
  return {
    key: blob.key,
    bytes: blob.bytes,
    sha256: blob.sha256,
    contentType: blob.contentType,
  };
}

function uploadRecord(blob, immutable = true) {
  return {
    schema: PLAN_SCHEMA,
    localPath: blob.path,
    key: blob.key,
    bytes: blob.bytes,
    sha256: blob.sha256,
    contentType: blob.contentType,
    cacheControl: immutable
      ? "private, max-age=31536000, immutable"
      : "no-store",
    immutable,
    roles: [...blob.roles].sort(),
  };
}

async function prepare(options) {
  const source = JSON.parse(await readFile(options.source, "utf8"));
  if (
    source?.schema !== SOURCE_SCHEMA ||
    !Array.isArray(source.sets) ||
    source.sets.length === 0
  )
    fail(`Source must use ${SOURCE_SCHEMA} and contain at least one set.`);
  const sourceDirectory = dirname(options.source);
  const blobs = new BlobIndex(options.prefix, sourceDirectory);
  const sets = [];
  const setIDs = new Set();
  let imageCount = 0;
  let approvedCount = 0;
  for (const inputSet of source.sets) {
    const id = safeComponent(inputSet?.id, "set ID");
    if (setIDs.has(id)) fail(`Duplicate set ID: ${id}`);
    setIDs.add(id);
    if (!Array.isArray(inputSet.images) || inputSet.images.length === 0)
      fail(`Set ${id} has no images.`);
    const images = [];
    const imageNames = new Set();
    for (const inputImage of inputSet.images) {
      const name = safeComponent(inputImage?.name, `image name in ${id}`);
      if (imageNames.has(name)) fail(`Duplicate image in ${id}: ${name}`);
      imageNames.add(name);
      const width = Number(inputImage.width),
        height = Number(inputImage.height);
      if (
        !Number.isSafeInteger(width) ||
        width < 1 ||
        width > 8192 ||
        !Number.isSafeInteger(height) ||
        height < 1 ||
        height > 8192
      )
        fail(`Invalid dimensions for ${id}/${name}; maximum is 8192 per side.`);
      const photoInfo = await sharp(
        resolve(sourceDirectory, inputImage.photo),
      ).metadata();
      if (
        !["jpeg", "png", "webp"].includes(photoInfo.format) ||
        photoInfo.width !== width ||
        photoInfo.height !== height ||
        (photoInfo.orientation ?? 1) !== 1 ||
        (photoInfo.pages ?? 1) > 1
      )
        fail(
          `Photo dimensions, orientation, or format are invalid for ${id}/${name}; use import-photos first.`,
        );
      await maskPixels(
        resolve(sourceDirectory, inputImage.baseMask),
        width,
        height,
      );
      const photo = await blobs.add(inputImage.photo, `photo:${id}/${name}`);
      const baseMask = await blobs.add(
        inputImage.baseMask,
        `base-mask:${id}/${name}`,
      );
      let review = null;
      if (inputImage.review) {
        await maskPixels(
          resolve(sourceDirectory, inputImage.review.classMask),
          width,
          height,
          true,
        );
        await maskPixels(
          resolve(sourceDirectory, inputImage.review.effectiveMask),
          width,
          height,
        );
        const classMask = await blobs.add(
          inputImage.review.classMask,
          `class-mask:${id}/${name}`,
        );
        const effectiveMask = await blobs.add(
          inputImage.review.effectiveMask,
          `effective-mask:${id}/${name}`,
        );
        const revision = String(inputImage.review.revision ?? "");
        if (!/^[a-f0-9]{64}$/.test(revision))
          fail(`Review revision must be a SHA-256 digest for ${id}/${name}.`);
        review = {
          revision,
          parentRevision: inputImage.review.parentRevision ?? null,
          approved: Boolean(inputImage.review.approved),
          createdAt: inputImage.review.createdAt ?? null,
          counts: inputImage.review.counts ?? null,
          effectiveCounts: inputImage.review.effectiveCounts ?? null,
          classMask: descriptor(classMask),
          effectiveMask: descriptor(effectiveMask),
        };
        approvedCount += Number(review.approved);
      }
      images.push({
        name,
        width,
        height,
        pixelDomain: inputImage.pixelDomain ?? "source-image/v1",
        photo: descriptor(photo),
        baseMask: descriptor(baseMask),
        review,
      });
      imageCount += 1;
    }
    const scene = inputSet.scene
      ? descriptor(await blobs.add(inputSet.scene, `scene:${id}`))
      : null;
    sets.push({
      id,
      label: String(inputSet.label ?? id),
      sourceProfile: String(inputSet.sourceProfile ?? "default/v1"),
      scene,
      images,
    });
  }

  const dataset = {
    prefix: options.prefix,
    pixelLabels: source.pixelLabels ?? {
      automatic: 0,
      land: 1,
      sea: 2,
      sky: 3,
    },
    maskSemantics: source.maskSemantics ?? {
      baseMask:
        "one-channel PNG; 255 keeps the foreground class and 0 removes it",
      effectiveMask: "base mask overridden by reviewed class labels",
      classMask: "one-channel PNG with 0 automatic, 1 land, 2 sea, 3 sky",
    },
    sets,
  };
  const datasetId = sha256(canonical(dataset));
  const capturedAt = new Date().toISOString();
  const manifest = {
    schema: SNAPSHOT_SCHEMA,
    datasetId,
    capturedAt,
    statistics: {
      sets: sets.length,
      images: imageCount,
      baseMasks: imageCount,
      currentReviews: sets
        .flatMap((set) => set.images)
        .filter((image) => image.review).length,
      approvedReviews: approvedCount,
      uniqueBlobs: blobs.byDigest.size,
      uniqueBytes: [...blobs.byDigest.values()].reduce(
        (sum, blob) => sum + blob.bytes,
        0,
      ),
    },
    ...dataset,
  };
  await mkdir(options.output, { recursive: true });
  const outputDirectory = resolve(options.output, datasetId);
  await mkdir(outputDirectory);
  const manifestPath = resolve(outputDirectory, "manifest.json");
  const manifestBytes = canonical(manifest);
  await writeFile(manifestPath, manifestBytes);
  const manifestKey = `${options.prefix}/snapshots/${datasetId}/manifest.json`;
  const current = {
    schema: CURRENT_SCHEMA,
    datasetId,
    manifest: {
      key: manifestKey,
      bytes: manifestBytes.length,
      sha256: sha256(manifestBytes),
      contentType: "application/json",
    },
    updatedAt: capturedAt,
  };
  const currentPath = resolve(outputDirectory, "current.json");
  const currentBytes = canonical(current);
  await writeFile(currentPath, currentBytes);
  const records = [...blobs.byDigest.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((blob) => uploadRecord(blob));
  records.push(
    uploadRecord({
      path: manifestPath,
      key: manifestKey,
      bytes: manifestBytes.length,
      sha256: sha256(manifestBytes),
      contentType: "application/json",
      roles: new Set(["snapshot-manifest"]),
    }),
  );
  records.push(
    uploadRecord(
      {
        path: currentPath,
        key: `${options.prefix}/current.json`,
        bytes: currentBytes.length,
        sha256: sha256(currentBytes),
        contentType: "application/json",
        roles: new Set(["current-snapshot-pointer"]),
      },
      false,
    ),
  );
  const planPath = resolve(outputDirectory, "upload-plan.jsonl");
  await writeFile(
    planPath,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  return {
    schema: "horizon-scribe-r2-snapshot-result/v1",
    datasetId,
    outputDirectory,
    manifest: manifestPath,
    uploadPlan: planPath,
    statistics: manifest.statistics,
  };
}

prepare(parseOptions(process.argv.slice(2)))
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(`prepare-dataset: ${error.message}`);
    process.exitCode = 1;
  });
