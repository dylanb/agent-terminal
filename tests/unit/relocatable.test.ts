// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStatusStrip } from '../../src/renderer/src/statusStrip';
import { createFlowStrip } from '../../src/renderer/src/flowStrip';
import { createCaptureTab } from '../../src/renderer/src/captureTab';
import { createTodoTab } from '../../src/renderer/src/todoTab';
import type { FlowStateView, MonitorEvent, TodoItem } from '../../src/shared/ipc';

// UI-STANDARDS §1.2 / §9.1: every renderer organism builds its DOM from its HOST's document
// (`host.ownerDocument`), never the ambient global `document`, so it stays relocatable into
// another frame/process. We prove it observably: the host lives in a FOREIGN document and the
// global document NODE FACTORIES (createElement + createTextNode) are made hostile (throw). A clean
// organism renders its visible DOM into the foreign host regardless; one that reaches for any global
// factory produces nothing. (jsdom auto-adopts appended nodes, so post-render ownerDocument cannot
// discriminate — the hostile global is what makes the otherwise-latent reach observable.)

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A host in a foreign document, with the global document node factories (createElement AND
 *  createTextNode) poisoned so any organism that reaches for the ambient global instead of
 *  `host.ownerDocument` fails to render. Restored in afterEach. */
function foreignDocWithHostileGlobal(): Document {
  const foreign = document.implementation.createHTMLDocument('relocated');
  const hostile = (factory: string) => () => {
    throw new Error(`organism reached for the ambient global document.${factory} instead of its host`);
  };
  vi.spyOn(document, 'createElement').mockImplementation(hostile('createElement'));
  vi.spyOn(document, 'createTextNode').mockImplementation(hostile('createTextNode'));
  return foreign;
}

describe('renderer organisms are relocatable — render against host.ownerDocument (UI-STANDARDS §1.2)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('statusStrip renders its chips into the host document', () => {
    const foreign = foreignDocWithHostileGlobal();
    const host = foreign.createElement('div');
    const strip = createStatusStrip(host);
    strip.update({ sessionId: 's1', altScreen: false, bracketedPaste: false, agentState: 'quiet', quietSince: null });
    expect(host.querySelectorAll('.status-chip')).toHaveLength(4);
  });

  it('flowStrip renders the station rail into the host document', async () => {
    const foreign = foreignDocWithHostileGlobal();
    const host = foreign.createElement('div');
    const state: FlowStateView = { stepName: 'Build', position: 1, total: 1, status: 'not_started' };
    const strip = createFlowStrip(host, {
      state: vi.fn(async () => state),
      start: vi.fn(async () => state),
      advance: vi.fn(async () => state),
      restart: vi.fn(async () => state),
      undo: vi.fn(async () => state),
      onStateChanged: vi.fn(() => () => {}),
    });
    strip.onRepoChanged('/repo');
    await flush();
    expect(host.querySelector('.flow.vert')).toBeTruthy();
    expect(host.querySelectorAll('.stn')).toHaveLength(3);
  });

  it('captureTab renders a finding card into the host document', () => {
    const foreign = foreignDocWithHostileGlobal();
    const blocksEl = foreign.createElement('div');
    const tab = createCaptureTab({
      blocksEl,
      todoSink: {
        currentRepoKey: () => '/repo',
        addFromCapture: vi.fn(async () => null),
        deleteTodo: vi.fn(async () => undefined),
      } as never,
      monitor: { dismiss: vi.fn(), dismissAll: vi.fn() } as never,
      doInject: vi.fn(),
    });
    const finding: MonitorEvent = {
      id: 'f1',
      sessionId: 's1',
      type: 'finding',
      source: 'shadow-scan',
      text: 'a finding worth keeping',
      range: null,
      parentId: null,
      truncated: false,
      capturedAt: new Date(0).toISOString(),
    };
    tab.appendBlock(finding);
    expect(blocksEl.querySelector('.finding')).toBeTruthy();
  });

  it('todoTab renders its rows into the host document', async () => {
    const foreign = foreignDocWithHostileGlobal();
    const todoListEl = foreign.createElement('div');
    const todoCountEl = foreign.createElement('span');
    const todos: TodoItem[] = [
      { id: 't1', repoKey: '/repo', text: 'do it', status: 'active', order: 0, createdAt: new Date(0).toISOString() },
    ];
    const tab = createTodoTab({
      todoListEl,
      todoCountEl,
      monitor: {
        todoList: vi.fn(async () => todos),
        // A non-empty library renders the "From template" toggle, whose label uses
        // doc.createTextNode — exercising the createTextNode arm of the hostile-global guard.
        listTemplates: vi.fn(async () => ({ templates: [{ ref: 'r', name: 'R' }] })),
      } as never,
      doInject: vi.fn(),
    });
    tab.onRepoChanged('/repo');
    await flush();
    expect(todoListEl.querySelector('.todo')).toBeTruthy();
    expect(todoListEl.querySelector('.tmpl-toggle')).toBeTruthy(); // createTextNode path rendered
  });
});
