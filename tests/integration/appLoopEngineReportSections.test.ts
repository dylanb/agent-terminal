import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppLoopEngineHarness, STEP } from '../helpers/appLoopEngineHarness';
import type { ArtifactBinding, LoopDefV2 } from '../../src/main/loopDefV2';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR } from '../../src/main/appLoopPaths';

const h = new AppLoopEngineHarness();
beforeEach(h.setUp);
afterEach(h.tearDown);

const ART_REL = [...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR].join('/');
const artDir = (): string => join(realpathSync(h.repo), ...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR);
const report = (): ArtifactBinding => ({
  id: 'impl-report',
  path: join(artDir(), 'impl-report.md'),
  rel: `${ART_REL}/impl-report.md`,
  leafPath: join(artDir(), 'impl-report.md'),
  sectionsDir: { path: join(artDir(), 'impl-report'), rel: `${ART_REL}/impl-report` },
});
const sectionedDef = (): LoopDefV2 => ({ ...h.commitDef(), rounds: { kind: 'none' }, inputs: [report()], outputs: [report()] });
const writeSection = (name: string, body: string): void => {
  mkdirSync(join(artDir(), 'impl-report'), { recursive: true });
  writeFileSync(join(artDir(), 'impl-report', name), body);
};
const assembled = (): string => readFileSync(join(artDir(), 'impl-report.md'), 'utf8');

describe('a step writes its own section; the engine assembles the report (§27.10)', () => {
  it("names this step's section file for the current slice in the work prompt", () => {
    const engine = h.makeEngine();
    h.currentSliceResult = 2;
    h.defResult = h.resolved(sectionedDef());
    h.enterAndInjectWork(engine);
    expect(h.injected.join('\n')).toContain(`${ART_REL}/impl-report/${STEP}.slice-2.md`);
  });

  it('hands the next step the report assembled from the section files earlier steps wrote', () => {
    writeSection('infra.md', '## infra\ninfra work\n');
    const engine = h.makeEngine();
    h.defResult = h.resolved(sectionedDef());
    h.enterAndInjectWork(engine);
    expect(assembled()).toContain('## infra\ninfra work');
    expect(h.injected.join('\n')).toContain(`- impl-report: ${ART_REL}/impl-report.md`);
  });

  it('rebuilds the report from the section this step wrote when its turn completes', () => {
    const engine = h.makeEngine();
    h.defResult = h.resolved(sectionedDef());
    h.enterAndInjectWork(engine);
    writeSection(`${STEP}.md`, `## ${STEP}\nthis step's work\n`);
    engine.onDoneSignal();
    expect(assembled()).toContain(`## ${STEP}\nthis step's work`);
  });

  it('surfaces a report it cannot assemble, and still runs the step', () => {
    const outside = join(h.repo, 'elsewhere.md');
    writeFileSync(outside, 'secret\n');
    mkdirSync(join(artDir(), 'impl-report'), { recursive: true });
    symlinkSync(outside, join(artDir(), 'impl-report', 'infra.md'));
    const engine = h.makeEngine();
    h.defResult = h.resolved(sectionedDef());
    h.enterAndInjectWork(engine);
    expect(h.emitError.mock.calls.map((c) => c[0]).join('\n')).toMatch(/impl-report.*infra\.md/);
    expect(existsSync(join(artDir(), 'impl-report.md'))).toBe(false);
    expect(h.injected.join('\n')).toContain('Produce the plan.');
  });
});
