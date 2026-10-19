import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  retries: 0,
  workers: 1,
});
