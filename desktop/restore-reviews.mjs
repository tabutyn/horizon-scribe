import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { atomicJSON, identity, isMain, options, sha256 } from "./lib.mjs";
import { validateFullReview } from "./import-label-lab-backup.mjs";

export async function restoreReviews({ url, dataset, input, report }, token = process.env.HORIZON_SCRIBE_API_TOKEN,
  fetcher = fetch, progress = () => {}) {
  const base = new URL(url);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/")
    throw new Error("Worker URL must be a root HTTPS URL");
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token ?? "") || !/^[a-f0-9]{64}$/.test(dataset ?? ""))
    throw new Error("A valid token and explicit destination dataset ID are required");
  const bytes = await readFile(input), source = JSON.parse(bytes);
  if (source.schema !== "horizon-scribe-review-restore/v1" || !Array.isArray(source.reviews) ||
      !/^[a-f0-9]{64}$/.test(source.sourceDatasetId ?? "")) throw new Error("Unsupported review restore input");
  const seen = new Set();
  for (const review of source.reviews) {
    validateFullReview(review);
    const key = identity(review.setId, review.image);
    if (seen.has(key) || typeof review.setId !== "string" || typeof review.image !== "string" ||
        !/^[a-f0-9]{64}$/.test(review.sourceRevision) ||
        (review.snapshotRevision !== null && !/^[a-f0-9]{64}$/.test(review.snapshotRevision)))
      throw new Error("Invalid or duplicate review identity");
    seen.add(key);
  }
  const sourceSha256 = sha256(bytes);
  const result = { schema: "horizon-scribe-review-restore-result/v1", sourceDatasetId: source.sourceDatasetId,
    datasetId: dataset, workerURL: base.origin, sourceSha256, images: [] };
  try {
    const previous = JSON.parse(await readFile(report, "utf8"));
    if (previous.schema !== result.schema || previous.sourceSha256 !== sourceSha256 ||
        previous.datasetId !== dataset || previous.workerURL !== base.origin)
      throw new Error("Existing restore report belongs to a different operation");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  async function request(path, body) {
    const response = await fetcher(new URL(path, base), { method: body ? "PUT" : "GET",
      headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, redirect: "error", signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error("Review restore HTTP " + response.status + "; no conflicting review was overwritten");
    return response.json();
  }
  const catalog = await request("/v1/catalog");
  if (catalog.schema !== "horizon-scribe-cloud-catalog/v1" || catalog.datasetId !== dataset)
    throw new Error("Destination dataset does not match; publish the intended snapshot first");
  const available = new Map(catalog.sets.flatMap((set) => set.images.map((image) => [identity(set.id, image.name), image])));
  for (const review of source.reviews) {
    const image = available.get(identity(review.setId, review.image));
    if (!image || image.width !== review.width || image.height !== review.height ||
        (image.localRevision ?? null) !== review.snapshotRevision)
      throw new Error("Destination image/base revision differs from the imported snapshot");
  }
  const sameReview = (state, review) => state.datasetId === dataset && state.setId === review.setId &&
    state.image === review.image && state.width === review.width && state.height === review.height &&
    state.correction.representation === "full-class-raster/v1" &&
    state.correction.localBaseRevision === review.snapshotRevision &&
    state.correction.approved === review.approved && state.correction.humanReviewed === review.humanReviewed &&
    isDeepStrictEqual(state.correction.rows, review.rows);
  let restored = 0, resumed = 0;
  for (const review of source.reviews) {
    const path = "/v1/sets/" + encodeURIComponent(review.setId) + "/images/" + encodeURIComponent(review.image) + "?dataset=" + dataset;
    let state = await request(path);
    if (state.schema !== "horizon-scribe-cloud-review-state/v1" || state.datasetId !== dataset ||
        state.setId !== review.setId || state.image !== review.image || state.width !== review.width || state.height !== review.height ||
        state.correction.localBaseRevision !== review.snapshotRevision) throw new Error("Destination image state changed");
    if (state.correction.revision) {
      if (!sameReview(state, review)) throw new Error("Destination already has different cloud edits; refusing to overwrite");
      resumed++;
    } else {
      await request(path, { schema: "horizon-scribe-cloud-review-edit/v1", representation: "full-class-raster/v1",
        humanReviewed: review.humanReviewed, approved: review.approved, rows: review.rows,
        localBaseRevision: review.snapshotRevision, cloudBaseRevision: null,
        operationId: "restore-" + sha256(JSON.stringify([dataset, review.setId, review.image, review.sourceRevision])).slice(0, 48) });
      state = await request(path);
      if (!sameReview(state, review) || !/^[a-f0-9]{64}$/.test(state.correction.revision ?? ""))
        throw new Error("Restored review did not round-trip exactly");
      restored++;
    }
    result.images.push({ setId: review.setId, image: review.image, sourceRevision: review.sourceRevision,
      revision: state.correction.revision, approved: review.approved, humanReviewed: review.humanReviewed });
    await atomicJSON(report, result);
    if (result.images.length % 10 === 0) progress("Verified " + result.images.length + "/" + source.reviews.length + " restored reviews");
  }
  result.completedAt = new Date().toISOString();
  await atomicJSON(report, result);
  return { status: "complete", datasetId: dataset, restored, resumed, report };
}

if (isMain(import.meta.url)) {
  try { console.log(JSON.stringify(await restoreReviews(options(process.argv.slice(2),
    { url: null, dataset: null, input: null, report: null }, ["url", "dataset", "input", "report"]),
    undefined, fetch, console.error), null, 2)); }
  catch (error) { console.error("restore-reviews: " + error.message); process.exitCode = 1; }
}
