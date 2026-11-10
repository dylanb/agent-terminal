import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { createPressGroup } from '../../src/renderer/src/pressable';

afterEach(() => document.body.replaceChildren());

it('keeps keyboard focus on the pressed control, and its related controls focusable, while its press is answered', async () => {
  const group = createPressGroup();
  const save = document.createElement('button');
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  document.body.append(save, cancel);
  let answer!: () => void;
  group.bind(save, () => new Promise<void>((r) => (answer = r)));
  group.bind(cancel, () => undefined);

  save.focus();
  await userEvent.keyboard('{Enter}');
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  expect({ busy: save.getAttribute('aria-busy'), focused: document.activeElement === save }).toEqual({ busy: 'true', focused: true });

  await userEvent.keyboard('{Tab}');
  expect(document.activeElement).toBe(cancel);
  answer();
});
