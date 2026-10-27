import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyDataset } from "../verify-dataset.mjs";
import { sha256 } from "../lib.mjs";

const dataset = "a".repeat(64), token = "t".repeat(43);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "horizon-scribe-verify-"));
  const photo = Buffer.from("photo bytes"), mask = Buffer.from("mask bytes");
  const descriptor = (bytes) => ({ bytes: bytes.length, sha256: sha256(bytes) });
  const snapshot = join(root, "snapshot.json"), report = join(root, "report.json");
  await writeFile(snapshot, JSON.stringify({ schema: "horizon-scribe-r2-snapshot/v1", datasetId: dataset,
    sets: [{ id: "coast", images: [{ name: "one.jpg", width: 2, height: 1, photo: descriptor(photo), baseMask: descriptor(mask) }] }] }));
  const catalog = { schema: "horizon-scribe-cloud-catalog/v1", datasetId: dataset,
    sets: [{ id: "coast", images: [{ name: "one.jpg", width: 2, height: 1, localRevision: null,
      imageUrl: "https://untrusted.example/not-used" }] }] };
  const fetcher = async (url, config) => {
    assert.equal(url.origin, "https://example.workers.dev");
    assert.equal(url.searchParams.get("dataset"), dataset);
    assert.equal(config.headers.Authorization, "Bearer " + token);
    assert.equal(config.redirect, "error");
    return url.pathname === "/v1/catalog" ? Response.json(catalog) :
      new Response(url.searchParams.get("artifact") === "photo" ? photo : mask);
  };
  return { options: { url: "https://example.workers.dev", snapshot, report }, fetcher, catalog };
}

test("dataset verifier hashes every photo and mask without trusting catalog URLs", async () => {
  const f = await fixture();
  const result = await verifyDataset(f.options, token, f.fetcher);
  assert.equal(result.verifiedAssets, 2);
  assert.equal(result.images, 1);
  assert.equal(JSON.parse(await readFile(f.options.report)).datasetId, dataset);
});

test("dataset verifier rejects corrupt cloud bytes without writing a success report", async () => {
  const f = await fixture();
  const fetcher = (url, config) => url.pathname === "/v1/asset" ? new Response("corrupt") : f.fetcher(url, config);
  await assert.rejects(verifyDataset(f.options, token, fetcher), /Cloud bytes differ/);
  await assert.rejects(readFile(f.options.report), /ENOENT/);
});

test("dataset verifier rejects wrong active dataset and invalid concurrency", async () => {
  const f = await fixture();
  f.catalog.datasetId = "b".repeat(64);
  await assert.rejects(verifyDataset(f.options, token, f.fetcher), /Active cloud dataset/);
  await assert.rejects(verifyDataset({ ...f.options, concurrency: 13 }, token, f.fetcher), /Concurrency/);
});

test("dataset verifier checks restored prediction flags, rows, and exact queue ranks", async () => {
  const f = await fixture(), reviews = f.options.snapshot + ".reviews", queue = f.options.snapshot + ".queue";
  const review = { setId: "coast", image: "one.jpg", width: 2, height: 1, approved: false,
    humanReviewed: false, snapshotRevision: null, rows: [{ y: 0, runs: [[0, 1, 1], [1, 2, 3]] }] };
  await writeFile(reviews, JSON.stringify({ schema: "horizon-scribe-review-restore/v1", reviews: [review] }));
  const selection = { schema: "horizon-scribe-next-pass-selection/v1", datasetId: dataset,
    runId: null, modelId: null, predictionSetId: null, selectedImages: [{ setId: "coast", image: "one.jpg", rank: 9 }] };
  await writeFile(queue, JSON.stringify(selection));
  const state = { schema: "horizon-scribe-cloud-review-state/v1", datasetId: dataset,
    setId: review.setId, image: review.image, width: 2, height: 1,
    correction: { representation: "full-class-raster/v1", revision: "c".repeat(64), localBaseRevision: null,
      approved: false, humanReviewed: false, rows: review.rows } };
  const fetcher = (url, config) => url.pathname === "/v1/next-pass" ? Response.json(selection) :
    url.pathname.startsWith("/v1/sets/") ? Response.json(state) : f.fetcher(url, config);
  const result = await verifyDataset({ ...f.options, reviews, queue }, token, fetcher);
  assert.equal(result.verifiedReviews, 1);
  assert.equal(result.verifiedQueueImages, 1);
  state.correction.humanReviewed = true;
  await assert.rejects(verifyDataset({ ...f.options, reviews, queue }, token, fetcher), /flags differ/);
  state.correction.humanReviewed = false;
  selection.selectedImages[0].rank = 0;
  await assert.rejects(verifyDataset({ ...f.options, reviews, queue }, token, fetcher), /Cloud queue differs/);
});
