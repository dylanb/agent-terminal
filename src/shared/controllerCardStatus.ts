import type { ControllerTerminal } from './ipc';

export type CardStatusClass = 'error' | 'needs-human' | 'working' | 'completed' | 'idle';
export type SummaryLabel = 'errors' | 'need a human' | 'idle' | 'working';

export interface CardStatus {
  text: string;
  statusClass: CardStatusClass;
  summary: SummaryLabel;
}

export function cardStatus(terminal: ControllerTerminal): CardStatus {
  void terminal;
  return { text: '', statusClass: 'idle', summary: 'idle' };
}
