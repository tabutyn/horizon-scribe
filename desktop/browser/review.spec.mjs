import { test, expect } from "@playwright/test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDemo } from "../../scripts/create-demo.mjs";
import { buildReview } from "../build-review.mjs";
import { startReviewServer } from "../review-server.mjs";

let server, base, root;
test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "horizon-scribe-browser-"));
  const demo = await createDemo(join(root, "demo"));
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
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});
test("comparison, exact selection, reorder, persistence, download, and filtering", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await expect(
    page.getByRole("heading", { name: "Choose the next round." }),
  ).toBeVisible();
  await expect(page.locator(".card")).toHaveCount(6);
  await expect(page.locator(".card img").first()).toHaveJSProperty(
    "naturalWidth",
    480,
  );
  await page.getByLabel("Show overlay").uncheck();
  await expect(page.locator(".card img").first()).toHaveAttribute(
    "src",
    /photo\.jpg$/,
  );
  await page.getByLabel("Show overlay").check();
  await page.locator(".card").nth(0).click();
  await page.locator(".card").nth(1).click();
  await expect(page.locator("#count")).toHaveText("2");
  await expect(page.locator("#status")).toHaveText(
    "Saved locally as next-batch.json",
  );
  await page
    .locator("#queue li")
    .nth(1)
    .getByRole("button", { name: /Move up/ })
    .click();
  await expect(page.locator("#status")).toHaveText(
    "Saved locally as next-batch.json",
  );
  const saved = JSON.parse(
    await readFile(join(root, "review", "next-batch.json"), "utf8"),
  );
  expect(saved.images.map((row) => row.image)).toEqual([
    "synthetic-4.png",
    "synthetic-2.png",
  ]);
  await page.reload();
  await expect(page.locator("#count")).toHaveText("2");
  await page.getByLabel("Selected only").check();
  await expect(page.locator(".card")).toHaveCount(2);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download selection JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("next-batch.json");
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(exported.images).toEqual(saved.images);
  await page.getByLabel("Selected only").uncheck();
  await page.screenshot({
    path: "test-results/horizon-scribe-desktop.png",
    fullPage: true,
  });
  await page.getByLabel("Find image").fill("synthetic-6");
  await expect(page.locator(".card")).toHaveCount(1);
  expect(errors).toEqual([]);
});
