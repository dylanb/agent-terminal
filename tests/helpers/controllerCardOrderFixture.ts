import type { ControllerTerminal } from '../../src/shared/ipc';
import { STATUS_CASES, type StatusCaseKey } from './controllerStatusFixture';

/** The `STATUS_CASES` terminal for `status`, moved to a launch directory of its own (`/order/<name>/worktree`), so a
 *  test can put several cards in one status group and tell each apart by directory. */
export function orderTerminal(name: string, status: StatusCaseKey): ControllerTerminal {
  return {
    ...STATUS_CASES[status].terminal,
    id: `order-${name}`,
    launchDirectory: `/order/${name}/worktree`,
    repositoryRoot: `/order/${name}`,
  };
}

/** The directory `orderTerminal(name, …)` launches in. */
export const orderDirectory = (name: string): string => `/order/${name}/worktree`;
