import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const datasetScript = fileURLToPath(
  new URL("../prepare-dataset.mjs", import.meta.url),
);
const batchScript = fileURLToPath(
  new URL("../prepare-next-batch.mjs", import.meta.url),
);

test("prepares an immutable snapshot and exact next-batch pointer", async () => {
  const root = await mkdtemp(join(tmpdir(), "horizon-scribe-"));
  const media = join(root, "media");
  const snapshots = join(root, "snapshots");
  await mkdir(media);
  await sharp({
    create: { width: 2, height: 1, channels: 3, background: "#558899" },
  })
    .jpeg()
    .toFile(join(media, "photo.jpg"));
  await sharp(Buffer.from([0, 255]), {
    raw: { width: 2, height: 1, channels: 1 },
  })
    .toColourspace("b-w")
    .png()
    .toFile(join(media, "mask.png"));
  const sourcePath = join(root, "source.json");
  await writeFile(
    sourcePath,
    JSON.stringify({
      schema: "horizon-scribe-source/v1",
      sets: [
        {
          id: "set-01",
          label: "Set 1",
          images: [
            {
              name: "photo.jpg",
              width: 2,
              height: 1,
              photo: "media/photo.jpg",
              baseMask: "media/mask.png",
            },
          ],
        },
      ],
    }),
  );
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [datasetScript, "--source", sourcePath, "--output", snapshots],
      { encoding: "utf8" },
    ),
  );
  assert.match(result.datasetId, /^[a-f0-9]{64}$/);
  const manifest = JSON.parse(await readFile(result.manifest, "utf8"));
  assert.equal(manifest.schema, "horizon-scribe-r2-snapshot/v1");
  assert.equal(manifest.statistics.images, 1);
  const plan = (await readFile(result.uploadPlan, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(plan.at(-1).key, "production/horizon-scribe/v1/current.json");
  assert.equal(plan.at(-1).immutable, false);

  const selectionPath = join(root, "selection.json");
  await writeFile(
    selectionPath,
    JSON.stringify({
      schema: "horizon-scribe-next-batch-source/v1",
      images: [{ setId: "set-01", image: "photo.jpg" }],
    }),
  );
  const batch = JSON.parse(
    execFileSync(
      process.execPath,
      [
        batchScript,
        "--snapshot",
        result.manifest,
        "--selection",
        selectionPath,
        "--output",
        root,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(batch.imageCount, 1);
  const selected = JSON.parse(await readFile(batch.batch, "utf8"));
  assert.deepEqual(selected.selectedImages, [
    { setId: "set-01", image: "photo.jpg", rank: 0 },
  ]);
});
