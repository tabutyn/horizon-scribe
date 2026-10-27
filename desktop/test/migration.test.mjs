import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { importBackup } from "../import-label-lab-backup.mjs";
import { restoreReviews } from "../restore-reviews.mjs";
import { predictionsFromExport } from "../predictions-from-export.mjs";
import { sha256 } from "../lib.mjs";

const sourceDataset = "a".repeat(64), destinationDataset = "b".repeat(64), token = "t".repeat(43);
const review = { setId: "coast", image: "photo.jpg", width: 2, height: 1, sourceRevision: "c".repeat(64),
  snapshotRevision: null, approved: false, humanReviewed: false, rows: [{ y: 0, runs: [[0, 1, 1], [1, 2, 3]] }] };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "horizon-scribe-migration-"));
  const backup = join(root, "backup"), prefix = "production/label-lab/v1", entries = [];
  await mkdir(backup);
  async function put(key, bytes, contentType = "application/json") {
    const path = join(backup, "objects", key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    entries.push({ key, size: bytes.length, localSha256: sha256(bytes) });
    return { key, bytes: bytes.length, sha256: sha256(bytes), contentType };
  }
  async function blob(bytes, type) {
    const hash = sha256(bytes);
    return put(prefix + "/blobs/sha256/" + hash.slice(0, 2) + "/" + hash, bytes, type);
  }
  const photoBytes = await sharp({ create: { width: 2, height: 1, channels: 3, background: "#113355" } }).jpeg().toBuffer();
  const maskBytes = await sharp(Buffer.from([255, 0]), { raw: { width: 2, height: 1, channels: 1 } }).toColourspace("b-w").png().toBuffer();
  const photo = await blob(photoBytes, "image/jpeg"), mask = await blob(maskBytes, "image/png");
  const manifest = { schema: "brg-label-lab-r2-snapshot/v1", prefix, datasetId: sourceDataset,
    pixelLabels: { automatic: 0, land: 1, sea: 2, sky: 3 }, sets: [{ id: "coast", label: "Coast", images: [
      { name: "photo.jpg", width: 2, height: 1, photo, baseMask: mask, review: null }
    ] }] };
  const manifestDescriptor = await put(prefix + "/snapshots/" + sourceDataset + "/manifest.json", Buffer.from(JSON.stringify(manifest)));
  await put(prefix + "/current.json", Buffer.from(JSON.stringify({ schema: "brg-label-lab-r2-current/v1", datasetId: sourceDataset, manifest: manifestDescriptor })));
  await put(prefix + "/cloud-reviews/" + sourceDataset + "/coast/photo.jpg/current.json", Buffer.from(JSON.stringify({
    schema: "brg-label-lab-cloud-review-current/v1", datasetId: sourceDataset, ...review,
    cloudRevision: review.sourceRevision, representation: "full-class-raster/v1"
  })));
  await put(prefix + "/next-pass/" + sourceDataset + "/current.json", Buffer.from(JSON.stringify({
    schema: "brg-label-lab-next-pass-selection/v1", datasetId: sourceDataset,
    selectedImages: [{ setId: "coast", image: "photo.jpg", rank: 9 }]
  })));
  const inventory = Buffer.from(JSON.stringify({ schema: "ballroller-r2-local-backup/v1", objectCount: entries.length, objects: entries }));
  await writeFile(join(backup, "inventory.json"), inventory);
  await writeFile(join(backup, "inventory.sha256"), sha256(inventory) + "  inventory.json\n");
  return { root, backup, photo, photoBytes };
}

test("backup import preserves photo bytes, queue rank, and unreviewed prediction flags", async () => {
  const { root, backup, photoBytes } = await fixture(), output = join(root, "converted");
  const result = await importBackup({ backup, output });
  assert.equal(result.images, 1);
  assert.equal(result.unreviewedPredictions, 1);
  assert.equal(result.humanApproved, 0);
  const source = JSON.parse(await readFile(result.source));
  assert.deepEqual(await readFile(join(output, source.sets[0].images[0].photo)), photoBytes);
  assert.deepEqual(JSON.parse(await readFile(result.queue)).images, [{ setId: "coast", image: "photo.jpg", rank: 9 }]);
  assert.deepEqual(JSON.parse(await readFile(result.reviews)).reviews[0].rows, review.rows);
  assert.equal(JSON.parse(await readFile(result.reviews)).reviews[0].humanReviewed, false);
  await assert.rejects(importBackup({ backup, output }), /EEXIST/);
});

test("backup import rejects a corrupted media object before producing a source manifest", async () => {
  const { root, backup, photo } = await fixture();
  await writeFile(join(backup, "objects", photo.key), "corrupt");
  await assert.rejects(importBackup({ backup, output: join(root, "converted") }), /checksum mismatch/);
  await assert.rejects(readFile(join(root, "converted", "source.json")), /ENOENT/);
});

async function restoreFixture() {
  const root = await mkdtemp(join(tmpdir(), "horizon-scribe-restore-"));
  const input = join(root, "reviews.json"), report = join(root, "report.json");
  await writeFile(input, JSON.stringify({ schema: "horizon-scribe-review-restore/v1", sourceDatasetId: sourceDataset, reviews: [review] }));
  const options = { url: "https://example.workers.dev", dataset: destinationDataset, input, report };
  let writes = 0;
  const state = { schema: "horizon-scribe-cloud-review-state/v1", datasetId: destinationDataset,
    setId: "coast", image: "photo.jpg", width: 2, height: 1,
    correction: { localBaseRevision: null, revision: null, approved: false, humanReviewed: false, representation: "model-base-mask/v1", rows: [] } };
  const fetcher = async (url, config) => {
    assert.equal(config.headers.Authorization, "Bearer " + token);
    if (url.pathname === "/v1/catalog") return Response.json({ schema: "horizon-scribe-cloud-catalog/v1", datasetId: destinationDataset,
      sets: [{ id: "coast", images: [{ name: "photo.jpg", width: 2, height: 1, localRevision: null }] }] });
    assert.equal(url.searchParams.get("dataset"), destinationDataset);
    if (config.method === "PUT") {
      writes++;
      const body = JSON.parse(config.body);
      assert.equal(body.cloudBaseRevision, null);
      assert.equal(body.humanReviewed, false);
      state.correction = { ...body, revision: "d".repeat(64) };
    }
    return Response.json(state);
  };
  return { options, fetcher, state, writes: () => writes };
}

test("restore uses conditional API saves, preserves predictions, and resumes exact matches", async () => {
  const f = await restoreFixture();
  const first = await restoreReviews(f.options, token, f.fetcher);
  assert.equal(first.restored, 1);
  assert.equal(f.writes(), 1);
  const second = await restoreReviews(f.options, token, f.fetcher);
  assert.equal(second.resumed, 1);
  assert.equal(f.writes(), 1);
  const report = JSON.parse(await readFile(f.options.report));
  assert.equal(report.images[0].sourceRevision, review.sourceRevision);
  assert.equal(report.images[0].revision, "d".repeat(64));
  assert.equal(report.images[0].humanReviewed, false);
});

test("restore refuses different existing edits and the wrong destination dataset", async () => {
  const f = await restoreFixture();
  f.state.correction.revision = "e".repeat(64);
  await assert.rejects(restoreReviews(f.options, token, f.fetcher), /different cloud edits/);
  assert.equal(f.writes(), 0);
  await assert.rejects(restoreReviews({ ...f.options, dataset: "f".repeat(64) }, token, f.fetcher), /Destination dataset/);
  assert.equal(f.writes(), 0);
});

test("prediction recovery copies only pixel-exact unreviewed model results", async () => {
  const root = await mkdtemp(join(tmpdir(), "horizon-scribe-predictions-"));
  const input = join(root, "export"), output = join(root, "predictions");
  await mkdir(input);
  const labels = Buffer.from([1, 2]);
  await sharp(labels, { raw: { width: 2, height: 1, channels: 1 } })
    .toColourspace("b-w").png().toFile(join(input, "labels.png"));
  const correction = { revision: "c".repeat(64), approved: false, humanReviewed: false,
    representation: "full-class-raster/v1", rows: [{ y: 0, runs: [[0, 1, 1], [1, 2, 2]] }] };
  await writeFile(join(input, "state.json"), JSON.stringify({
    schema: "horizon-scribe-cloud-review-state/v1", datasetId: destinationDataset,
    setId: "coast", image: "photo.jpg", width: 2, height: 1, correction,
  }));
  await writeFile(join(input, "manifest.json"), JSON.stringify({
    schema: "horizon-scribe-review-export/v1", datasetId: destinationDataset,
    exportedAt: "2026-10-24T00:00:00Z", images: [{ setId: "coast", image: "photo.jpg",
      revision: correction.revision, state: "state.json", classMask: "labels.png" }],
  }));
  const result = await predictionsFromExport({ input, output });
  assert.equal(result.images, 1);
  const source = JSON.parse(await readFile(result.source));
  assert.equal(source.provenance.kind, "recovered-unreviewed-cloud-predictions");
  assert.deepEqual(await readFile(join(output, source.images[0].classMask)),
    await readFile(join(input, "labels.png")));
  await assert.rejects(predictionsFromExport({ input, output }), /EEXIST/);
});
