import { expect, vi } from 'vitest';

// Discriminating relocation check (UI-STANDARDS §3.3 / §2.2 rule 1): an organism must build its DOM
// from the host's `ownerDocument`, never the ambient global `document`. Asserting `ownerDocument`
// after render does NOT discriminate — jsdom auto-adopts an appended node into the parent's document,
// masking a global reach. So this mounts on a FOREIGN-document host with global createElement(NS)
// starved: a reaching organism renders nothing or throws. See memory
// jsdom-adoption-masks-global-document.
export async function assertRendersFromHostDocument(
  mount: (host: HTMLElement) => void | Promise<void>,
): Promise<void> {
  const foreign = document.implementation.createHTMLDocument();
  const host = foreign.body.appendChild(foreign.createElement('div'));
  const reach = (api: string) => () => {
    throw new Error(`organism reached for the global document.${api} instead of host.ownerDocument`);
  };
  const ce = vi.spyOn(document, 'createElement').mockImplementation(reach('createElement'));
  const cens = vi.spyOn(document, 'createElementNS').mockImplementation(reach('createElementNS'));
  try {
    await mount(host);
    expect(host.childElementCount).toBeGreaterThan(0);
  } finally {
    ce.mockRestore();
    cens.mockRestore();
  }
}
