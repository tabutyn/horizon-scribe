import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { containedFile, identity, isMain, maskPixels, options, readJSON, sha256, writeJSON } from "./lib.mjs";
import { validateFullReview } from "./import-label-lab-backup.mjs";

export async function predictionsFromExport({ input, output }) {
  input = resolve(input);
  output = resolve(output);
  const manifest = await readJSON(join(input, "manifest.json"));
  if (manifest.schema !== "horizon-scribe-review-export/v1" ||
      !/^[a-f0-9]{64}$/.test(manifest.datasetId ?? "") || !Array.isArray(manifest.images))
    throw new Error("Invalid completed review export");
  const selected = [], seen = new Set();
  for (const image of manifest.images) {
    const key = identity(image.setId, image.image);
    if (seen.has(key)) throw new Error("Duplicate exported image");
    seen.add(key);
    const state = await readJSON(await containedFile(input, image.state));
    if (state.schema !== "horizon-scribe-cloud-review-state/v1" || state.datasetId !== manifest.datasetId ||
        state.setId !== image.setId || state.image !== image.image || state.correction.revision !== image.revision ||
        !/^[a-f0-9]{64}$/.test(image.revision ?? "")) throw new Error("Exported review identity/revision mismatch");
    if (state.correction.humanReviewed !== false) continue;
    if (state.correction.approved || state.correction.representation !== "full-class-raster/v1")
      throw new Error("Unreviewed prediction has invalid approval or representation");
    validateFullReview({ ...state.correction, width: state.width, height: state.height });
    const path = await containedFile(input, image.classMask);
    const pixels = await maskPixels(path, state.width, state.height, true);
    const expected = Buffer.alloc(state.width * state.height);
    for (const row of state.correction.rows) for (const [x0, x1, label] of row.runs)
      expected.fill(label, row.y * state.width + x0, row.y * state.width + x1);
    if (!pixels.equals(expected)) throw new Error("Prediction PNG differs from saved label rows");
    selected.push({ image, path });
  }
  if (!selected.length) throw new Error("Export contains no explicitly unreviewed predictions");
  await mkdir(output); // Never replace an existing round or selection.
  const images = [];
  for (const { image, path } of selected) {
    const filename = String(images.length).padStart(6, "0") + ".labels.png";
    await copyFile(path, join(output, filename));
    images.push({ setId: image.setId, image: image.image, classMask: filename,
      sourceRevision: image.revision, priority: 0 });
  }
  const result = { schema: "horizon-scribe-predictions-source/v1", datasetId: manifest.datasetId,
    modelId: null, runId: null,
    predictionSetId: "recovered-" + sha256(JSON.stringify(images.map(({ setId, image, sourceRevision }) =>
      [setId, image, sourceRevision]))).slice(0, 24),
    provenance: { kind: "recovered-unreviewed-cloud-predictions", sourceExportedAt: manifest.exportedAt ?? null,
      note: "Recovered saved predictions, not fresh inference. Original model/run identity is unavailable. Human-reviewed labels are excluded." },
    images };
  const source = join(output, "predictions.json");
  await writeJSON(source, result);
  return { source, images: images.length, datasetId: manifest.datasetId, note: result.provenance.note };
}

if (isMain(import.meta.url)) {
  try { console.log(JSON.stringify(await predictionsFromExport(options(process.argv.slice(2),
    { input: null, output: null }, ["input", "output"])), null, 2)); }
  catch (error) { console.error("predictions-from-export: " + error.message); process.exitCode = 1; }
}
