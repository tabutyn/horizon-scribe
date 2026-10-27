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

const SHEET_COLUMNS = 4;
const SHEET_ROWS = 4;
const SHEET_SIZE = SHEET_COLUMNS * SHEET_ROWS;
const CELL_WIDTH = 480;
const CELL_HEIGHT = 300;

async function buildSheetImage(output, sheetIndex, cells, kind) {
  await sharp({
    create: {
      width: SHEET_COLUMNS * CELL_WIDTH,
      height: SHEET_ROWS * CELL_HEIGHT,
      channels: 3,
      background: { r: 8, g: 18, b: 25 },
    },
  })
    .composite(
      cells.map((input, slot) => ({
        input,
        left: (slot % SHEET_COLUMNS) * CELL_WIDTH,
        top: Math.floor(slot / SHEET_COLUMNS) * CELL_HEIGHT,
      })),
    )
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(join(output, "media", `sheet-${sheetIndex}.${kind}.jpg`));
}

async function buildPreview({ photo, image, prediction, maskRecord }, predictions) {
  let pixels;
  if (prediction) {
    pixels = await maskPixels(
      resolve(dirname(predictions), prediction.classMask),
      image.width,
      image.height,
      true,
    );
  } else {
    await verifiedFile(maskRecord);
    pixels = await maskPixels(
      maskRecord.localPath,
      image.width,
      image.height,
    );
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
      prediction
        ? palette[small[p]]
        : small[p] === 0
          ? [255, 150, 40, 125]
          : [0, 0, 0, 0],
      p * 4,
    );
  const overlay = await sharp(thumbnail.data)
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
    .toBuffer();
  const cell = (input) =>
    sharp(input)
      .resize({
        width: CELL_WIDTH,
        height: CELL_HEIGHT,
        fit: "contain",
        background: { r: 8, g: 18, b: 25 },
      })
      .jpeg({ quality: 88 })
      .toBuffer();
  const [photoCell, overlayCell] = await Promise.all([
    cell(thumbnail.data),
    cell(overlay),
  ]);
  return { photo: photoCell, overlay: overlayCell };
}

export async function buildReview({
  snapshot,
  plan,
  output,
  predictions = null,
  reviews = null,
  candidates = "all",
}) {
  if (!["all", "predictions"].includes(candidates))
    throw new Error("Candidates must be all or predictions");
  if (candidates === "predictions" && !predictions)
    throw new Error("Prediction-only review requires a prediction source");
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
  if (candidates === "predictions" && !predictionMap.size)
    throw new Error("Prediction-only review has no predictions");
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
  const rows = [],
    sources = new Map();
  for (const set of manifest.sets)
    for (const image of set.images) {
      const prediction = predictionMap.get(identity(set.id, image.name));
      if (candidates === "predictions" && !prediction) continue;
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
      const maskRecord = prediction ? null : byKey.get(image.baseMask.key);
      if (!prediction && maskRecord?.sha256 !== image.baseMask.sha256)
        throw new Error("Base mask evidence does not match snapshot");
      const index = rows.length,
        mode = prediction ? "prediction" : "base-mask";
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
      sources.set(index, { photo, image, prediction, maskRecord });
    }
  const reviewRows = rows
    .filter((row) => !row.approved)
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.setId.localeCompare(right.setId) ||
        left.image.localeCompare(right.image),
    );
  const sheets = [];
  for (let offset = 0; offset < reviewRows.length; offset += SHEET_SIZE) {
    const sheetRows = reviewRows.slice(offset, offset + SHEET_SIZE),
      index = sheets.length;
    for (const [slot, row] of sheetRows.entries()) {
      row.sheetIndex = index;
      row.sheetSlot = slot;
    }
    const previews = [];
    for (const row of sheetRows)
      previews.push(await buildPreview(sources.get(row.index), predictions));
    await Promise.all([
      buildSheetImage(
        output,
        index,
        previews.map((preview) => preview.photo),
        "photo",
      ),
      buildSheetImage(
        output,
        index,
        previews.map((preview) => preview.overlay),
        "overlay",
      ),
    ]);
    sheets.push({
      index,
      columns: SHEET_COLUMNS,
      rows: SHEET_ROWS,
      imageIndexes: sheetRows.map((row) => row.index),
    });
  }
  const bundle = {
    schema: "horizon-scribe-review-bundle/v1",
    datasetId: manifest.datasetId,
    snapshotSha256: sha256(raw),
    generatedAt: new Date().toISOString(),
    reviewStatus: cloud ? "exported-cloud-catalog" : "snapshot-only",
    candidateMode: candidates,
    predictionCoverage: { predicted: predictionMap.size, total: available.size },
    predictionProvenance: supplied?.provenance ?? null,
    runId: supplied?.runId ?? null,
    modelId: supplied?.modelId ?? null,
    predictionSetId: supplied?.predictionSetId ?? null,
    sheetPolicy: "one-selection-per-sheet",
    sheetCandidateStatus: "unapproved",
    sheets,
    images: rows,
  };
  await writeJSON(join(output, "manifest.json"), bundle);
  return {
    bundle: resolve(output),
    datasetId: manifest.datasetId,
    images: rows.length,
    sheets: sheets.length,
    reviewCandidates: reviewRows.length,
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
              candidates: "all",
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
