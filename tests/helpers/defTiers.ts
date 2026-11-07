import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LoopDefV2Tiers } from '../../src/main/loopDefV2';

/** Def tiers holding no defs, so a flow's loop steps resolve only through the repository's own `.agent-loop.yaml`. */
export const repoOnlyDefTiers = (): LoopDefV2Tiers => ({ operator: null, appBundled: join(tmpdir(), `no-app-bundled-tier-${randomUUID()}`), retired: null });
