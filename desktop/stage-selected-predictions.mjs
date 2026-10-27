import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  atomicJSON,
  identity,
  isMain,
  maskPixels,
  options,
  sha256,
  verifiedFile,
} from "./lib.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const localConnection = join(root, ".local", "ios-device.json");

function fullRows(prediction, baseMask, width, height) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const runs = [];
    let start = 0;
    let label = prediction[y * width] || (baseMask[y * width] === 0 ? 2 : 1);
    for (let x = 1; x <= width; x++) {
      const next =
        x < width
          ? prediction[y * width + x] ||
            (baseMask[y * width + x] === 0 ? 2 : 1)
          : null;
      if (next === label) continue;
      runs.push([start, x, label]);
      start = x;
      label = next;
    }
    rows.push({ y, runs });
  }
  return rows;
}

export async function stageSelectedPredictions(
  { url, snapshot, plan, selection, predictions, report },
  token = process.env.HORIZON_SCRIBE_API_TOKEN,
  fetcher = fetch,
  progress = () => {},
) {
  let base;
  try {
    base = new URL(url);
  } catch {}
  if (
    !base ||
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("Worker URL must be a root HTTPS URL");
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token ?? ""))
    throw new Error("A valid HorizonScribe API token is required");

  const [snapshotBytes, planText, selectionBytes, predictionBytes] =
    await Promise.all([
      readFile(snapshot),
      readFile(plan, "utf8"),
      readFile(selection),
      readFile(predictions),
    ]);
  const manifest = JSON.parse(snapshotBytes),
    selected = JSON.parse(selectionBytes),
    source = JSON.parse(predictionBytes);
  if (
    manifest.schema !== "horizon-scribe-r2-snapshot/v1" ||
    !/^[a-f0-9]{64}$/.test(manifest.datasetId ?? "") ||
    selected.schema !== "horizon-scribe-next-batch-source/v1" ||
    selected.datasetId !== manifest.datasetId ||
    !Array.isArray(selected.images) ||
    !selected.images.length ||
    selected.images.length > 500 ||
    source.schema !== "horizon-scribe-predictions-source/v1" ||
    source.datasetId !== manifest.datasetId ||
    !Array.isArray(source.images)
  )
    throw new Error("Snapshot, selection, and predictions must match");
  const records = planText.trim().split(/\r?\n/).map(JSON.parse),
    byObjectKey = new Map(records.map((record) => [record.key, record])),
    manifestRecord = byObjectKey.get(
      `${manifest.prefix}/snapshots/${manifest.datasetId}/manifest.json`,
    );
  if (
    byObjectKey.size !== records.length ||
    manifestRecord?.sha256 !== sha256(snapshotBytes)
  )
    throw new Error("Snapshot does not match its upload plan");
  const images = new Map(
      manifest.sets.flatMap((set) =>
        set.images.map((image) => [identity(set.id, image.name), image]),
      ),
    ),
    predictionMap = new Map(
      source.images.map((image) => [identity(image.setId, image.image), image]),
    ),
    seen = new Set(),
    prepared = [];
  if (predictionMap.size !== source.images.length)
    throw new Error("Duplicate prediction identity");

  async function request(path, body) {
    const response = await fetcher(new URL(path, base), {
      method: body ? "PUT" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok)
      throw new Error(
        `Prediction staging HTTP ${response.status}; no human review was overwritten`,
      );
    return response.json();
  }

  const catalog = await request("/v1/catalog");
  if (
    catalog.schema !== "horizon-scribe-cloud-catalog/v1" ||
    catalog.datasetId !== manifest.datasetId
  )
    throw new Error("Worker currently serves a different dataset");
  for (const selectedImage of selected.images) {
    const key = identity(selectedImage?.setId, selectedImage?.image),
      image = images.get(key),
      prediction = predictionMap.get(key);
    if (seen.has(key) || !image || !prediction)
      throw new Error("Every selected image must have one matching prediction");
    seen.add(key);
    const maskRecord = byObjectKey.get(image.baseMask.key);
    if (maskRecord?.sha256 !== image.baseMask.sha256)
      throw new Error("Base mask evidence does not match snapshot");
    const [predictionPixels, baseMask] = await Promise.all([
      maskPixels(
        resolve(dirname(predictions), prediction.classMask),
        image.width,
        image.height,
        true,
      ),
      verifiedFile(maskRecord).then((bytes) =>
        maskPixels(maskRecord.localPath, image.width, image.height).then(
          (pixels) => ({ bytes, pixels }),
        ),
      ),
    ]);
    const rows = fullRows(
        predictionPixels,
        baseMask.pixels,
        image.width,
        image.height,
      ),
      path = `/v1/sets/${encodeURIComponent(selectedImage.setId)}/images/${encodeURIComponent(selectedImage.image)}?dataset=${manifest.datasetId}`,
      state = await request(path);
    if (
      state.schema !== "horizon-scribe-cloud-review-state/v1" ||
      state.datasetId !== manifest.datasetId ||
      state.setId !== selectedImage.setId ||
      state.image !== selectedImage.image ||
      state.width !== image.width ||
      state.height !== image.height ||
      state.correction.approved ||
      state.correction.humanReviewed !== false
    )
      throw new Error(
        `Refusing to replace human-reviewed state: ${selectedImage.setId}/${selectedImage.image}`,
      );
    prepared.push({ selectedImage, image, prediction, path, rows, state });
  }

  const sourceSha256 = sha256(
      Buffer.concat([selectionBytes, predictionBytes, snapshotBytes]),
    ),
    result = {
      schema: "horizon-scribe-prediction-staging-result/v1",
      datasetId: manifest.datasetId,
      predictionSetId: source.predictionSetId ?? null,
      workerURL: base.origin,
      sourceSha256,
      images: [],
    };
  try {
    const previous = JSON.parse(await readFile(report, "utf8"));
    if (
      previous.schema !== result.schema ||
      previous.datasetId !== result.datasetId ||
      previous.predictionSetId !== result.predictionSetId ||
      previous.workerURL !== result.workerURL ||
      previous.sourceSha256 !== result.sourceSha256
    )
      throw new Error("Existing staging report belongs to another operation");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(report), { recursive: true });
  let staged = 0,
    resumed = 0;
  for (const [index, item] of prepared.entries()) {
    let state = item.state;
    const exact =
      /^[a-f0-9]{64}$/.test(state.correction.revision ?? "") &&
      state.correction.representation === "full-class-raster/v1" &&
      state.correction.approved === false &&
      state.correction.humanReviewed === false &&
      isDeepStrictEqual(state.correction.rows, item.rows);
    if (exact) resumed++;
    else {
      const operationId =
        "prediction-" +
        sha256(
          JSON.stringify([
            manifest.datasetId,
            item.selectedImage.setId,
            item.selectedImage.image,
            source.predictionSetId ?? null,
          ]),
        ).slice(0, 48);
      await request(item.path, {
        schema: "horizon-scribe-cloud-review-edit/v1",
        representation: "full-class-raster/v1",
        humanReviewed: false,
        approved: false,
        rows: item.rows,
        localBaseRevision: state.correction.localBaseRevision,
        cloudBaseRevision: state.correction.revision,
        operationId,
      });
      state = await request(item.path);
      if (
        state.correction.approved !== false ||
        state.correction.humanReviewed !== false ||
        state.correction.representation !== "full-class-raster/v1" ||
        !/^[a-f0-9]{64}$/.test(state.correction.revision ?? "") ||
        !isDeepStrictEqual(state.correction.rows, item.rows)
      )
        throw new Error("Staged prediction did not round-trip exactly");
      staged++;
    }
    result.images.push({
      setId: item.selectedImage.setId,
      image: item.selectedImage.image,
      revision: state.correction.revision,
      sourceClassMask: item.prediction.classMask,
    });
    await atomicJSON(report, result);
    progress(`Verified ${index + 1}/${prepared.length} selected predictions`);
  }
  result.completedAt = new Date().toISOString();
  await atomicJSON(report, result);
  return {
    status: "complete",
    datasetId: manifest.datasetId,
    predictionSetId: source.predictionSetId ?? null,
    selected: prepared.length,
    staged,
    resumed,
    report,
  };
}

async function savedConnection(url, token) {
  let config = {};
  try {
    config = JSON.parse(await readFile(localConnection, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Invalid saved iPad connection");
  }
  url ??= config.workerURL;
  token = token?.trim();
  if (!token) {
    if (process.platform !== "darwin")
      throw new Error("Set HORIZON_SCRIBE_API_TOKEN in this process");
    try {
      token = execFileSync(
        "/usr/bin/security",
        [
          "find-generic-password",
          "-s",
          config.keychainService,
          "-a",
          config.keychainAccount,
          "-w",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    } catch {
      throw new Error(
        "Could not read saved HorizonScribe token from Mac Keychain",
      );
    }
  }
  return { url, token };
}

if (isMain(import.meta.url)) {
  try {
    const args = options(
        process.argv.slice(2),
        {
          url: null,
          snapshot: null,
          plan: null,
          selection: null,
          predictions: null,
          report: null,
        },
        ["snapshot", "plan", "selection", "predictions", "report"],
      ),
      connection = await savedConnection(
        args.url,
        process.env.HORIZON_SCRIBE_API_TOKEN,
      );
    console.log(
      JSON.stringify(
        await stageSelectedPredictions(
          { ...args, url: connection.url },
          connection.token,
          fetch,
          console.error,
        ),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`stage-selected-predictions: ${error.message}`);
    process.exitCode = 1;
  }
}
