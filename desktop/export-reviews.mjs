import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { options, writeJSON, isMain } from "./lib.mjs";

export async function exportReviews(
  { url, output },
  token = process.env.HORIZON_SCRIBE_API_TOKEN,
) {
  const base = new URL(url);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw new Error("Worker URL must be a root HTTPS URL");
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token ?? ""))
    throw new Error(
      "Set HORIZON_SCRIBE_API_TOKEN in this process (never pass it as a command-line argument)",
    );
  async function get(path) {
    const response = await fetch(new URL(path, base), {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok)
      throw new Error(`Worker returned HTTP ${response.status}`);
    return response.json();
  }
  const catalog = await get("/v1/catalog");
  if (
    catalog.schema !== "horizon-scribe-cloud-catalog/v1" ||
    !/^[a-f0-9]{64}$/.test(catalog.datasetId)
  )
    throw new Error("Invalid catalog");
  const query = `?dataset=${catalog.datasetId}`,
    training = await get(`/v1/training-manifest${query}`);
  await mkdir(output);
  await writeJSON(join(output, "catalog.json"), catalog);
  await writeJSON(join(output, "training-manifest.json"), training);
  const images = [];
  for (const set of catalog.sets)
    for (const image of set.images) {
      if (!image.cloudRevision) continue;
      const state = await get(
        `/v1/sets/${encodeURIComponent(set.id)}/images/${encodeURIComponent(image.name)}${query}`,
      );
      if (
        state.datasetId !== catalog.datasetId ||
        state.correction.revision !== image.cloudRevision ||
        state.correction.representation !== "full-class-raster/v1"
      )
        throw new Error(
          "Review changed during export; retry into a fresh output folder",
        );
      const { width, height } = state;
      if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > 8192 ||
        height > 8192 ||
        state.correction.rows.length !== height
      )
        throw new Error("Invalid review dimensions");
      const pixels = Buffer.alloc(width * height);
      for (let y = 0; y < height; y++) {
        const row = state.correction.rows[y];
        let edge = 0;
        if (row.y !== y) throw new Error("Invalid review rows");
        for (const [x0, x1, label] of row.runs) {
          if (
            ![x0, x1, label].every(Number.isInteger) ||
            x0 !== edge ||
            x1 <= x0 ||
            x1 > width ||
            label < 1 ||
            label > 3
          )
            throw new Error("Invalid review runs");
          pixels.fill(label, y * width + x0, y * width + x1);
          edge = x1;
        }
        if (edge !== width) throw new Error("Incomplete review raster");
      }
      const filename = `${String(images.length).padStart(6, "0")}.labels.png`,
        stateFile = `${String(images.length).padStart(6, "0")}.state.json`;
      await sharp(pixels, { raw: { width, height, channels: 1 } })
        .toColourspace("b-w")
        .png()
        .toFile(join(output, filename));
      await writeJSON(join(output, stateFile), state);
      images.push({
        setId: set.id,
        image: image.name,
        revision: image.cloudRevision,
        approved: state.correction.approved,
        classMask: filename,
        state: stateFile,
      });
    }
  await writeJSON(join(output, "manifest.json"), {
    schema: "horizon-scribe-review-export/v1",
    datasetId: catalog.datasetId,
    exportedAt: new Date().toISOString(),
    images,
  });
  return {
    output,
    images: images.length,
    note: "Export includes cloud-saved full rasters. Snapshot-only imported reviews remain in their original source files.",
  };
}
if (isMain(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(
        await exportReviews(
          options(process.argv.slice(2), { url: null, output: null }, [
            "url",
            "output",
          ]),
        ),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`export-reviews: ${error.message}`);
    process.exitCode = 1;
  }
}
