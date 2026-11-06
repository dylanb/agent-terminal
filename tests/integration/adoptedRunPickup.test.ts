import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustedPickups } from '../../src/main/trustedPickups';
import { adoptedFixBranch, type AdoptedPickup } from '../../src/shared/appBootstrap';
import type { RunIdentity } from '../../src/main/gateRunState';

// #304 — the pickup an adopting run completed is kept under that run's identity across a relaunch, and only a pickup
// adopted at that run's own Start is.

const RUN: RunIdentity = { flow: 'adopt-pr-fixture', startedAt: 1_700_000_000_000 };
const adopted = (startedAt: number): AdoptedPickup => ({
  kind: 'adopted',
  pr: 41,
  fixBranch: adoptedFixBranch(41, startedAt),
  startedAt,
  headRef: 'feature/reviewed-change',
  baseRef: 'main',
  headRepo: 'owner/repo',
  crossRepository: false,
  tickets: [{ repo: 'owner/repo', number: 176 }],
  primary: { repo: 'owner/repo', number: 176 },
  headOid: 'a'.repeat(40),
  baseOid: 'b'.repeat(40),
});

let repo: string;
let failures: string[];
const relaunch = () =>
  createTrustedPickups({ currentRun: () => RUN, persistFailed: (_repo, reason) => failures.push(reason), forgetFailed: () => {} });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'adopted-run-pickup-'));
  failures = [];
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("an adopting run's saved pickup", () => {
  it('is trusted by a relaunched app while the same run is in progress', () => {
    relaunch().set(repo, adopted(RUN.startedAt));
    expect(relaunch().get(repo)).toEqual(adopted(RUN.startedAt));
    expect(failures).toEqual([]);
  });

  it("is reported and never saved when it was adopted at another run's Start", () => {
    relaunch().set(repo, adopted(RUN.startedAt + 1));
    expect(failures).toHaveLength(1);
    expect(relaunch().get(repo)).toBeUndefined();
  });
});
