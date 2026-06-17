// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createArtifacts, SAMPLE_ARTIFACTS, type Artifact } from '../../src/renderer/src/artifacts';

// §20.2 artifact viewer organism: a fixture-fed file tree + a viewer that renders markdown
// or code through injected render seams, with a selection routed to the two §16.2 sinks
// (send-to-agent / add-to-todo). The heavy markdown-it/mermaid/CodeMirror impls are the
// production render seams; here they are faked so the test observes the organism's own
// behavior at the DOM/sink boundary, not the libraries.

const FIXTURE: Artifact[] = [
  { id: 'rev', name: 'review.md', group: 'This run', tag: 'iter 03', icon: 'md', kind: 'markdown', body: '# Review\n\nThe scanner carves tool calls.' },
  { id: 'scn', name: 'scanner.ts', group: 'This run', tag: 'code', icon: 'ts', kind: 'code', lang: 'typescript', body: 'export const QUIET_MS = 500;' },
];

function mount(over: Partial<Parameters<typeof createArtifacts>[1]> = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const renderMarkdown = vi.fn((body: string, into: HTMLElement) => { into.textContent = body; });
  const renderCode = vi.fn((body: string, _lang: string | undefined, into: HTMLElement) => { into.textContent = body; });
  const send = vi.fn();
  const addToTodo = vi.fn();
  let selection = '';
  const readSelection = vi.fn(() => selection);
  const api = createArtifacts(host, { artifacts: FIXTURE, send, addToTodo, renderMarkdown, renderCode, readSelection, ...over });
  return {
    host, api, renderMarkdown, renderCode, send, addToTodo, readSelection,
    setSelection: (s: string) => { selection = s; },
    rows: () => [...host.querySelectorAll('.tree .f')] as HTMLElement[],
    body: () => host.querySelector('.vbody') as HTMLElement,
    title: () => host.querySelector('.vtitle') as HTMLElement,
  };
}

beforeEach(() => { document.body.replaceChildren(); });

describe('artifact viewer (§20.2 / §24.1)', () => {
  it('renders one tree row per fixture artifact, with name and provenance tag, under group headers', () => {
    const v = mount();
    const rows = v.rows();
    expect(rows.map((r) => r.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('review.md'), expect.stringContaining('scanner.ts')]),
    );
    expect(rows.find((r) => r.textContent?.includes('review.md'))?.textContent).toContain('iter 03');
    expect([...v.host.querySelectorAll('.tree .grp')].map((g) => g.textContent)).toContain('This run');
  });

  it('opens the first artifact by default, rendering its markdown body and naming it', () => {
    const v = mount();
    expect(v.renderMarkdown).toHaveBeenCalledWith('# Review\n\nThe scanner carves tool calls.', v.body());
    expect(v.title().textContent).toContain('review.md');
  });

  it('clicking a code artifact renders it through the code seam with its language', () => {
    const v = mount();
    v.rows().find((r) => r.textContent?.includes('scanner.ts'))!.click();
    expect(v.renderCode).toHaveBeenCalledWith('export const QUIET_MS = 500;', 'typescript', v.body());
    expect(v.title().textContent).toContain('scanner.ts');
  });

  it('marks the open artifact as selected in the tree', () => {
    const v = mount();
    v.rows().find((r) => r.textContent?.includes('scanner.ts'))!.click();
    const sel = v.rows().filter((r) => r.classList.contains('sel'));
    expect(sel).toHaveLength(1);
    expect(sel[0].textContent).toContain('scanner.ts');
  });

  it('Send to agent routes the viewer selection to the send sink (§9.3)', () => {
    const v = mount();
    v.setSelection('drops findings under the floor');
    (v.host.querySelector('.art-send') as HTMLButtonElement).click();
    expect(v.send).toHaveBeenCalledWith('drops findings under the floor');
  });

  it('Add to todo routes the viewer selection to the todo sink (§16.2)', () => {
    const v = mount();
    v.setSelection('bound the scrollback re-scan');
    (v.host.querySelector('.art-todo') as HTMLButtonElement).click();
    expect(v.addToTodo).toHaveBeenCalledWith('bound the scrollback re-scan');
  });

  it('falls back to the last in-viewer selection when the click has cleared the live one', () => {
    const v = mount();
    v.setSelection('re-reads scrollback on every quiet pause');
    document.dispatchEvent(new Event('selectionchange')); // captured as it happened
    v.setSelection(''); // clicking the button collapses the live selection
    (v.host.querySelector('.art-send') as HTMLButtonElement).click();
    expect(v.send).toHaveBeenCalledWith('re-reads scrollback on every quiet pause');
  });

  it('does nothing when there is no selection to send', () => {
    const v = mount();
    v.setSelection('');
    (v.host.querySelector('.art-send') as HTMLButtonElement).click();
    (v.host.querySelector('.art-todo') as HTMLButtonElement).click();
    expect(v.send).not.toHaveBeenCalled();
    expect(v.addToTodo).not.toHaveBeenCalled();
  });

  it('ships a non-empty fixture artifact set (real discovery is mocked, §24.1)', () => {
    expect(SAMPLE_ARTIFACTS.length).toBeGreaterThan(0);
    expect(SAMPLE_ARTIFACTS.some((a) => a.kind === 'markdown')).toBe(true);
    expect(SAMPLE_ARTIFACTS.some((a) => a.kind === 'code')).toBe(true);
  });
});
