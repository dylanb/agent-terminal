export type TokenCountValue =
  | { shown: 'dash' }
  | { shown: 'count'; text: string; counting: boolean; partly?: boolean; incomplete?: boolean }
  | { shown: 'not reported'; counting: boolean; incomplete?: boolean }
  | { shown: 'unavailable'; counting: boolean };

export interface TokenCount {
  set(value: TokenCountValue): void;
  dispose(): void;
}

const TOKEN_COUNT_TEST_ID = 'token-count';

export function createTokenCount(host: HTMLElement): TokenCount {
  const doc = host.ownerDocument;
  const el = doc.createElement('span');
  el.className = 'tok';
  el.dataset.testid = TOKEN_COUNT_TEST_ID;
  // WCAG 4.1.3
  el.setAttribute('aria-live', 'off');
  host.append(el);
  const part = (className: string, text: string): HTMLSpanElement => {
    const span = doc.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
  };
  return {
    set(value) {
      if (value.shown === 'dash') {
        el.replaceChildren('—');
        return;
      }
      const marks = [
        ...(value.shown === 'count' && value.partly === true ? ['partly reported'] : []),
        ...(value.shown !== 'unavailable' && value.incomplete === true ? ['incomplete'] : []),
        ...(value.counting ? ['counting'] : []),
      ];
      el.replaceChildren(value.shown === 'count' ? part('tok-n', value.text) : part('tok-mark', value.shown));
      for (const mark of marks) el.append(' ', part('tok-mark', mark));
    },
    dispose() {
      el.remove();
    },
  };
}
