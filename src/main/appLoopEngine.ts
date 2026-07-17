// STUB (RED): the §27 work-turn engine. Filled in the GREEN commit.

import type { HostedAgentState } from './loopOrchestrator';
import type { LoopDefV2Result } from './loopDefV2';
import type { AppLoopRunState } from './appLoopState';

export type AppRouteOut = 'retry' | 'accept' | 'terminate';

export interface AppLoopEngineDeps {
  inject(text: string): void;
  hostedAgent(): HostedAgentState;
  armTimer(): void;
  cancelTimer(): void;
  noteSettle(): void;
  now(): Date;
  resolveDef(loopName: string): LoopDefV2Result;
  readRecipe(absPath: string): string | null;
  readArtifact(absPath: string): string | null;
  persist(repoDir: string, state: AppLoopRunState): void;
  audit(repoDir: string, cmd: string, exit: number | null): void;
  emitError(reason: string): void;
  onViewChanged(): void;
  terminateFlow(repoDir: string): void;
}

export interface AppLoopEngine {
  enter(repoDir: string, loopName: string, stepId: string): void;
  onInjectable(): void;
  onDoneSignal(): void;
  noteActivity(): void;
  onStall(): void;
  routeOut(repoDir: string, stepId: string, turnKey: string, action: AppRouteOut): void;
  resume(repoDir: string): void;
  activeTurnKey(): string | null;
  activeRepoDir(): string | null;
}

export function createAppLoopEngine(_deps: AppLoopEngineDeps): AppLoopEngine {
  return {
    enter: () => {},
    onInjectable: () => {},
    onDoneSignal: () => {},
    noteActivity: () => {},
    onStall: () => {},
    routeOut: () => {},
    resume: () => {},
    activeTurnKey: () => null,
    activeRepoDir: () => null,
  };
}
