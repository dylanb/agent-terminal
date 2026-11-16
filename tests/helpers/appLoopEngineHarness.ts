import { vi, type Mock } from 'vitest';
import { writePhaseResult } from './phaseResults';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { LifecycleTerminateResult } from '../../src/main/flowLifecycle';
import type { FlowStateView } from '../../src/shared/ipc';
import { createAppLoopEngine, type AppLoopEngineDeps, type AppLoopEntry, type WorkRefs } from '../../src/main/appLoopEngine';
import type { LoopCompletionPredicates } from '../../src/main/loopCompletionPredicates';
import {
  clearBaselineCommit,
  clearPolish,
  consolidatorOutputFile,
  consolidatorOutputRel,
  readBaselineCommit,
  recordChangedTests,
  refactorResultFile,
  refactorResultRel,
  roundReportFile,
  roundReportRel,
  writeAppLoopState,
  type AppLoopRunState,
} from '../../src/main/appLoopState';
import { completionMarker } from '../../src/main/appWorkTurn';
import { probeChainedInput } from '../../src/main/chainedInputProbe';
import { clearDecisionFile } from '../../src/main/stepDecision';
import { assembleReportOnDisk } from '../../src/main/reportSections';
import type { ArtifactBinding, LoopDefV2, LoopDefV2Result } from '../../src/main/loopDefV2';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR } from '../../src/main/appLoopPaths';
import type { HostedAgentState } from '../../src/main/loopOrchestrator';
import { exampleRoundReport } from '../../src/shared/roundReport';
import { roundReportWithStatuses } from './roundReports';
import { verdictOutput } from './consolidatorOutputs';

export const STEP = 'plan';
/** The command the harness hands a work turn for the capabilities self-check. */
export const CAPABILITIES_CHECK_COMMAND = 'check-artifact capabilities';
// §28.5.1 — the frozen baseline is keyed by the git BRANCH (the slice all phase loops share), not the flow
// step, so a baseline the RED step recorded is found by the GREEN step (different step, same branch). This
// fake branch differs from STEP so a lingering step-match would fail these branch-keyed tests.
export const TEST_BRANCH = 'main';
export const TURN_KEY = 'work-plan';
export const REVIEW_KEY = 'review-plan';
export const CONSOLIDATE_KEY = 'consolidate-plan';
export const ROSTER = ['review-plan-principal', 'review-plan-security'];
export const FIXED = (): Date => new Date('2026-07-17T12:00:00.000Z');

// §28.5.3 — a DISTINGUISHABLE injected toolkit: its classifyOutcome recognizes a marker the real recognizer
// rejects, so a test asserts the engine surfaces THIS instance's BEHAVIOR — not object identity, which a
// behavior-preserving wrapper would break (CLAUDE.md: tests observe behavior, never internal wiring).
export const INJECTED_MARKER = 'injected-toolkit-marker';
const completionPredicatesSentinel: LoopCompletionPredicates = {
  classifyOutcome: (raw) => (raw === INJECTED_MARKER ? 'passed' : null),
  changedTestPaths: async () => ({ ok: false, cause: 'malformed', reason: 'sentinel' }),
  workingTreeTestPaths: async () => ({ ok: false, cause: 'malformed', reason: 'sentinel' }),
  recoverExitCode: async () => null,
  redCheckCommand: () => null,
  redCheck: async () => ({ kind: 'refused', reason: 'sentinel' }),
};

/** Flush the engine's async RED gate (redAsyncGate resolves on the fake predicate promises, then re-enters the
 *  runner). One macrotask drains the pending microtask chain. */
export const flushRedGate = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** An artifact binding as the def parser composes it — the confined absolute path plus the repo-relative
 *  form of that same location, both derived from the one loop-area segment list. */
export function binding(id: string, absPath: string): ArtifactBinding {
  return { id, path: absPath, rel: [...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR, basename(absPath)].join('/') };
}

type Engine = ReturnType<typeof createAppLoopEngine>;

/** §27.3/§27.12 — the §27 work-turn engine driven at its observable boundary with REAL fs and its domain ports
 *  as controllable fakes. One harness per test file; `setUp`/`tearDown` pair with the file's
 *  `beforeEach`/`afterEach`. The fields are the per-test knobs and observations the deps read and record. */
export class AppLoopEngineHarness {
  repo!: string;
  artifactPath!: string;
  resultPath!: string;
  hosted!: HostedAgentState;
  injected!: string[];
  deps!: AppLoopEngineDeps;
  /** §28.5.3 — the GREEN flag writer, swappable per-test (default: the REAL recordChangedTests). */
  recordChangedTestsImpl!: (repoDir: string, step: string, paths: readonly string[]) => void;
  audit!: Mock<(repoDir: string, cmd: string, exit: number | null) => void>;
  emitError!: Mock<(reason: string) => void>;
  terminateFlow!: Mock<(repoDir: string) => LifecycleTerminateResult>;
  armTimer!: Mock<() => void>;
  cancelTimer!: Mock<() => void>;
  readArtifact!: Mock<(p: string) => string | null>;
  /** §27.9/AC6 — the step a polish stand-down is active for; null = no stand-down. */
  polishStep!: string | null;
  /** When set, the engine's `clearPolish` dep throws this message. */
  clearPolishError!: string | null;
  /** §28.4 D2 — when set, the engine's `clearBaseline` dep throws this message. */
  clearBaselineError!: string | null;
  /** §28.5.3/S5 — when true, the engine's `resolveRefactorResultLocation` dep returns null. */
  refactorResultLocationNull!: boolean;
  workRefsResult!: WorkRefs;
  stepDecidesResult!: readonly string[] | null;
  /** §28.4.2 — the back-to-RED brief the engine's `sliceBrief` dep returns for the current slice. */
  sliceBriefResult!: { slice: number; fromStep: string; text: string } | null;
  /** The step the engine's `reopenStep` dep names as the back-to-red return step. */
  reopenStepResult!: string | null;
  /** §28.4 D1 */
  currentSliceResult!: number;
  defResult!: LoopDefV2Result;

  setUp = (): void => {
    this.repo = mkdtempSync(join(tmpdir(), 'appengine-'));
    mkdirSync(join(this.repo, 'recipe'), { recursive: true });
    writeFileSync(join(this.repo, 'recipe', 'work.md'), '# work turn\nProduce the plan.\n');
    this.artifactPath = join(this.repo, '.agent-terminal', 'loop', 'artifacts', 'plan.md');
    this.resultPath = join(this.repo, '.agent-terminal', 'loop', 'artifacts', 'red-result.json');
    this.hosted = 'idle';
    this.defResult = this.resolved(this.fileDef());
  };

  tearDown = (): void => {
    rmSync(this.repo, { recursive: true, force: true });
  };

  /** A resolved §27 def result rooted at the test repo's own temp dir. */
  resolved = (def: LoopDefV2): LoopDefV2Result => ({ ok: true, def, tierRoot: this.repo, defDir: join(this.repo, def.name) });

  /** A file-producing plan-loop def whose completion artifact resolves under the repo's §27 area, declaring a
   *  two-persona reviewer catalog and a compact pre-review boundary so the review-and-fix chain (N3) is real. */
  fileDef = (): LoopDefV2 => ({
    version: 'v2',
    name: 'plan-loop',
    work: { recipe: join(this.repo, 'recipe', 'work.md'), artifact: 'plan' },
    reviewers: [
      { persona: ROSTER[0], charter: join(this.repo, 'charter', 'principal.md'), tools: ['Read'] },
      { persona: ROSTER[1], charter: join(this.repo, 'charter', 'security.md'), tools: ['Read', 'Bash'] },
    ],
    rounds: { kind: 'engine', consolidator: join(this.repo, 'recipe', 'consolidate.md') },
    boundaries: [
      { boundary: 'pre-work', mode: 'clear' },
      { boundary: 'pre-review', mode: 'compact', message: 'Keep the plan and the ticket.' },
      { boundary: 'pre-consolidate', mode: 'compact', message: 'Keep the two round reports.' },
    ],
    report: { sections: ['summary'], polish: 'fix' },
    gate: [{ option: 'approve', sideEffects: [] }],
    pickup: { initialStatus: 'planning', branchTemplate: 'plan-loop/issue-{issue}', initialLabels: [], wipe: { mode: 'abort' } },
    inputs: [],
    outputs: [binding('plan', this.artifactPath)],
    exec: null,
  });

  /** A commit-producing def: its work artifact id has no output binding → done-signal alone. */
  commitDef = (): LoopDefV2 => ({
    ...this.fileDef(),
    work: { recipe: join(this.repo, 'recipe', 'work.md'), artifact: 'commits' },
    outputs: [],
  });

  /** §28.5.3/S5 — a REFACTOR loop def: `work.completion: refactor`, its work turn a `commits` turn (no result
   *  binding). The phase gate is on each review-and-fix ROUND. */
  refactorDef = (): LoopDefV2 => ({
    ...this.fileDef(),
    work: { recipe: join(this.repo, 'recipe', 'work.md'), artifact: 'commits', completion: 'refactor' },
    outputs: [],
  });

  /** A refactor def whose work.artifact DOES resolve to a marker-file binding. */
  refactorDefBound = (): LoopDefV2 => ({
    ...this.fileDef(),
    work: { recipe: join(this.repo, 'recipe', 'work.md'), artifact: 'plan', completion: 'refactor' },
  });

  /** §28.5.3 — a RED work-turn def: completion `red`, its work artifact resolving to a result-file binding under
   *  the §27 area. `withBinding: false` drops the binding (the resume-case F1 unresolved guard). */
  redDef = (withBinding = true): LoopDefV2 => ({
    ...this.fileDef(),
    work: { recipe: join(this.repo, 'recipe', 'work.md'), artifact: 'red-result', completion: 'red' },
    outputs: withBinding ? [binding('red-result', this.resultPath)] : [],
  });

  /** Build the engine over fresh fakes. `depsOverride` replaces individual deps last, so a caller can plug a
   *  real collaborator into any hook. */
  makeEngine = (
    persistOverride?: (repoDir: string, state: AppLoopRunState) => void,
    predicatesOverride?: LoopCompletionPredicates,
    currentBranchOverride: string | null = TEST_BRANCH,
    depsOverride: Partial<AppLoopEngineDeps> = {},
  ): Engine => {
    this.audit = vi.fn();
    this.emitError = vi.fn();
    this.terminateFlow = vi.fn(() => ({ outcome: 'reset' as const, view: {} as FlowStateView }));
    this.armTimer = vi.fn();
    this.cancelTimer = vi.fn();
    this.injected = [];
    this.workRefsResult = { ticket: null, pr: null };
    this.stepDecidesResult = null;
    this.sliceBriefResult = null;
    this.reopenStepResult = null;
    this.currentSliceResult = 1;
    this.polishStep = null;
    this.clearPolishError = null;
    this.clearBaselineError = null;
    this.refactorResultLocationNull = false;
    this.recordChangedTestsImpl = (repoDir, step, paths) => recordChangedTests(repoDir, step, paths);
    this.readArtifact = vi.fn((p: string) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    });
    this.deps = {
      inject: (text) => this.injected.push(text),
      polishActive: (_repoDir, step) => this.polishStep === step,
      clearPolish: (r) => {
        if (this.clearPolishError) throw new Error(this.clearPolishError);
        clearPolish(r);
      },
      hostedAgent: () => this.hosted,
      armTimer: this.armTimer,
      cancelTimer: this.cancelTimer,
      armAgentWait: () => {},
      cancelAgentWait: () => {},
      noteSettle: () => {},
      resolveDef: () => this.defResult,
      readRecipe: () => '# work turn\nProduce the plan.',
      readArtifact: (p) => this.readArtifact(p),
      inputState: probeChainedInput,
      assembleReport: (_repoDir, report) => {
        assembleReportOnDisk(report, [STEP]);
      },

      persist: persistOverride ?? ((repoDir, state) => writeAppLoopState(repoDir, state, FIXED)),
      audit: this.audit,
      emitError: this.emitError,
      onViewChanged: () => {},
      terminateFlow: this.terminateFlow,
      resolveReportLocation: (repoDir, round) => {
        const abs = roundReportFile(repoDir, round);
        return abs ? { abs, rel: roundReportRel(round) } : null;
      },
      resolveConsolidatorLocation: (repoDir, round) => {
        const abs = consolidatorOutputFile(repoDir, round);
        return abs ? { abs, rel: consolidatorOutputRel(round) } : null;
      },
      resolveRefactorResultLocation: (repoDir, round) => {
        if (this.refactorResultLocationNull) return null;
        const abs = refactorResultFile(repoDir, round);
        return abs ? { abs, rel: refactorResultRel(round) } : null;
      },
      completionPredicates: predicatesOverride ?? completionPredicatesSentinel,
      recordChangedTests: (repoDir, step, paths) => this.recordChangedTestsImpl(repoDir, step, paths),
      readBaseline: (repoDir) => readBaselineCommit(repoDir),
      clearBaseline: (repoDir) => {
        if (this.clearBaselineError) throw new Error(this.clearBaselineError);
        clearBaselineCommit(repoDir);
      },
      currentBranch: () => ({ ok: true, branch: currentBranchOverride }),
      pickupBranch: () => ({ kind: 'none' }),
      ensureReviewersRunnable: () => [],
      hostedAgentKind: () => 'claude-code',
      workRefs: () => this.workRefsResult,
      stepDecides: () => this.stepDecidesResult,
      clearDecision: clearDecisionFile,
      sliceBrief: () => this.sliceBriefResult,
      reopenStep: () => this.reopenStepResult,
      currentSlice: () => this.currentSliceResult,
      artifactCheckCommand: (check) =>
        check.kind === 'report'
          ? `check-artifact report ${check.rel} --sections ${check.sections.join(',')} --roster ${check.roster.join(',')}`
          : check.kind === 'verdict'
            ? `check-artifact verdict ${check.rel} --catalog ${check.catalog.join(',')}`
            : check.kind === 'progress'
              ? `check-artifact progress ${check.rel} ${check.leg} ${check.legs ? 'legs' : 'one-leg'}`
              : check.kind === 'capabilities'
                ? CAPABILITIES_CHECK_COMMAND
                : check.kind === 'decision'
                  ? `check-artifact decision ${check.rel} ${check.values.join(',')}`
                  : `check-artifact result ${check.rel} ${check.outcome} ${check.build ?? 'no-build'}${check.acceptsVerificationOnly ? ' verification-only' : ''}`,
      ...depsOverride,
    };
    return createAppLoopEngine(this.deps);
  };

  writeResult = (content: string, captured?: string | null): void => writePhaseResult(this.resultPath, content, captured);

  writeArtifact = (withMarker: boolean): void => {
    mkdirSync(join(this.repo, '.agent-terminal', 'loop', 'artifacts'), { recursive: true });
    writeFileSync(this.artifactPath, withMarker ? `# plan\n${completionMarker(STEP)}\n` : '# plan\n(no marker)\n');
  };

  /** Write a well-formed round-N report; `failed` names personas recorded as failed-to-run (§27.5/AC7). */
  writeRoundReport = (round: number, failed: string[] = []): void => {
    const p = roundReportFile(this.repo, round)!;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, roundReportWithStatuses(['summary'], ROSTER, Object.fromEntries(failed.map((persona) => [persona, 'failed' as const]))));
  };

  writeConsolidatorOutput = (round: number, content: string): void => {
    const p = consolidatorOutputFile(this.repo, round)!;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };

  /** A well-formed round-1 report accounting for the def's roster and its single section. */
  writeReport = (content = exampleRoundReport({ sections: ['summary'], roster: ROSTER })): void => {
    const p = roundReportFile(this.repo, 1)!;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };

  /** Drive enter → boundary drains → work prompt injects (hosted idle throughout). */
  enterAndInjectWork = (engine: Engine, entry: AppLoopEntry = 'chain-advance'): void => {
    engine.enter(this.repo, 'plan-loop', STEP, entry);
    engine.onInjectable();
  };

  /** Enter → complete the WORK turn → drain the pre-review boundary → the review-and-fix prompt injects. */
  driveToReviewInjected = (engine: Engine): void => {
    this.enterAndInjectWork(engine);
    this.writeArtifact(true);
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();
  };

  /** Drive work → review round 1 → the consolidator prompt injected (report is well-formed, `failed` optional). */
  driveToConsolidateInjected = (engine: Engine, failed: string[] = []): void => {
    this.driveToReviewInjected(engine);
    this.writeRoundReport(1, failed);
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();
  };

  /** Complete an in-flight consolidator turn of `round` by writing its output and firing the done-signal. */
  completeConsolidate = (engine: Engine, round: number, output: string): void => {
    this.writeConsolidatorOutput(round, output);
    engine.onDoneSignal();
  };

  /** Complete an ALREADY-ENTERED work turn → review → consolidate → the clean gate, so a test can choose the
   *  entry kind itself rather than inheriting the helper's `chain-advance`. */
  driveFromWorkToGate = (engine: Engine): void => {
    this.writeArtifact(true);
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();
    this.writeRoundReport(1, []);
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();
    this.completeConsolidate(engine, 1, verdictOutput('clean'));
  };

  /** From an in-flight review round `round` (just chained, awaiting injectable): drive the review prompt, land
   *  a well-formed report (optionally with `failed` lenses), and drive into the consolidator prompt injected. */
  advanceReviewToConsolidateInjected = (engine: Engine, round: number, failed: string[] = []): void => {
    engine.onInjectable();
    engine.onInjectable();
    this.writeRoundReport(round, failed);
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();
  };
}

export function createAppLoopEngineHarness(): AppLoopEngineHarness {
  return new AppLoopEngineHarness();
}
