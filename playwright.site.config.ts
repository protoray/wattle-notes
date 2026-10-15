import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/website',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:1430', headless: true },
  webServer: {
    command: 'python3 -m http.server 1430 --bind 127.0.0.1 --directory website/dist',
    url: 'http://127.0.0.1:1430',
    reuseExistingServer: !process.env.CI,
  },
});
