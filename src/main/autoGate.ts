import type { ConsolidatorVerdict } from '../shared/consolidatorOutput';
import type { FlowDefinition } from './flow';
import type { ApproveDecider, GateApproveOutcome } from './appGateDecision';
import type { AutoGateViewFor } from './loopViewV2';
import type { DispositionRead } from './resolveRunDefinition';

// §27.9.1 N9b.5(e)
export const AUTO_GATE_DECISION_DEFAULT_MS = 300_000;
// §27.9.1 N9b.7(a)
export const START_CAPTURE_TIMEOUT_MS = 5_000;

export type DefTier = 'repo' | 'operator' | 'app-bundled';
export interface DefIdentity {
  name: string;
  digest: string;
}
export interface DefResolution {
  tier: DefTier;
  identity: DefIdentity | null;
  completion?: 'red' | 'green' | 'refactor';
}

export interface StartRun {
  definition: FlowDefinition;
  flowSourceTrust: 'operator' | 'repo';
  binding?: DispositionRead;
}

export type GateCause = 'verdict' | 'interrupt';
export type LoopRunEvent = 'error' | 'retried' | 'accepted' | { roundReport: string };
export type EngineApprove = (repoDir: string, step: string, turnKey: string, decider: ApproveDecider) => Promise<GateApproveOutcome>;
export interface AutoGateTimer {
  readonly id: number;
}

export interface AutoGateDeps {
  audit: (repoDir: string, cmd: string, exit: number | null) => void;
  resolveDef: (repoDir: string, loop: string) => DefResolution | null;
  currentRun: (repoDir: string, heldBinding: DispositionRead) => StartRun | null;
  runInProgressAt: (repoDir: string, step: string) => boolean;
  onViewChanged: (repoKey: string) => void;
  setTimer: (cb: () => void, ms: number) => AutoGateTimer;
  clearTimer: (handle: AutoGateTimer) => void;
}

export interface AutoGate {
  bindAtStart(repoKey: string, run: StartRun, startedAt: number, captureTrustedGlobsCommit: (repoDir: string) => string | null): void;
  discardStart(repoKey: string): void;
  commitStart(repoKey: string): void;
  endRun(repoKey: string): void;
  clearAuthority(repoKey: string): void;
  beginLoopRun(repoKey: string, step: string): void;
  observeDefResolution(repoKey: string, name: string, result: DefResolution | null): void;
  gateReaching(repoDir: string, step: string, turnKey: string, verdict: ConsolidatorVerdict, cause: GateCause): void;
  gateReached(repoDir: string, step: string, turnKey: string): void;
  gateNotReached(repoDir: string, step: string, turnKey: string): void;
  loopRunEvent(repoDir: string, step: string, turnKey: string, event: LoopRunEvent): void;
  interruptArmed(repoDir: string, step: string): boolean;
  consumeInterrupt(repoDir: string): void;
  armInterrupt(repoKey: string, step: string): void;
  humanAttempt(repoKey: string): void;
  attachApprove(approve: EngineApprove): void;
  isAutoRun(repoKey: string): boolean;
  autoGateViewFor: AutoGateViewFor;
}

export function createAutoGate(_deps: AutoGateDeps): AutoGate {
  return {
    bindAtStart: () => {},
    discardStart: () => {},
    commitStart: () => {},
    endRun: () => {},
    clearAuthority: () => {},
    beginLoopRun: () => {},
    observeDefResolution: () => {},
    gateReaching: () => {},
    gateReached: () => {},
    gateNotReached: () => {},
    loopRunEvent: () => {},
    interruptArmed: () => false,
    consumeInterrupt: () => {},
    armInterrupt: () => {},
    humanAttempt: () => {},
    attachApprove: () => {},
    isAutoRun: () => false,
    autoGateViewFor: () => undefined,
  };
}

export function captureTrustedGlobsCommit(_repoDir: string, _timeoutMs: number): string | null {
  return null;
}
