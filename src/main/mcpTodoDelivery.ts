import type { McpCaller, McpTmux } from '../shared/mcpBridge';
import type { SessionTurns } from './mcpSessionTurns';
import { createRecipientInjector } from './recipientInjector';

export interface TerminalDestination {
  identity: string;
  paste(text: string): void;
  write(text: string): void;
}

export function createMcpTodoDelivery(deps: {
  sessions: Pick<SessionTurns, 'acceptSend' | 'deliverPending' | 'cancelInterruptedSends' | 'cancelPending' | 'injected'>;
  destination(session: number, tmux?: McpTmux): TerminalDestination | null;
  markSent(repo: string, todo: string): void;
  deliveryObserver(): (reason?: string) => void;
  noteInjection(): void;
  reportDrop(reason: string): void;
}) {
  return {
    send(caller: McpCaller, repo: string, todo: { id: string; text: string }): string | null {
      return caller.session === null ? 'the calling session is unknown.'
        : deps.sessions.acceptSend(caller.session, todo, () => deps.markSent(repo, todo.id), deps.deliveryObserver());
    },
    flush(idle: boolean): void {
      deps.sessions.deliverPending(idle, (text, session, identity, tmux, delivery) => {
        const onDrop = (reason: string): void => { delivery.finish(reason); deps.reportDrop(reason); };
        const destination = deps.destination(session, tmux);
        if (destination?.identity !== identity) { onDrop('the destination changed.'); return; }
        const inject = createRecipientInjector({
          canReceive: delivery.canReceive, paste: destination.paste, write: destination.write,
          onInject: () => {
            deps.sessions.injected(text, { submitted: true, sendingSession: session });
            deps.noteInjection();
          }, onDrop,
        });
        inject(text, { submit: true, onComplete: delivery.finish });
      });
    },
    recipientChanged(): void { deps.sessions.cancelInterruptedSends(); },
    close(): void { deps.sessions.cancelPending('the terminal closed.'); },
  };
}
