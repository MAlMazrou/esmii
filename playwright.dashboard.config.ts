import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e-dashboard",
  outputDir: "./test-results/dashboard-e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 45_000,
  workers: 1,
  use: {
    ...devices["Desktop Chrome"],
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { height: 900, width: 1440 },
  },
  webServer: [
    {
      command:
        "node --experimental-strip-types apps/dashboard/tests/e2e/dashboard-server.ts staging 3111",
      reuseExistingServer: false,
      timeout: 120_000,
      url: "http://127.0.0.1:3111/healthz",
    },
    {
      command:
        "node --experimental-strip-types apps/dashboard/tests/e2e/dashboard-server.ts production 3112",
      reuseExistingServer: false,
      timeout: 120_000,
      url: "http://127.0.0.1:3112/healthz",
    },
  ],
});
