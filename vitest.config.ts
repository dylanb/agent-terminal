import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { availableParallelism } from 'node:os';
import { maxWorkersForEnv } from './vitest.poolSizing';

const maxWorkers = maxWorkersForEnv({
  availableParallelism: availableParallelism(),
  isCI: Boolean(process.env.CI),
});

export default defineConfig({
  test: {
    ...(maxWorkers === undefined ? {} : { maxWorkers }),
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.ts'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
