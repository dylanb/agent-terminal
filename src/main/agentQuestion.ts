// §27.9.1 N9b.10, §27.2

import type { HostedAgentState } from './loopOrchestrator';
import { errMsg } from './errno';

export interface AgentQuestionDeps {
  readiness: () => HostedAgentState;
  inject: (text: string) => void;
}

export interface AgentQuestion {
  ask(question: string): void;
  withdraw(): void;
  onInjectable(): void;
}

export function createAgentQuestion(deps: AgentQuestionDeps): AgentQuestion {
  let held: string | null = null;
  const deliver = (): void => {
    if (held === null) return;
    const state = deps.readiness();
    if (state === 'busy') return;
    const question = held;
    held = null;
    if (state === 'absent') return;
    try {
      deps.inject(question);
    } catch (e) {
      void errMsg(e);
    }
  };
  return {
    ask(question) {
      held = question;
      deliver();
    },
    withdraw() {
      held = null;
    },
    onInjectable: deliver,
  };
}
