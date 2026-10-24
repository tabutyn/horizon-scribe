import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./browser",
  outputDir: "../test-results",
  timeout: 60000,
  workers: 1,
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 1100 },
    screenshot: "only-on-failure",
  },
});
