// #180 — `bench capture`: a working folder of a real run becomes a fixture (docs/bench.md).

import type { BenchGithub } from './benchGithub';

export type BenchCaptureRefusal = 'uncommitted-changes' | 'fixture-exists' | 'ticket-unresolved' | 'artifact-escapes';

export interface BenchCaptureRequest {
  workingFolder: string;
  fixtureDir: string;
  appHome: string;
  github: BenchGithub;
}

export type BenchCaptureResult = { ok: true } | { ok: false; code: BenchCaptureRefusal };

export async function captureFixture(_request: BenchCaptureRequest): Promise<BenchCaptureResult> {
  return { ok: true };
}
