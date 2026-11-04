// `agent-terminal --validate-flow <dir>` on a global or bundled flow folder that itself holds a loop override
// registry: a run of such a flow consults no repository override, so the registry's loop does not resolve.

import { expect, test } from '@playwright/test';
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { flowLocations, writeFlow, writeLoopDef, writeLoopRegistry } from '../helpers/flowFixtures';
import { problemLine, problemOutcome, useValidateRuntime } from './validateFlowHarness';

test.describe('agent-terminal --validate-flow reads no override registry in a global or bundled flow folder', { tag: '@ownapp' }, () => {
  const runtime = useValidateRuntime();

  const folders: readonly { tier: string; folder: () => string }[] = [
    { tier: 'a global catalog flow', folder: () => flowLocations.globalCatalogEntry(runtime.world().appHome, 'f') },
    { tier: 'the global fallback <A>/.agent-terminal/', folder: () => flowLocations.globalFallback(runtime.world().appHome) },
    {
      tier: 'a source tree\'s example flow',
      folder: () => {
        const tree = runtime.world().dir('tree');
        writeLoopDef(flowLocations.bundledLoops(tree), 'tree-loop');
        return flowLocations.bundledEntry(tree, 'f');
      },
    },
  ];
  for (const { tier, folder: makeFolder } of folders) {
    test(`${tier} whose folder maps a loop in its own registry fails naming that loop`, async () => {
      const folder = makeFolder();
      const defFile = writeLoopDef(folder, 'folder-loop');
      writeLoopRegistry(folder, { 'folder-loop': relative(folder, defFile) });
      const tiers = { operator: null, appBundled: runtime.world().dir('empty-bundle'), retired: null };
      if (!resolveLoopDefV2('folder-loop', { tiers, repoDir: folder }).ok) throw new Error('fixture: the folder\'s registry does not map folder-loop');
      const flowFile = writeFlow(folder, { name: 'f', steps: [{ id: 'step-1', kind: 'loop', loop: 'folder-loop' }] });
      const result = await runtime.validate([folder], { cwd: runtime.world().root });
      expect(problemOutcome(result, realpathSync(flowFile))).toEqual(problemLine(expect.stringContaining('folder-loop')));
    });
  }
});
