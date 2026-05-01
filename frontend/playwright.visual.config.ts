import { defineConfig, devices } from "@playwright/test";

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
} as const;

export default defineConfig({
  testDir: "./tests/visual",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 60_000,

  use: {
    baseURL: process.env.VISUAL_BASE_URL ?? "http://localhost:2026",
    storageState: "./tests/visual/storageState.json",
    trace: "off",
    video: "off",
    screenshot: "off",
  },

  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.desktop },
    },
  ],
});
