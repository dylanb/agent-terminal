import { describe, expect, it } from 'vitest';
import {
  createAppBootstrapConflicts,
  type AppBootstrapConflictRunners,
} from '../../src/main/bootstrapPorts';

describe('app bootstrap conflict port', () => {
  it('never offers or closes a fork pull request that reuses the target branch name', async () => {
    const ghCalls: string[][] = [];
    let closedSameRepositoryPullRequest = false;
    const runners: AppBootstrapConflictRunners = {
      git: async (args) => {
        if (args[0] === 'branch' && args[1] === '--list') return '';
        if (args[0] === 'ls-remote') return '';
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
      gh: async (args) => {
        ghCalls.push(args);
        if (args[0] === 'repo' && args[1] === 'view') {
          return JSON.stringify({ nameWithOwner: 'owner/repository' });
        }
        if (args[0] === 'pr' && args[1] === 'list') {
          const sameRepository = closedSameRepositoryPullRequest
            ? []
            : [
                {
                  number: 41,
                  isCrossRepository: false,
                  headRepository: { name: 'repository' },
                  headRepositoryOwner: { login: 'owner' },
                },
              ];
          return JSON.stringify([
            ...sameRepository,
            {
              number: 99,
              isCrossRepository: true,
              headRepository: { name: 'fork' },
              headRepositoryOwner: { login: 'contributor' },
            },
          ]);
        }
        if (args[0] === 'pr' && args[1] === 'close' && args[2] === '41') {
          closedSameRepositoryPullRequest = true;
          return '';
        }
        throw new Error(`unexpected gh call: ${args.join(' ')}`);
      },
    };

    const conflicts = createAppBootstrapConflicts(runners);
    const target = await conflicts.inspect('plan-loop/issue-78');

    expect(target.pullRequests).toEqual([41]);
    await conflicts.wipe(target);
    expect(ghCalls.filter((args) => args[0] === 'pr' && args[1] === 'close')).toEqual([
      ['pr', 'close', '41'],
    ]);
  });
});
