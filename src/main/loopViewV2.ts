import type { FlowLoopView } from '../shared/ipc';
import { type LoopDefV2Context } from './loopDefV2';

export function deriveAppLoopView(_name: string, _ctx: LoopDefV2Context): FlowLoopView {
  return { status: 'stub', pr: null, branch: null, ready: false };
}
