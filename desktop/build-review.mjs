import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import sharp from "sharp";
import {
  options,
  readJSON,
  writeJSON,
  verifiedFile,
  sha256,
  identity,
  maskPixels,
  isMain,
} from "./lib.mjs";

export async function buildReview({
  snapshot,
  plan,
  output,
  predictions = null,
  reviews = null,
}) {
  const raw = await readFile(snapshot),
    manifest = JSON.parse(raw);
  if (
    manifest.schema !== "horizon-scribe-r2-snapshot/v1" ||
    !/^[a-f0-9]{64}$/.test(manifest.datasetId)
  )
    throw new Error("Invalid HorizonScribe snapshot");
  const records = (await readFile(plan, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse);
  const byKey = new Map(records.map((record) => [record.key, record]));
  if (
    byKey.size !== records.length ||
    records.some(
      (record) => record.schema !== "horizon-scribe-r2-upload-object/v1",
    )
  )
    throw new Error("Invalid or duplicate upload records");
  const manifestRecord = byKey.get(
    `${manifest.prefix}/snapshots/${manifest.datasetId}/manifest.json`,
  );
  if (manifestRecord?.sha256 !== sha256(raw))
    throw new Error("Snapshot does not match its upload plan");
  const supplied = predictions ? await readJSON(predictions) : null;
  if (
    supplied &&
    (supplied.schema !== "horizon-scribe-predictions-source/v1" ||
      !Array.isArray(supplied.images))
  )
    throw new Error("Invalid prediction source");
  if (supplied?.datasetId && supplied.datasetId !== manifest.datasetId)
    throw new Error("Predictions belong to a different dataset");
  const predictionMap = new Map(
    (supplied?.images ?? []).map((item) => [
      identity(item.setId, item.image),
      item,
    ]),
  );
  const available = new Set(
    manifest.sets.flatMap((set) =>
      set.images.map((image) => identity(set.id, image.name)),
    ),
  );
  if (
    predictionMap.size !== (supplied?.images.length ?? 0) ||
    [...predictionMap.keys()].some((key) => !available.has(key))
  )
    throw new Error("Unknown or duplicate prediction image");
  const cloud = reviews ? await readJSON(reviews) : null;
  if (
    cloud &&
    (cloud.schema !== "horizon-scribe-cloud-catalog/v1" ||
      cloud.datasetId !== manifest.datasetId)
  )
    throw new Error("Review catalog belongs to a different snapshot");
  const cloudImages = new Map(
    (cloud?.sets ?? []).flatMap((set) =>
      set.images.map((image) => [identity(set.id, image.name), image]),
    ),
  );
  await mkdir(output);
  await mkdir(join(output, "media"));
  const rows = [];
  for (const set of manifest.sets)
    for (const image of set.images) {
      const record = byKey.get(image.photo.key);
      if (record?.sha256 !== image.photo.sha256)
        throw new Error("Photo evidence does not match snapshot");
      const photo = await verifiedFile(record),
        info = await sharp(photo).metadata();
      if (
        info.width !== image.width ||
        info.height !== image.height ||
        (info.orientation ?? 1) !== 1
      )
        throw new Error(
          "Photo dimensions/orientation do not match snapshot; use import-photos first",
        );
      const prediction = predictionMap.get(identity(set.id, image.name));
      let pixels, mode;
      if (prediction) {
        pixels = await maskPixels(
          resolve(dirname(predictions), prediction.classMask),
          image.width,
          image.height,
          true,
        );
        mode = "prediction";
      } else {
        const maskRecord = byKey.get(image.baseMask.key);
        if (maskRecord?.sha256 !== image.baseMask.sha256)
          throw new Error("Base mask evidence does not match snapshot");
        await verifiedFile(maskRecord);
        pixels = await maskPixels(
          maskRecord.localPath,
          image.width,
          image.height,
        );
        mode = "base-mask";
      }
      const thumbnail = await sharp(photo)
        .resize({
          width: 640,
          height: 400,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      const small = await sharp(pixels, {
        raw: { width: image.width, height: image.height, channels: 1 },
      })
        .resize(thumbnail.info.width, thumbnail.info.height, {
          kernel: "nearest",
        })
        .toColourspace("b-w")
        .raw()
        .toBuffer();
      const rgba = Buffer.alloc(small.length * 4),
        palette = [
          [0, 0, 0, 0],
          [80, 220, 100, 105],
          [255, 85, 80, 125],
          [175, 110, 255, 125],
        ];
      for (let p = 0; p < small.length; p++)
        rgba.set(
          mode === "prediction"
            ? palette[small[p]]
            : small[p] === 0
              ? [255, 150, 40, 125]
              : [0, 0, 0, 0],
          p * 4,
        );
      const index = rows.length;
      await sharp(thumbnail.data).toFile(
        join(output, "media", `${index}.photo.jpg`),
      );
      await sharp(thumbnail.data)
        .composite([
          {
            input: rgba,
            raw: {
              width: thumbnail.info.width,
              height: thumbnail.info.height,
              channels: 4,
            },
          },
        ])
        .jpeg({ quality: 85 })
        .toFile(join(output, "media", `${index}.overlay.jpg`));
      const priority = prediction?.priority ?? 0;
      if (!Number.isFinite(priority))
        throw new Error("Prediction priority must be a finite number");
      rows.push({
        index,
        setId: set.id,
        setLabel: set.label,
        image: image.name,
        width: image.width,
        height: image.height,
        mode,
        priority,
        approved: Boolean(
          cloudImages.get(identity(set.id, image.name))?.approved ??
            image.review?.approved,
        ),
      });
    }
  const bundle = {
    schema: "horizon-scribe-review-bundle/v1",
    datasetId: manifest.datasetId,
    snapshotSha256: sha256(raw),
    generatedAt: new Date().toISOString(),
    reviewStatus: cloud ? "exported-cloud-catalog" : "snapshot-only",
    runId: supplied?.runId ?? null,
    modelId: supplied?.modelId ?? null,
    predictionSetId: supplied?.predictionSetId ?? null,
    images: rows,
  };
  await writeJSON(join(output, "manifest.json"), bundle);
  return {
    bundle: resolve(output),
    datasetId: manifest.datasetId,
    images: rows.length,
  };
}

if (isMain(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(
        await buildReview(
          options(
            process.argv.slice(2),
            {
              snapshot: null,
              plan: null,
              output: null,
              predictions: null,
              reviews: null,
            },
            ["snapshot", "plan", "output"],
          ),
        ),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`build-review: ${error.message}`);
    process.exitCode = 1;
  }
}
