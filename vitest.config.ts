import { defineConfig } from 'vitest/config';
import { availableParallelism } from 'node:os';
import { maxWorkersForEnv } from './vitest.poolSizing';

const maxWorkers = maxWorkersForEnv({
  availableParallelism: availableParallelism(),
  isCI: Boolean(process.env.CI),
});

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    ...(maxWorkers === undefined ? {} : { maxWorkers }),
  },
});
