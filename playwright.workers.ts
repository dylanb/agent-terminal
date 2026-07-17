// Decides how many Playwright workers the e2e suite runs with. GitHub CI runs serially: concurrent
// full-Electron tests on a shared runner produce crash- and load-class flakes (worker death,
// renderer-lag timeouts). A dev machine has the headroom to parallelize — half the logical cores,
// capped at 6. The gate is GITHUB_ACTIONS, not CI, because the Podman harness (docs/e2e-podman.md) —
// the canonical local e2e — also sets CI; gating on CI would drag local runs back to serial while
// GitHub sets both. This is the single home for the worker formula; tests/integration/e2eParallelism
// pins it, and playwright.config delegates to it.
export function resolveE2eWorkers(env: NodeJS.ProcessEnv, cores: number): number {
  if (env.GITHUB_ACTIONS) return 1;
  return Math.min(6, Math.max(1, Math.ceil(cores / 2)));
}
