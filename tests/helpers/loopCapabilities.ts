// Deterministic fixture for a repo's loop-capabilities.yaml (§28.5.4). Writes ONE minimal valid capabilities
// file so the S3 working-tree check and the RED e2e source their test_globs from real repo data, never a
// hand-inlined yaml per test. Keeps the on-disk shape in one place, mirroring the production single-source
// (loopCapabilities.ts parses exactly these keys). The test_command / build_command are inert strings here —
// the engine never runs them (§28.5.4); only their presence + shape is validated.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { LOOP_CAPABILITIES_FILENAME } from '../../src/shared/loopCapabilities';

export interface LoopCapabilitiesFixture {
  testGlobs?: string[];
  testCommand?: string;
  buildCommand?: string;
  selectTemplate?: string;
}

/** Write `<repoDir>/loop-capabilities.yaml` with the given (or default) fields. Returns the file path. */
export function writeLoopCapabilities(repoDir: string, fixture: LoopCapabilitiesFixture = {}): string {
  const doc: Record<string, unknown> = {
    test_globs: fixture.testGlobs ?? ['tests/**'],
    test_command: fixture.testCommand ?? 'pnpm test',
    build_command: fixture.buildCommand ?? 'pnpm run build',
  };
  if (fixture.selectTemplate !== undefined) doc.select_template = fixture.selectTemplate;
  const file = join(repoDir, LOOP_CAPABILITIES_FILENAME);
  writeFileSync(file, yaml.dump(doc));
  return file;
}
