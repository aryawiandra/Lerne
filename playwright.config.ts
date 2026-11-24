import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgresql://localhost:5432/lerne_e2e";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    // Rebuild the throwaway e2e database (schema + SYNTHETIC seed) before the server starts.
    command: `npx tsx scripts/dbSetup.ts && npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      LERNE_AUTH_MODE: "dev",
      DATABASE_URL: E2E_DATABASE_URL,
      // Test-only value for signing dev-bypass cookies in the throwaway e2e run; not a real secret.
      LERNE_SESSION_SECRET: "e2e-only-dev-cookie-signing-value-0123456789",
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
    },
  },
});
