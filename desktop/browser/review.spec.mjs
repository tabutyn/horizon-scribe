import { test, expect } from "@playwright/test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDemo } from "../../scripts/create-demo.mjs";
import { buildReview } from "../build-review.mjs";
import { startReviewServer } from "../review-server.mjs";

let server, base, root, catalog;
test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "horizon-scribe-browser-"));
  const demo = await createDemo(join(root, "demo"), 17);
  const snapshot = JSON.parse(
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL("../prepare-dataset.mjs", import.meta.url)),
        "--source",
        demo.source,
        "--output",
        join(root, "snapshots"),
      ],
      { encoding: "utf8" },
    ),
  );
  await buildReview({
    snapshot: snapshot.manifest,
    plan: snapshot.uploadPlan,
    predictions: demo.predictions,
    output: join(root, "review"),
  });
  server = await startReviewServer({ bundle: join(root, "review"), port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
  catalog = await (await fetch(`${base}/api/catalog`)).json();
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});
test("full-width sheets, one-per-sheet selection, reorder, persistence, and download", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await expect(page.locator(".sheet-image")).toHaveCount(1);
  await expect(page.locator(".tile-button")).toHaveCount(16);
  await expect(page.locator("#page")).toHaveText("Sheet 1 / 2");
  await expect(page.locator("aside")).toHaveCount(0);
  const sheetBox = await page.locator(".sheet-frame").boundingBox();
  expect(sheetBox.width).toBeGreaterThan(1000);
  await expect(page.locator(".sheet-image")).toHaveJSProperty(
    "naturalWidth",
    1920,
  );
  await page.getByTitle("Toggle inferred-label overlay").click();
  await expect(page.locator(".sheet-image")).toHaveAttribute(
    "src",
    /photo\.jpg$/,
  );
  await page.getByTitle("Toggle inferred-label overlay").click();
  const first = catalog.images[catalog.sheets[0].imageIndexes[0]].image;
  const second = catalog.images[catalog.sheets[0].imageIndexes[1]].image;
  const third = catalog.images[catalog.sheets[1].imageIndexes[0]].image;
  await page.locator(".tile-button").nth(0).click();
  await page.locator(".tile-button").nth(1).click();
  await expect(page.locator("#count")).toHaveText("1");
  await expect(page.locator(".tile-button").nth(0)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.locator(".tile-button").nth(1)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.locator(".tile-button")).toHaveCount(1);
  await page.locator(".tile-button").click();
  await expect(page.locator("#count")).toHaveText("2");
  await page.getByRole("button", { name: "2 selected" }).click();
  await expect(page.locator("#selection-dialog")).toBeVisible();
  await page
    .locator("#queue li")
    .nth(1)
    .getByRole("button", { name: /Move up/ })
    .click();
  let saved;
  await expect.poll(async () => {
    saved = JSON.parse(
      await readFile(join(root, "review", "next-batch.json"), "utf8"),
    );
    return saved.images.map((row) => row.image);
  }).toEqual([third, second]);
  expect(saved.images.map((row) => row.image)).toEqual([third, second]);
  await page.reload();
  await expect(page.locator("#count")).toHaveText("2");
  await page.getByRole("button", { name: "2 selected" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download selection JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("next-batch.json");
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(exported.images).toEqual(saved.images);
  await page.getByRole("button", { name: "Close selection" }).click();
  await expect(page.locator("#selection-dialog")).toBeHidden();
  await page.screenshot({
    path: "test-results/horizon-scribe-desktop.png",
    fullPage: true,
  });
  expect(first).not.toBe(second);
  expect(errors).toEqual([]);
});
