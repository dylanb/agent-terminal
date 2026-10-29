import { expect } from 'vitest';

type Role = 'button' | 'checkbox' | 'textbox';

const SELECTOR: Record<Role, string> = {
  button: 'button:not([role]), [role="button"]',
  checkbox: 'input[type="checkbox"]:not([role]), [role="checkbox"]',
  textbox: 'textarea:not([role]), input:not([type]):not([role]), input[type="text"]:not([role]), [role="textbox"]',
};

function visibleText(node: Node): string {
  if (node.nodeType === node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return '';
  return [...node.childNodes].map(visibleText).join('');
}

export function accessibleName(el: Element): string {
  const label = el.getAttribute('aria-label');
  if (label !== null) return label.trim();
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
  }
  return visibleText(el).replace(/\s+/g, ' ').trim();
}

/** All elements with `role` whose accessible name is `name`, in document order. */
export function allByRole(host: ParentNode, role: Role, name: string): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(SELECTOR[role])].filter((el) => accessibleName(el) === name);
}

/** The one element with `role` whose accessible name is `name`; fails when there is not exactly one. */
export function byRole(host: ParentNode, role: Role, name: string): HTMLElement {
  const found = allByRole(host, role, name);
  expect(found, `exactly one ${role} named "${name}"`).toHaveLength(1);
  return found[0];
}
