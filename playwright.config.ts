import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env') });

// Routine UI tests run against the client development server started locally by
// Playwright, never against a deployed site. The default target is loopback; a
// deployment can only be reached by the opt-in @production-auth test, which
// selects its own target explicitly and does not use this baseURL.
const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_PORT = '3000';

// External origins routine tests must never load. If the local server is
// unavailable or the environment is misconfigured, the run must fail here rather
// than silently fall back to a production deployment.
const FORBIDDEN_HOSTS = new Set([
  'ricoz-contract-clm-platform.vercel.app',
  'ricozcontract-clm-platform-2.onrender.com'
]);

// The only hosts routine tests may target.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Validate the selected routine-test URL at config load, before any browser is
// launched. Rejects the production hostname and any non-loopback origin.
const resolveBaseUrl = (raw: string | undefined): URL => {
  const candidate = (raw ?? '').trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`PLAYWRIGHT_BASE_URL is not a valid URL: "${candidate}"`);
  }
  const host = url.hostname.toLowerCase();
  if (FORBIDDEN_HOSTS.has(host)) {
    throw new Error(
      `PLAYWRIGHT_BASE_URL must not target the production host "${host}". ` +
        'Routine Playwright tests run against the local development server.'
    );
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `PLAYWRIGHT_BASE_URL must target a loopback host (127.0.0.1/localhost), got "${host}". ` +
        `Use ${DEFAULT_BASE_URL}.`
    );
  }
  if (url.protocol !== 'http:') {
    throw new Error(
      `PLAYWRIGHT_BASE_URL must use http for the local development server, got "${url.protocol}//".`
    );
  }
  return url;
};

const baseUrl = resolveBaseUrl(process.env.PLAYWRIGHT_BASE_URL);
const devServerHost = baseUrl.hostname;
const devServerPort = baseUrl.port || DEFAULT_PORT;
// Keep 127.0.0.1 and the port explicit so relative navigations (e.g. "/login")
// can only ever resolve to the local server.
const baseURL = `${baseUrl.protocol}//${devServerHost}:${devServerPort}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  // Playwright starts and stops the client development server. The backend is
  // intentionally NOT started: these UI tests do not need it, and starting it
  // could put a real database in reach. An already-running local server is
  // reused only outside CI; in CI Playwright owns the whole lifecycle.
  webServer: {
    command: 'npm --prefix client run start',
    url: `${baseURL}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180000,
    env: {
      // Never open a browser and never prompt interactively.
      BROWSER: 'none',
      CI: '1',
      HOST: devServerHost,
      PORT: devServerPort,
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
});
