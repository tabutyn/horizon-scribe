import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { createDemo } from "../../scripts/create-demo.mjs";
import { buildReview } from "../build-review.mjs";
import { startReviewServer, validateSelection } from "../review-server.mjs";
import { readJSON, maskPixels } from "../lib.mjs";
import { importPhotos } from "../import-photos.mjs";
import { stageSelectedPredictions } from "../stage-selected-predictions.mjs";

const prepare = fileURLToPath(
  new URL("../prepare-dataset.mjs", import.meta.url),
);
const next = fileURLToPath(
  new URL("../prepare-next-batch.mjs", import.meta.url),
);
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "horizon-scribe-review-"));
  const demo = await createDemo(join(root, "demo"));
  const snapshot = JSON.parse(
    execFileSync(
      process.execPath,
      [prepare, "--source", demo.source, "--output", join(root, "snapshots")],
      { encoding: "utf8" },
    ),
  );
  return { root, demo, snapshot };
}
test("synthetic photos → snapshot → comparison previews → selection → iPad queue", async (t) => {
  const { root, demo, snapshot } = await fixture(),
    bundle = join(root, "review");
  await buildReview({
    snapshot: snapshot.manifest,
    plan: snapshot.uploadPlan,
    output: bundle,
    predictions: demo.predictions,
  });
  const server = await startReviewServer({ bundle, port: 0 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  let response = await fetch(`${base}/api/catalog`),
    catalog = await response.json();
  assert.equal(catalog.images.length, 6);
  assert.equal(catalog.sheets.length, 1);
  assert.equal(catalog.sheets[0].imageIndexes.length, 6);
  assert.equal(catalog.images[1].mode, "prediction");
  const body = {
    schema: "horizon-scribe-next-batch-source/v1",
    datasetId: catalog.datasetId,
    selectionRevision: 0,
    images: [catalog.images[1]],
  };
  response = await fetch(`${base}/api/selection`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).selectionRevision, 1);
  response = await fetch(`${base}/api/selection`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 409);
  const saved = await readJSON(join(bundle, "next-batch.json"));
  assert.deepEqual(
    saved.images.map((row) => row.rank),
    [0],
  );
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        next,
        "--snapshot",
        snapshot.manifest,
        "--selection",
        join(bundle, "next-batch.json"),
        "--output",
        join(root, "publish"),
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(result.imageCount, 1);
  assert.equal(
    (await readJSON(result.batch)).selectedImages[0].image,
    catalog.images[1].image,
  );
  response = await fetch(`${base}/media/sheet-0.overlay.jpg`);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.ok((await response.arrayBuffer()).byteLength > 100);
  response = await fetch(`${base}/`, {
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(response.status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    http
      .get(`${base}/`, { headers: { Host: "attacker.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on("error", reject);
  });
  assert.equal(badHostStatus, 403);
  response = await fetch(`${base}/media/%2e%2e/manifest.json`);
  assert.equal(response.status, 404);
  await new Promise((resolve) => server.close(resolve));
  const reopened = await startReviewServer({ bundle, port: 0 });
  t.after(() => reopened.close());
  const restored = await (
    await fetch(`http://127.0.0.1:${reopened.address().port}/api/catalog`)
  ).json();
  assert.equal(restored.selection.images.length, 1);
});
test("rejects unknown, duplicate, same-sheet, oversized, or wrong-dataset selections", () => {
  const manifest = {
    datasetId: "a".repeat(64),
    images: [
      { setId: "s", image: "i" },
      { setId: "s", image: "j" },
    ],
    sheets: [
      { index: 0, columns: 4, rows: 4, imageIndexes: [0, 1] },
    ],
  };
  const good = {
    schema: "horizon-scribe-next-batch-source/v1",
    datasetId: manifest.datasetId,
    images: [manifest.images[0]],
  };
  assert.equal(validateSelection(good, manifest).images.length, 1);
  for (const value of [
    { ...good, datasetId: "b".repeat(64) },
    { ...good, images: [{ setId: "s", image: "unknown" }] },
    { ...good, images: [...good.images, ...good.images] },
    { ...good, images: manifest.images },
    { ...good, images: Array(501).fill(good.images[0]) },
  ])
    assert.throws(() => validateSelection(value, manifest));
});
test("rejects mismatched prediction masks and changed source photos", async () => {
  const { root, demo, snapshot } = await fixture();
  const predictions = await readJSON(demo.predictions);
  predictions.datasetId = "f".repeat(64);
  await writeFile(demo.predictions, JSON.stringify(predictions));
  await assert.rejects(
    buildReview({
      snapshot: snapshot.manifest,
      plan: snapshot.uploadPlan,
      output: join(root, "bad-review"),
      predictions: demo.predictions,
    }),
    /different dataset/,
  );
  const plan = (await readFile(snapshot.uploadPlan, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse),
    photo = plan.find((row) =>
      row.roles.some((role) => role.startsWith("photo:")),
    );
  await writeFile(photo.localPath, "changed");
  await assert.rejects(
    buildReview({
      snapshot: snapshot.manifest,
      plan: snapshot.uploadPlan,
      output: join(root, "changed-review"),
    }),
    /changed/,
  );
});
test("prediction-only review excludes images without a prediction", async () => {
  const { root, demo, snapshot } = await fixture();
  const predictions = await readJSON(demo.predictions);
  predictions.images.pop();
  await writeFile(demo.predictions, JSON.stringify(predictions));
  const output = join(root, "prediction-only");
  const result = await buildReview({ snapshot: snapshot.manifest, plan: snapshot.uploadPlan,
    output, predictions: demo.predictions, candidates: "predictions" });
  assert.equal(result.images, 5);
  const manifest = await readJSON(join(output, "manifest.json"));
  assert.equal(manifest.candidateMode, "predictions");
  assert.deepEqual(manifest.predictionCoverage, { predicted: 5, total: 6 });
  assert.equal(manifest.sheets.length, 1);
  assert.ok(manifest.images.every((image) => image.mode === "prediction"));
  await assert.rejects(buildReview({ snapshot: snapshot.manifest, plan: snapshot.uploadPlan,
    output: join(root, "missing"), candidates: "predictions" }), /requires a prediction/);
});
test("stages selected predictions as unreviewed full rasters", async () => {
  const { root, demo, snapshot } = await fixture(),
    manifest = await readJSON(snapshot.manifest),
    predictions = await readJSON(demo.predictions),
    firstSet = manifest.sets[0],
    firstImage = firstSet.images[0],
    selection = join(root, "selection.json"),
    report = join(root, "staging-report.json");
  predictions.datasetId = manifest.datasetId;
  await writeFile(demo.predictions, JSON.stringify(predictions));
  await writeFile(
    selection,
    JSON.stringify({
      schema: "horizon-scribe-next-batch-source/v1",
      datasetId: manifest.datasetId,
      images: [{ setId: firstSet.id, image: firstImage.name, rank: 0 }],
    }),
  );
  let writes = 0,
    state = {
      schema: "horizon-scribe-cloud-review-state/v1",
      datasetId: manifest.datasetId,
      setId: firstSet.id,
      image: firstImage.name,
      width: firstImage.width,
      height: firstImage.height,
      correction: {
        revision: null,
        localBaseRevision: firstImage.review?.revision ?? null,
        approved: false,
        humanReviewed: false,
        representation: "model-base-mask/v1",
        rows: [],
      },
    };
  const fetcher = async (url, options = {}) => {
    if (new URL(url).pathname === "/v1/catalog")
      return Response.json({
        schema: "horizon-scribe-cloud-catalog/v1",
        datasetId: manifest.datasetId,
      });
    if (options.method === "PUT") {
      writes++;
      const body = JSON.parse(options.body);
      assert.equal(body.humanReviewed, false);
      assert.equal(body.approved, false);
      assert.equal(body.rows.length, firstImage.height);
      assert.ok(
        body.rows.every(
          (row) =>
            row.runs[0][0] === 0 &&
            row.runs.at(-1)[1] === firstImage.width &&
            row.runs.every((run) => run[2] >= 1 && run[2] <= 3),
        ),
      );
      state = {
        ...state,
        correction: {
          ...state.correction,
          revision: "c".repeat(64),
          representation: body.representation,
          rows: body.rows,
        },
      };
    }
    return Response.json(state);
  };
  const result = await stageSelectedPredictions(
    {
      url: "https://worker.example/",
      snapshot: snapshot.manifest,
      plan: snapshot.uploadPlan,
      selection,
      predictions: demo.predictions,
      report,
    },
    "t".repeat(32),
    fetcher,
  );
  assert.equal(result.staged, 1);
  assert.equal(writes, 1);
  assert.equal((await readJSON(report)).images[0].revision, "c".repeat(64));
});
test("imports own photos without changing originals and supplies blank base masks", async () => {
  const { root, demo } = await fixture(),
    source = await readJSON(demo.source);
  const input = join(root, "photos");
  await mkdir(input);
  const original = await readFile(
    join(root, "demo", source.sets[0].images[0].photo),
  );
  await writeFile(join(input, "own.png"), original);
  const result = await importPhotos({
      input,
      output: join(root, "imported"),
      set: "own",
    }),
    imported = await readJSON(result.source),
    image = imported.sets[0].images[0];
  assert.equal(result.images, 1);
  assert.deepEqual(await readFile(join(input, "own.png")), original);
  const pixels = await maskPixels(
    join(root, "imported", image.baseMask),
    image.width,
    image.height,
  );
  assert.ok(pixels.every((value) => value === 255));
  await assert.rejects(
    importPhotos({ input, output: join(root, "imported"), set: "own" }),
    /EEXIST/,
  );
});
