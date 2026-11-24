import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['sample.case.ts'],
    browser: {
      enabled: true,
      provider: playwright({ launchOptions: { executablePath: process.env.TEST_CHROMIUM_EXECUTABLE } }),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
