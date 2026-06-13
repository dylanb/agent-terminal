// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { MONITOR_ELEMENT_IDS, requireElement, resolveElements, resolveMonitorElements } from '../../src/renderer/src/dom';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('renderer DOM contract (typed required-element handles)', () => {
  it('requireElement returns the element when present', () => {
    document.body.innerHTML = `<div id="thing"></div>`;
    expect(requireElement('thing')).toBe(document.getElementById('thing'));
  });

  it('requireElement throws an error naming the id when absent', () => {
    expect(() => requireElement('missing-thing')).toThrowError(/missing-thing/);
  });

  it('resolveElements maps a record of ids to a typed record of handles', () => {
    document.body.innerHTML = `<div id="a"></div><span id="b"></span>`;
    const handles = resolveElements({ alpha: 'a', beta: 'b' });
    expect(handles.alpha).toBe(document.getElementById('a'));
    expect(handles.beta).toBe(document.getElementById('b'));
  });

  it('resolveElements throws naming the missing id (single DOM contract, fail-loud)', () => {
    document.body.innerHTML = `<div id="a"></div>`;
    expect(() => resolveElements({ alpha: 'a', beta: 'b' })).toThrowError(/b/);
  });

  it('resolveMonitorElements resolves every monitor-pane id declared in MONITOR_ELEMENT_IDS', () => {
    document.body.innerHTML = Object.values(MONITOR_ELEMENT_IDS)
      .map((id) => `<div id="${id}"></div>`)
      .join('');
    const el = resolveMonitorElements();
    for (const key of Object.keys(MONITOR_ELEMENT_IDS) as (keyof typeof MONITOR_ELEMENT_IDS)[]) {
      expect(el[key]).toBe(document.getElementById(MONITOR_ELEMENT_IDS[key]));
    }
  });
});
