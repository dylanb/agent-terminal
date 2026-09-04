import { describe, expect, it, vi } from 'vitest';
import { runSubTicketPickup, type SubTicketPickupDeps } from '../../src/main/subTicketPickup';
import { composeSubTicketBody, EPIC_SUBTICKET_LABEL } from '../../src/shared/epicSubTicket';

// §27.10/§28.7 N10 — a picked-up epic sub-ticket reconstructs its groomed ticket from the body and SKIPS groom,
// while a normal pickup is untouched. This pins the orchestration outcomes at the observable seam (which domain
// action fired), never the internals.
function deps(over: Partial<SubTicketPickupDeps> = {}): SubTicketPickupDeps & {
  readIssue: ReturnType<typeof vi.fn>;
  isCurrent: ReturnType<typeof vi.fn>;
  writeGroomedTicket: ReturnType<typeof vi.fn>;
  advancePastGroom: ReturnType<typeof vi.fn>;
  surfaceError: ReturnType<typeof vi.fn>;
} {
  return {
    readIssue: vi.fn(async () => ({ body: '', labels: [] as string[] })),
    isCurrent: vi.fn(() => true),
    writeGroomedTicket: vi.fn(),
    advancePastGroom: vi.fn(),
    surfaceError: vi.fn(),
    ...over,
  } as never;
}

const subTicketBody = (slice: string): string => composeSubTicketBody(slice, { epic: 176, preceding: 501 });

describe('§27.10/§28.7 runSubTicketPickup', () => {
  it('a non-sub-ticket issue is left to the normal groom path — no materialize, no skip, no error', async () => {
    const d = deps({ readIssue: vi.fn(async () => ({ body: 'plain issue', labels: ['bug'] })) });
    const outcome = await runSubTicketPickup(d, 42);
    expect(outcome.kind).toBe('not-subticket');
    expect(d.writeGroomedTicket).not.toHaveBeenCalled();
    expect(d.advancePastGroom).not.toHaveBeenCalled();
    expect(d.surfaceError).not.toHaveBeenCalled();
  });

  it('an unreadable issue falls through to the normal path rather than blocking the pickup', async () => {
    const d = deps({ readIssue: vi.fn(async () => null) });
    const outcome = await runSubTicketPickup(d, 42);
    expect(outcome.kind).toBe('not-subticket');
    expect(d.advancePastGroom).not.toHaveBeenCalled();
  });

  it('a well-formed sub-ticket materializes the groomed ticket and skips groom', async () => {
    const slice = '### Ticket\n\nAcceptance criteria: it works\n\nPlan: build the slice.';
    const d = deps({ readIssue: vi.fn(async () => ({ body: subTicketBody(slice), labels: [EPIC_SUBTICKET_LABEL, 'agent-loop/ready'] })) });
    const outcome = await runSubTicketPickup(d, 501);
    expect(outcome.kind).toBe('skipped');
    expect(d.writeGroomedTicket).toHaveBeenCalledWith(slice);
    expect(d.advancePastGroom).toHaveBeenCalledTimes(1);
    expect(d.surfaceError).not.toHaveBeenCalled();
  });

  it('a sub-ticket whose body is malformed creates nothing and surfaces why (does not advance)', async () => {
    const d = deps({ readIssue: vi.fn(async () => ({ body: 'a subticket labelled body with no machine footer', labels: [EPIC_SUBTICKET_LABEL] })) });
    const outcome = await runSubTicketPickup(d, 501);
    expect(outcome.kind).toBe('malformed');
    expect(d.writeGroomedTicket).not.toHaveBeenCalled();
    expect(d.advancePastGroom).not.toHaveBeenCalled();
    expect(d.surfaceError).toHaveBeenCalledTimes(1);
    expect(d.surfaceError.mock.calls[0][0]).toMatch(/machine footer|groomed/i);
  });

  it('a raced pickup (the flow moved on during the read) neither materializes nor advances', async () => {
    const slice = '### Ticket\n\nAcceptance criteria: it works\n\nPlan: build the slice.';
    const d = deps({
      readIssue: vi.fn(async () => ({ body: subTicketBody(slice), labels: [EPIC_SUBTICKET_LABEL] })),
      isCurrent: vi.fn(() => false),
    });
    const outcome = await runSubTicketPickup(d, 501);
    expect(outcome.kind).toBe('stale');
    expect(d.writeGroomedTicket).not.toHaveBeenCalled();
    expect(d.advancePastGroom).not.toHaveBeenCalled();
    expect(d.surfaceError).not.toHaveBeenCalled();
  });

  it('a raced pickup whose body is ALSO malformed stays silent — no spurious dialog for a flow that moved on', async () => {
    const d = deps({
      readIssue: vi.fn(async () => ({ body: 'a labelled body with no machine footer', labels: [EPIC_SUBTICKET_LABEL] })),
      isCurrent: vi.fn(() => false),
    });
    const outcome = await runSubTicketPickup(d, 501);
    expect(outcome.kind).toBe('stale');
    expect(d.surfaceError).not.toHaveBeenCalled();
    expect(d.writeGroomedTicket).not.toHaveBeenCalled();
    expect(d.advancePastGroom).not.toHaveBeenCalled();
  });

  it('a write failure surfaces why and does not advance (fail-visible, not a silent stuck flow)', async () => {
    const slice = '### Ticket\n\nAcceptance criteria: it works\n\nPlan: build the slice.';
    const d = deps({
      readIssue: vi.fn(async () => ({ body: subTicketBody(slice), labels: [EPIC_SUBTICKET_LABEL] })),
      writeGroomedTicket: vi.fn(() => {
        throw new Error('ENOSPC: no space left on device');
      }),
    });
    const outcome = await runSubTicketPickup(d, 501);
    expect(outcome.kind).toBe('materialize-failed');
    expect(d.advancePastGroom).not.toHaveBeenCalled();
    expect(d.surfaceError).toHaveBeenCalledTimes(1);
    expect(d.surfaceError.mock.calls[0][0]).toMatch(/ENOSPC|materiali/i);
  });
});
