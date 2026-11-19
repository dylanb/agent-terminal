// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpInstall } from '../../src/renderer/src/mcpInstall';
import type { McpIntegrationOutcome } from '../../src/renderer/src/mcpInstallAction';
import { assertRendersFromHostDocument } from './relocatable';

const deps = () => ({ install: vi.fn(async (): Promise<McpIntegrationOutcome> => ({ ok: true })), remove: vi.fn(async (): Promise<McpIntegrationOutcome> => ({ ok: true })) });

describe('the Claude Code tools Settings section organism', () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.replaceChildren(host);
  });

  it('is a section led by a top-level heading of its own, holding the install and remove actions (WCAG 1.3.1, 2.4.6)', () => {
    createMcpInstall(host, deps());
    const heading = host.querySelector('h1');
    const section = heading?.closest('.kview');
    const actions = [...host.querySelectorAll('button')].filter((b) => /^(Install|Remove) the agent-terminal tools/.test(b.getAttribute('aria-label') ?? ''));
    expect({ heading: heading !== null, actions: actions.length, allInSection: actions.every((b) => section?.contains(b) === true) }).toEqual({ heading: true, actions: 2, allInSection: true });
  });

  it('builds its DOM from the host document', async () => {
    await assertRendersFromHostDocument((h) => { createMcpInstall(h, deps()); });
  });
});
