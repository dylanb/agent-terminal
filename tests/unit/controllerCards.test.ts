// @vitest-environment jsdom
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import type { Locator, Page } from '@playwright/test';
import { type RoleScope, accentIn, bringForwardIn, cardHeaderIn, cardIn, cardsIn, darkThemeIn, dismissIn, darkThemeOn, isExpanded, showFullReasonIn, statusRowIn, windowHeaderIn } from '../helpers/controllerCards';
import { cardContractDom } from '../helpers/controllerCardsDom';

afterEach(() => document.body.replaceChildren());

describe('the jsdom card queries', () => {
  it('find the one card holding a directory, not a card whose directory merely starts with it', () => {
    const host = cardContractDom();
    expect(cardsIn(host)).toHaveLength(2);
    expect(cardIn(host, '/w/a')?.querySelector('header [aria-expanded]')?.id).toBe('h-a');
    expect(cardIn(host, '/w/ab')?.querySelector('header [aria-expanded]')?.id).toBe('h-ab');
    expect(cardIn(host, '/w')).toBeUndefined();
  });

  it('refuse a directory two cards hold', () => {
    const host = cardContractDom();
    host.append(cardIn(host, '/w/a')!.cloneNode(true));
    expect(() => cardIn(host, '/w/a')).toThrow(/2 cards/);
  });

  it('find the window header, not a card header', () => {
    expect(windowHeaderIn(cardContractDom())?.textContent).toContain('Controller');
  });

  it('find each control and part of a card', () => {
    const host = cardContractDom();
    const live = cardIn(host, '/w/a')!;
    const ended = cardIn(host, '/w/ab')!;
    expect(bringForwardIn(live)?.getAttribute('aria-label')).toBe('Bring forward /w/a');
    expect(bringForwardIn(ended)).toBeUndefined();
    expect(dismissIn(ended)?.getAttribute('aria-label')).toBe('Dismiss disconnected terminal /w/ab');
    expect(showFullReasonIn(live)?.tagName).toBe('BUTTON');
    expect(cardHeaderIn(live, '/w/a')?.id).toBe('h-a');
    expect([isExpanded(live, '/w/a'), isExpanded(ended, '/w/ab')]).toEqual([true, false]);
    expect(statusRowIn(ended)?.textContent).toBe('Disconnected');
    expect(accentIn(live)?.closest('article')).toBe(live);
    expect(darkThemeIn(host)?.getAttribute('aria-pressed')).toBe('false');
  });

  it('refuse to report the state of a control that is not there', () => {
    const host = cardContractDom();
    darkThemeIn(host)!.remove();
    expect(() => darkThemeOn(host)).toThrow(/Dark theme/);
    expect(() => isExpanded(cardIn(host, '/w/a')!, '/w/ab')).toThrow(/\/w\/ab/);
  });

  it('report the Dark theme state as a toggle button or as a switch', () => {
    const host = cardContractDom();
    const control = darkThemeIn(host)!;
    expect(darkThemeOn(host)).toBe(false);
    control.setAttribute('aria-pressed', 'true');
    expect(darkThemeOn(host)).toBe(true);
    control.removeAttribute('aria-pressed');
    control.setAttribute('role', 'switch');
    control.setAttribute('aria-checked', 'false');
    expect(darkThemeOn(host)).toBe(false);
    control.setAttribute('aria-checked', 'true');
    expect(darkThemeOn(host)).toBe(true);
  });
});

it('the role-and-name locators accept a Playwright page and locator', () => {
  expectTypeOf<Page>().toExtend<RoleScope<Locator>>();
  expectTypeOf<Locator>().toExtend<RoleScope<Locator>>();
});

it('finds conflict actions and labelled ARIA disclosure controls through their accessible names', () => {
  const host = cardContractDom();
  const card = cardIn(host, '/w/a')!;
  const action = bringForwardIn(card)!;
  action.setAttribute('aria-label', 'Bring both forward project /w/a');
  expect(bringForwardIn(card)).toBe(action);
  action.setAttribute('aria-label', 'Bring 3 terminals forward project /w/a');
  expect(bringForwardIn(card)).toBe(action);
});

it('finds an ARIA disclosure named by a referenced label', () => {
  const host = cardContractDom();
  const card = cardIn(host, '/w/a')!;
  const header = cardHeaderIn(card, '/w/a')!;
  const replacement = document.createElement('div');
  replacement.setAttribute('role', 'button');
  replacement.setAttribute('aria-expanded', 'true');
  replacement.setAttribute('aria-labelledby', 'directory-label');
  const label = document.createElement('span');
  label.id = 'directory-label';
  label.textContent = '/w/a';
  host.append(label);
  header.replaceWith(replacement);
  expect(cardHeaderIn(card, '/w/a')).toBe(replacement);
});
