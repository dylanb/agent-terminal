import { createFlowManager } from '../../src/main/flow';
import { selectIfUnlocked } from '../../src/main/activeFlowGate';
import { createRunResolver } from '../../src/main/runResolver';
import { realHeldRunRecoveryDeps, type HeldRunRecoveryDeps } from '../../src/main/heldRunRecovery';
import { repoOnlyDefTiers } from './defTiers';

export type ProductionRecoveryDeps = Omit<HeldRunRecoveryDeps, 'lock'>;

export function productionRecoveryDeps(globalDir: string): ProductionRecoveryDeps {
  const manager = () => createFlowManager({ globalDir, loadDefinition: (repoKey) => createRunResolver(globalDir, repoOnlyDefTiers())(repoKey) });
  return {
    ...realHeldRunRecoveryDeps(globalDir, repoOnlyDefTiers()),
    terminate: (worktree: string) => manager().terminate(worktree),
    selectIfUnlocked,
  };
}
