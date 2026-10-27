import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { atomicJSON, identity, isMain, options, sha256 } from "./lib.mjs";
import { validateFullReview } from "./import-label-lab-backup.mjs";

export async function verifyDataset({ url, snapshot, report, reviews = null, queue = null, concurrency = 6 },
  token = process.env.HORIZON_SCRIBE_API_TOKEN, fetcher = fetch, progress = () => {}) {
  const base = new URL(url);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/")
    throw new Error("Worker URL must be a root HTTPS URL");
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token ?? "")) throw new Error("A valid API token is required");
  concurrency = Number(concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new Error("Concurrency must be 1 through 12");
  const raw = await readFile(snapshot), manifest = JSON.parse(raw);
  if (manifest.schema !== "horizon-scribe-r2-snapshot/v1" || !/^[a-f0-9]{64}$/.test(manifest.datasetId ?? ""))
    throw new Error("Invalid snapshot");
  const dataset = manifest.datasetId;
  const expected = manifest.sets.flatMap((set) => set.images.map((image) => ({ ...image, setId: set.id })));
  const byId = new Map(expected.map((image) => [identity(image.setId, image.name), image]));
  if (!expected.length || byId.size !== expected.length) throw new Error("Empty or duplicate snapshot identities");
  const requireSame = (actual, expected, message) => {
    if (!isDeepStrictEqual(actual, expected)) throw new Error(message);
  };
  async function request(path) {
    // Construct API paths locally. Never send the token to URLs supplied by catalog data.
    const response = await fetcher(new URL(path, base), { headers: { Authorization: "Bearer " + token },
      redirect: "error", signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error("Dataset verification HTTP " + response.status);
    return response;
  }
  const query = "?dataset=" + dataset;
  const catalog = await (await request("/v1/catalog" + query)).json();
  if (catalog.schema !== "horizon-scribe-cloud-catalog/v1" || catalog.datasetId !== dataset)
    throw new Error("Active cloud dataset differs from the snapshot");
  const live = catalog.sets.flatMap((set) => set.images.map((image) => ({ ...image, setId: set.id })));
  if (live.length !== expected.length || catalog.sets.length !== manifest.sets.length)
    throw new Error("Cloud catalog counts differ from the snapshot");
  const seen = new Set();
  for (const image of live) {
    const key = identity(image.setId, image.name), original = byId.get(key);
    if (!original || seen.has(key) || image.width !== original.width || image.height !== original.height ||
        (image.localRevision ?? null) !== (original.review?.revision ?? null))
      throw new Error("Cloud image identity, dimensions, or snapshot revision differs");
    seen.add(key);
  }
  const jobs = expected.flatMap((image) => ["photo", "baseMask"].map((artifact) => ({ image, artifact })));
  let cursor = 0, verifiedAssets = 0, verifiedBytes = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < jobs.length) {
      const { image, artifact } = jobs[cursor++], descriptor = image[artifact];
      const path = "/v1/asset?set=" + encodeURIComponent(image.setId) + "&image=" + encodeURIComponent(image.name) +
        "&artifact=" + artifact + "&dataset=" + dataset;
      const bytes = Buffer.from(await (await request(path)).arrayBuffer());
      if (bytes.length !== descriptor.bytes || sha256(bytes) !== descriptor.sha256)
        throw new Error("Cloud bytes differ: " + image.setId + "/" + image.name + "/" + artifact);
      verifiedAssets++; verifiedBytes += bytes.length;
      if (verifiedAssets % 100 === 0) progress("Verified exact cloud bytes " + verifiedAssets + "/" + jobs.length);
    }
  }));
  let verifiedReviews = 0, verifiedQueueImages = null;
  if (reviews) {
    const source = JSON.parse(await readFile(reviews));
    if (source.schema !== "horizon-scribe-review-restore/v1" || !Array.isArray(source.reviews))
      throw new Error("Invalid review restore input");
    const reviewed = new Set();
    for (const review of source.reviews) {
      validateFullReview(review);
      const key = identity(review.setId, review.image), original = byId.get(key);
      if (!original || reviewed.has(key) || original.width !== review.width || original.height !== review.height ||
          (original.review?.revision ?? null) !== review.snapshotRevision) throw new Error("Invalid review identity or base revision");
      reviewed.add(key);
      const state = await (await request("/v1/sets/" + encodeURIComponent(review.setId) + "/images/" + encodeURIComponent(review.image) + query)).json();
      if (state.schema !== "horizon-scribe-cloud-review-state/v1" || state.datasetId !== dataset ||
          state.setId !== review.setId || state.image !== review.image || state.width !== review.width || state.height !== review.height ||
          state.correction.representation !== "full-class-raster/v1" || !/^[a-f0-9]{64}$/.test(state.correction.revision ?? "") ||
          state.correction.localBaseRevision !== review.snapshotRevision || state.correction.approved !== review.approved ||
          state.correction.humanReviewed !== review.humanReviewed) throw new Error("Restored review identity or flags differ");
      requireSame(state.correction.rows, review.rows, "Restored review rows differ");
      verifiedReviews++;
    }
  }
  if (queue) {
    const source = JSON.parse(await readFile(queue));
    if (source.schema !== "horizon-scribe-next-pass-selection/v1" || source.datasetId !== dataset)
      throw new Error("Queue does not belong to this snapshot");
    const current = await (await request("/v1/next-pass" + query)).json();
    if (current?.schema !== source.schema || current.datasetId !== dataset) throw new Error("Cloud queue identity differs");
    for (const field of ["runId", "modelId", "predictionSetId", "selectedImages"])
      requireSame(current[field], source[field], "Cloud queue differs: " + field);
    verifiedQueueImages = source.selectedImages.length;
  }
  const result = { schema: "horizon-scribe-dataset-verification/v1", datasetId: dataset,
    verifiedAt: new Date().toISOString(), snapshotSha256: sha256(raw), sets: manifest.sets.length,
    images: expected.length, verifiedAssets, verifiedBytes, verifiedReviews, verifiedQueueImages };
  await atomicJSON(report, result); // A report is written only after every requested check passes.
  return result;
}

if (isMain(import.meta.url)) {
  try { console.log(JSON.stringify(await verifyDataset(options(process.argv.slice(2),
    { url: null, snapshot: null, report: null, reviews: null, queue: null, concurrency: 6 }, ["url", "snapshot", "report"]),
    undefined, fetch, console.error), null, 2)); }
  catch (error) { console.error("verify-dataset: " + error.message); process.exitCode = 1; }
}
