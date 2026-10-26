import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { accentLocator, bringForwardLocator, cardHeaderLocator, cardLocator, themeControlLocator, dismissLocator, showFullReasonLocator, statusRowLocator, windowTitleLocator } from '../helpers/controllerCards';
import { cardContractDom } from '../helpers/controllerCardsDom';

afterEach(() => document.body.replaceChildren());

describe('the role-and-name card locators', () => {
  it('locate a card by the directory in its accessible name, not by a directory it merely starts with', () => {
    cardContractDom();
    expect(cardLocator(page, '/w/a').element().querySelector('header [aria-expanded]')?.id).toBe('h-a');
    expect(cardLocator(page, '/w/ab').element().querySelector('header [aria-expanded]')?.id).toBe('h-ab');
    expect(cardLocator(page, '/w').query()).toBeNull();
  });

  it('locate each control and part of a card in either expanded state', () => {
    cardContractDom();
    const live = cardLocator(page, '/w/a');
    const ended = cardLocator(page, '/w/ab');
    expect(bringForwardLocator(live).element().getAttribute('aria-label')).toBe('Bring forward /w/a');
    expect(bringForwardLocator(ended).query()).toBeNull();
    expect(dismissLocator(ended).element().textContent).toBe('Dismiss');
    expect(showFullReasonLocator(live).element().tagName).toBe('BUTTON');
    expect([cardHeaderLocator(live, '/w/a').element().id, cardHeaderLocator(ended, '/w/ab').element().id]).toEqual(['h-a', 'h-ab']);
    expect(statusRowLocator(live).element().textContent).toBe('Working');
    expect(accentLocator(ended).element().closest('article')?.querySelector('header [aria-expanded]')?.id).toBe('h-ab');
    expect(windowTitleLocator(page).element().tagName).toBe('H1');
  });

  it('locate the theme control by the theme it switches to', () => {
    const dom = cardContractDom();
    expect(themeControlLocator(page).element().textContent).toBe('Dark theme');
    expect([themeControlLocator(page, { on: false }).query(), themeControlLocator(page, { on: true }).query()].map(Boolean)).toEqual([true, false]);
    dom.querySelector('header > button')!.textContent = 'Light theme';
    expect(themeControlLocator(page).element().textContent).toBe('Light theme');
    expect([themeControlLocator(page, { on: true }).query(), themeControlLocator(page, { on: false }).query()].map(Boolean)).toEqual([true, false]);
  });
});
