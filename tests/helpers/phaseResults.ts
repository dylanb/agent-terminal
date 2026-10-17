import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { exampleCapturedOutput, phaseOutputRel } from '../../src/shared/phaseResult';

/** Write a §28.5.5 phase result at `abs` and, unless `captured` is null, its raw captured run beside it. */
export function writePhaseResult(abs: string, result: string, captured: string | null = exampleCapturedOutput('passed')): void {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, result);
  if (captured !== null) writeFileSync(join(dirname(abs), phaseOutputRel(basename(abs))), captured);
}
