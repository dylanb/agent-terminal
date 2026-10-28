// @vitest-environment jsdom
import { directoryCards } from '../../src/shared/controllerCards';
import { afterEach, describe, expect, it } from 'vitest';
import { createControllerCard } from '../../src/renderer/src/controllerCard';
import { CONTROLLER_OVERSIZED_STATUS_TEXT } from '../../src/shared/controllerStatus';
import type { ControllerTerminal } from '../../src/shared/ipc';
import { bringForwardIn, cardHeaderIn, cardIn, controlName, dismissIn, showsName, statusRowIn } from '../helpers/controllerCards';
import { STATUS_CASES, statusTerminal, type WorkStatus } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

function mount(terminal: ControllerTerminal, expanded = true) {
  const host = document.createElement('div');
  document.body.append(host);
  const calls = { bringForward: 0, dismiss: 0 };
  const deps = {
    card: directoryCards([terminal])[0],
    expandedByDefault: expanded,
    onAction() { calls[terminal.status === 'disconnected' ? 'dismiss' : 'bringForward'] += 1; },
  };
  const card = createControllerCard(host, deps);
  return { host, calls, card, element: cardIn(host, terminal.launchDirectory) };
}

const withWork = (work: Partial<WorkStatus>): ControllerTerminal => statusTerminal(work);

function missingInOrder(text: string, texts: readonly string[]): string[] {
  let from = 0;
  return texts.flatMap(expected => {
    const at = text.indexOf(expected, from);
    if (at < 0) return [`"${expected}" missing after offset ${from}`];
    from = at + expected.length;
    return [];
  });
}

function isLastElement(card: HTMLElement, control: HTMLElement | undefined): boolean {
  return Boolean(control) && [...card.querySelectorAll('*')].every(element => element === control || control!.contains(element)
    || !(control!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING));
}

describe('controller card header', () => {
  it.each([
    ['the repository root', { id: 'r', launchDirectory: '/left/repo-root/worktrees/feature', repositoryRoot: '/left/repo-root' }, 'repo-root'],
    ['the launch directory when there is no root', { id: 'n', launchDirectory: '/tmp/scratch-dir', repositoryRoot: null }, 'scratch-dir'],
  ] as const)('names the card after the final segment of %s and shows the full directory', (_, terminal, name) => {
    const { element } = mount(terminal);
    expect({ card: Boolean(element), name: showsName(element, terminal.launchDirectory, name) }).toEqual({ card: true, name: true });
  });
});

describe('controller card header control', () => {
  it.each([true, false])('exposes expanded=%s on a header control named with the directory, with the status in a collapsed header', expanded => {
    const { terminal, text } = STATUS_CASES.working;
    const { element } = mount(terminal, expanded);
    const header = element ? cardHeaderIn(element, terminal.launchDirectory) : undefined;
    expect({ state: header?.getAttribute('aria-expanded'), label: expanded || (header?.textContent?.includes(text) ?? false) })
      .toEqual({ state: String(expanded), label: true });
  });

  it('collapses and expands the card on each header click, and never brings it forward', () => {
    const { terminal } = STATUS_CASES.working;
    const { element, calls } = mount(terminal);
    const header = element ? cardHeaderIn(element, terminal.launchDirectory) : undefined;
    const states = [1, 2].map(() => { header?.click(); return header?.getAttribute('aria-expanded'); });
    expect({ states, calls }).toEqual({ states: ['false', 'true'], calls: { bringForward: 0, dismiss: 0 } });
  });
});

describe('controller card body', () => {
  it('runs status, ticket, flow, activity and both condition boxes in order, with Bring forward last', () => {
    const { terminal, text } = STATUS_CASES['flow-error-and-human'];
    const { element } = mount(terminal);
    const status = element ? statusRowIn(element)?.textContent?.trim() : undefined;
    expect([
      ...(status === text ? [] : [`status row reads ${status}`]),
      ...missingInOrder(element?.textContent ?? '', [
        text, '#219', 'Show live controller status', 'Flow: feature-dev — Step: implement', 'Idle',
        'Human needed: needs a human', 'Approve the plan', 'Error', 'Step exited 1',
      ]),
      ...(element && isLastElement(element, bringForwardIn(element)) ? [] : ['Bring forward is not the last element']),
    ]).toEqual([]);
  });

  it.each([
    ['a loading title', withWork({ ticket: { availability: 'known', number: 219, title: { availability: 'loading' } } }), ['#219', 'Title loading']],
    ['an unavailable title', withWork({ ticket: { availability: 'known', number: 219, title: { availability: 'unavailable' } } }), ['#219', 'Title unavailable']],
    ['an unassigned terminal', STATUS_CASES.unassigned.terminal, ['No flow run started']],
    ['started work with no ticket', withWork({ ticket: { availability: 'none' } }), ['No ticket']],
    ['a loading ticket', withWork({ ticket: { availability: 'loading' } }), ['Ticket loading']],
    ['an unavailable ticket', withWork({ ticket: { availability: 'unavailable' } }), ['Ticket unavailable']],
    ['a loading flow', STATUS_CASES['flow-loading'].terminal, ['Flow loading']],
    ['an unavailable flow', STATUS_CASES['flow-unavailable'].terminal, ['Flow unavailable']],
  ] as const)('shows the alternative text for %s', (_, terminal, texts) => {
    const { element } = mount(terminal);
    expect(missingInOrder(element?.textContent ?? '', texts)).toEqual([]);
  });

  it.each([
    ['active', 'Working'], ['quiet', 'Idle'], ['unavailable', 'Activity unavailable'],
  ] as const)('reads the %s activity line, after the flow line, as %s', (activity, word) => {
    const { element } = mount(withWork({ activity, attention: { status: 'needs a human', reasons: ['Approve the plan'] } }));
    const text = element?.textContent ?? '';
    const flowLine = 'Flow: feature-dev — Step: implement';
    const afterFlow = text.slice(text.indexOf(flowLine) + flowLine.length);
    expect({ flowLine: text.includes(flowLine), activityLine: afterFlow.trimStart().slice(0, word.length) }).toEqual({ flowLine: true, activityLine: word });
  });

  it('shows the activity apart from the status text', () => {
    const { element } = mount(STATUS_CASES.idle.terminal);
    const status = element ? statusRowIn(element) : null;
    expect({ status: status?.textContent?.trim(), activity: missingInOrder(element?.textContent ?? '', ['Flow: feature-dev — Step: implement', 'Idle']) })
      .toEqual({ status: 'Idle', activity: [] });
  });

  it.each([
    ['Loading', STATUS_CASES.loading.terminal, [] as string[]],
    ['Status unavailable', STATUS_CASES.oversized.terminal, [CONTROLLER_OVERSIZED_STATUS_TEXT]],
  ] as const)('shows only the status row, any oversized message and Bring forward in %s', (status, terminal, extra) => {
    const { element } = mount(terminal);
    const text = (element?.textContent ?? '').replace(CONTROLLER_OVERSIZED_STATUS_TEXT, '');
    expect([
      ...(element ? [] : ['no card']),
      ...(element && statusRowIn(element)?.textContent?.trim() === status ? [] : ['wrong status row']),
      ...missingInOrder(element?.textContent ?? '', extra),
      ...(element && bringForwardIn(element) ? [] : ['no Bring forward']),
      ...['#', 'Ticket', 'No ticket', 'No flow run started', 'Flow', 'Working', 'Idle', 'Activity'].filter(line => text.includes(line)).map(line => `shows "${line}"`),
    ]).toEqual([]);
  });

  it('offers Bring forward, named with the directory, which reports its use once', () => {
    const { terminal } = STATUS_CASES.working;
    const { element, calls } = mount(terminal);
    const control = element ? bringForwardIn(element) : undefined;
    control?.click();
    expect({
      named: controlName(control).includes(terminal.launchDirectory),
      calls,
    }).toEqual({ named: true, calls: { bringForward: 1, dismiss: 0 } });
  });

  it('shows a disconnected card as Disconnected with no work details and Dismiss last, which reports its use once', () => {
    const { terminal } = STATUS_CASES['disconnected-with-error'];
    const { element, calls } = mount(terminal);
    const dismiss = element ? dismissIn(element) : undefined;
    dismiss?.click();
    const text = element?.textContent ?? '';
    expect([
      ...(element ? [] : ['no card']),
      ...(element && statusRowIn(element)?.textContent?.trim() === 'Disconnected' ? [] : ['wrong status row']),
      ...['Step exited 1', 'Approve the plan', 'Human needed', '#219', 'Flow:', 'Working'].filter(detail => text.includes(detail)).map(detail => `shows "${detail}"`),
      ...(element && bringForwardIn(element) ? ['offers Bring forward'] : []),
      ...(element && isLastElement(element, dismiss) ? [] : ['Dismiss is not the last element']),
      ...(controlName(dismiss).includes(terminal.launchDirectory) ? [] : ['Dismiss is not named with the directory']),
      ...(calls.dismiss === 1 && calls.bringForward === 0 ? [] : [`calls ${JSON.stringify(calls)}`]),
    ]).toEqual([]);
  });
});
