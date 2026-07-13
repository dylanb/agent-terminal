// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { MONITOR_ELEMENT_IDS, captureFocusReturn, captureSubtreeFocus, requireElement, resolveElements, resolveMonitorElements } from '../../src/renderer/src/dom';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('captureFocusReturn — return focus after an async action that may disable the control (WCAG 2.4.3)', () => {
  const btn = (): HTMLButtonElement => document.getElementById('b') as HTMLButtonElement;

  it('returns focus to the control when it held focus and was blurred to <body> (disable side effect)', () => {
    document.body.innerHTML = `<button id="b"></button>`;
    btn().focus();
    const returnFocus = captureFocusReturn(btn());
    btn().blur(); // disabling a focused control blurs it to <body>
    expect(document.activeElement).toBe(document.body);
    returnFocus();
    expect(document.activeElement).toBe(btn());
  });

  it('does not steal focus the user moved elsewhere during the async action', () => {
    document.body.innerHTML = `<button id="b"></button><input id="other" />`;
    btn().focus();
    const returnFocus = captureFocusReturn(btn());
    (document.getElementById('other') as HTMLElement).focus();
    returnFocus();
    expect(document.activeElement).toBe(document.getElementById('other'));
  });

  it('is a no-op when the control did not hold focus at capture time', () => {
    document.body.innerHTML = `<button id="b"></button><input id="other" />`;
    (document.getElementById('other') as HTMLElement).focus();
    const returnFocus = captureFocusReturn(btn());
    returnFocus();
    expect(document.activeElement).toBe(document.getElementById('other'));
  });
});

describe('captureSubtreeFocus — preserve focus across a subtree rebuild (WCAG 2.4.3)', () => {
  it('lands focus on the freshly-built target when focus was inside the container', () => {
    document.body.innerHTML = `<div id="box"><button id="old">old</button></div>`;
    const box = document.getElementById('box') as HTMLElement;
    (document.getElementById('old') as HTMLElement).focus();
    const restore = captureSubtreeFocus(box);
    box.replaceChildren(); // rebuild removes the focused child → focus falls to <body>
    const fresh = document.createElement('button');
    fresh.id = 'new';
    box.append(fresh);
    expect(document.activeElement).toBe(document.body);
    restore(() => document.getElementById('new')); // resolver runs at restore time, over the new node
    expect(document.activeElement).toBe(fresh);
  });

  it('is a no-op when focus was not inside the container at capture', () => {
    document.body.innerHTML = `<div id="box"><button id="old"></button></div><input id="other" />`;
    (document.getElementById('other') as HTMLElement).focus();
    const box = document.getElementById('box') as HTMLElement;
    const restore = captureSubtreeFocus(box);
    box.replaceChildren(document.createElement('button'));
    restore(() => box.querySelector('button'));
    expect(document.activeElement).toBe(document.getElementById('other'));
  });

  it('does not steal focus the user moved elsewhere before the restore fires', () => {
    document.body.innerHTML = `<div id="box"><button id="old"></button></div><input id="other" />`;
    const box = document.getElementById('box') as HTMLElement;
    (document.getElementById('old') as HTMLElement).focus();
    const restore = captureSubtreeFocus(box);
    (document.getElementById('other') as HTMLElement).focus(); // user redirected during the async gap
    restore(() => box.querySelector('button'));
    expect(document.activeElement).toBe(document.getElementById('other'));
  });

  it('does nothing when the resolver yields no element', () => {
    document.body.innerHTML = `<div id="box"><button id="old"></button></div>`;
    const box = document.getElementById('box') as HTMLElement;
    (document.getElementById('old') as HTMLElement).focus();
    const restore = captureSubtreeFocus(box);
    box.replaceChildren();
    expect(() => restore(() => null)).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });
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
