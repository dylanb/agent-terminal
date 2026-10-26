export interface ClampedReasonDeps {
  text: string;
  full: boolean;
  onToggle(full: boolean): void;
}

export interface ClampedReason {
  control(): HTMLElement | undefined;
  dispose(): void;
}

const REASON_LINE_LIMIT = 3;

export function createClampedReason(host: HTMLElement, deps: ClampedReasonDeps): ClampedReason {
  const doc = host.ownerDocument;
  let full = deps.full;
  const root = doc.createElement('div');
  root.className = 'controller-reason';
  root.style.setProperty('--reason-lines', String(REASON_LINE_LIMIT));
  const text = doc.createElement('p');
  text.className = 'controller-reason-text';
  text.textContent = deps.text;
  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.textContent = 'Show full reason';
  toggle.addEventListener('click', () => {
    full = !full;
    deps.onToggle(full);
    render();
  });
  root.append(text);
  host.append(root);

  function cutShort(): boolean {
    const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
    return text.scrollHeight > lineHeight * REASON_LINE_LIMIT + 1;
  }
  function render(): void {
    text.classList.toggle('is-clamped', !full);
    toggle.setAttribute('aria-expanded', String(full));
    if (!cutShort()) toggle.remove();
    else if (!toggle.isConnected) root.append(toggle);
  }

  render();
  const View = doc.defaultView?.ResizeObserver;
  const observer = View ? new View(render) : undefined;
  observer?.observe(text);
  return {
    control: () => (toggle.isConnected ? toggle : undefined),
    dispose() {
      observer?.disconnect();
      root.remove();
    },
  };
}
