// `agent-terminal --validate-flow <dir>` on a flow whose todo template, loop definition or loop override
// registry is a named pipe: the command reports the one problem and exits, instead of blocking on the read.

import { expect, test } from '@playwright/test';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { LOOP_OVERRIDE_FILE, loopDefRelPath } from '../../src/main/appLoopPaths';
import { todoTemplateFile, todoTemplatesDir } from '../../src/main/todoTemplate';
import { flowLocations, writeFifo, writeFlow, writeLoopRegistry } from '../helpers/flowFixtures';
import { problemLine, problemOutcome, useValidateRuntime } from './validateFlowHarness';

test.describe('agent-terminal --validate-flow does not block on a named pipe', { tag: '@ownapp' }, () => {
  const runtime = useValidateRuntime();

  test('a todo template that is a named pipe is a flow.yaml problem naming the template', async () => {
    const repo = runtime.world().dir('repo');
    const folder = flowLocations.repoCatalogEntry(repo, 'f');
    const flowFile = writeFlow(folder, { name: 'f', steps: [{ id: 'piped', kind: 'manual', todoTemplate: 'piped-template' }] });
    writeFifo(join(todoTemplatesDir(folder), todoTemplateFile('piped-template')));
    const result = await runtime.validate([folder], { cwd: repo });
    expect(problemOutcome(result, realpathSync(flowFile))).toEqual(problemLine(expect.stringContaining('piped-template')));
  });

  test('a loop definition that is a named pipe is a problem naming the loop, on that definition', async () => {
    const repo = runtime.world().dir('repo');
    const defFile = join(repo, 'own-loops', loopDefRelPath('piped-loop'));
    writeFifo(defFile);
    writeLoopRegistry(repo, { 'piped-loop': join('own-loops', loopDefRelPath('piped-loop')) });
    const folder = flowLocations.repoCatalogEntry(repo, 'f');
    writeFlow(folder, { name: 'f', steps: [{ id: 'step-1', kind: 'loop', loop: 'piped-loop' }] });
    const result = await runtime.validate([folder], { cwd: repo });
    expect(problemOutcome(result, realpathSync(defFile))).toEqual(problemLine(expect.stringContaining('piped-loop')));
  });

  test('a loop override registry that is a named pipe is a flow.yaml problem naming the registry', async () => {
    const repo = runtime.world().dir('repo');
    writeFifo(join(repo, LOOP_OVERRIDE_FILE));
    const folder = flowLocations.repoCatalogEntry(repo, 'f');
    const flowFile = writeFlow(folder, { name: 'f', steps: [{ id: 'step-1', kind: 'loop', loop: 'any-loop' }] });
    const result = await runtime.validate([folder], { cwd: repo });
    expect(problemOutcome(result, realpathSync(flowFile))).toEqual(problemLine(expect.stringContaining(LOOP_OVERRIDE_FILE)));
  });
});
