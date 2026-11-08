import { afterEach, beforeEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { ControllerTerminal } from '../../src/shared/ipc';
import { bodyDirectoryIn, bringForwardIn, cardHeaderIn, cardIn } from '../helpers/controllerCards';
import { orderDirectory as d, orderTerminal as t } from '../helpers/controllerCardOrderFixture';
import { mountControllerPanes } from '../helpers/controllerMount';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';

const viewport = { width: window.innerWidth, height: window.innerHeight };
beforeEach(() => page.viewport(1280, 1400));
afterEach(async () => {
  document.body.replaceChildren();
  await page.viewport(viewport.width, viewport.height);
});

const settled = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const TERMINALS = [t('a', 'idle'), t('w', 'working'), t('e', 'flow-error')];
const UPDATED: ControllerTerminal[] = [t('a', 'idle'), t('w', 'needs-human'), t('e', 'flow-error')];

function mount() {
  const parent = document.body.appendChild(document.createElement('section'));
  parent.style.width = '900px';
  return mountControllerPanes({ terminals: TERMINALS, parent });
}
function card(host: HTMLElement, name: string): HTMLElement {
  const found = cardIn(host, d(name));
  if (!found) throw new Error(`no card for ${d(name)}`);
  return found;
}

it('brings the terminal forward when a status update arrives between pressing and releasing Space on Bring forward', async () => {
  const { host, service, dispose } = mount();
  try {
    bringForwardIn(card(host, 'a'))?.focus();
    await userEvent.keyboard('[Space>]');
    service.publish(UPDATED);
    await settled();
    await userEvent.keyboard('[/Space]');
    await settled();
    expect(service.activated).toEqual(['order-a']);
  } finally { dispose(); }
});

it('keeps the text the operator selected in a card selected when a status update arrives', async () => {
  const { host, service, dispose } = mount();
  try {
    const name = bodyDirectoryIn(card(host, 'a'), d('a'));
    if (!name) throw new Error('no launch directory text');
    getSelection()?.selectAllChildren(name);
    const before = getSelection()?.toString();
    service.publish(UPDATED);
    await settled();
    expect({ before, after: getSelection()?.toString() }).toEqual({ before: d('a'), after: d('a') });
  } finally { dispose(); }
});

it('keeps focus on the very control the operator focused, with no blur, when a status update arrives', async () => {
  const { host, service, dispose } = mount();
  try {
    const header = cardHeaderIn(card(host, 'e'), d('e'));
    header?.focus();
    let blurs = 0;
    host.addEventListener('focusout', () => { blurs += 1; });
    service.publish(UPDATED);
    await settled();
    expect({ sameControl: document.activeElement === header, blurs }).toEqual({ sameControl: true, blurs: 0 });
  } finally { dispose(); }
});
