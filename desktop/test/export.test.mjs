import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportReviews } from "../export-reviews.mjs";
import { maskPixels, readJSON } from "../lib.mjs";

test("exports concrete label bytes and identity manifest without downloading photos", async (t) => {
  const dataset = "a".repeat(64),
    revision = "b".repeat(64),
    calls = [];
  const catalog = {
    schema: "horizon-scribe-cloud-catalog/v1",
    datasetId: dataset,
    sets: [
      {
        id: "set",
        images: [
          { name: "photo.jpg", width: 3, height: 1, cloudRevision: revision },
        ],
      },
    ],
  };
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (url, options) => {
    calls.push(new URL(url));
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${"x".repeat(43)}`);
    const path = new URL(url).pathname;
    return Response.json(
      path === "/v1/catalog"
        ? catalog
        : path === "/v1/training-manifest"
          ? {
              schema: "horizon-scribe-training-manifest/v1",
              datasetId: dataset,
            }
          : {
              schema: "horizon-scribe-cloud-review-state/v1",
              datasetId: dataset,
              setId: "set",
              image: "photo.jpg",
              width: 3,
              height: 1,
              correction: {
                revision,
                approved: true,
                representation: "full-class-raster/v1",
                rows: [
                  {
                    y: 0,
                    runs: [
                      [0, 1, 1],
                      [1, 2, 2],
                      [2, 3, 3],
                    ],
                  },
                ],
              },
            },
    );
  };
  const root = await mkdtemp(join(tmpdir(), "horizon-scribe-export-")),
    output = join(root, "export");
  const result = await exportReviews(
    { url: "https://worker.example", output },
    "x".repeat(43),
  );
  assert.equal(result.images, 1);
  assert.deepEqual(
    [...(await maskPixels(join(output, "000000.labels.png"), 3, 1, true))],
    [1, 2, 3],
  );
  assert.equal(
    (await readJSON(join(output, "manifest.json"))).images[0].image,
    "photo.jpg",
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[2].searchParams.get("dataset"), dataset);
});

test("export rejects invalid URL/token before network access", async () => {
  await assert.rejects(
    exportReviews(
      { url: "http://worker.example", output: "unused" },
      "x".repeat(43),
    ),
    /HTTPS/,
  );
  await assert.rejects(
    exportReviews({ url: "https://worker.example", output: "unused" }, "short"),
    /TOKEN/,
  );
});
