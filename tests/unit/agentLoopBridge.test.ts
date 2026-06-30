import { describe, expect, it } from 'vitest';
import { isStateFileEvent, loopSignature, type AgentLoopState } from '../../src/main/agentLoopBridge';

// §24.2.3 T2 — fs.watch reports `filename` as `string | Buffer | null` (a Buffer on some
// platforms/encodings), so a naive `filename === 'state.yaml'` silently misses a real edit.
describe('isStateFileEvent (§24.2.3 T2)', () => {
  it('treats a Buffer "state.yaml" as a state-file event (the platform-Buffer bug)', () => {
    expect(isStateFileEvent(Buffer.from('state.yaml'))).toBe(true);
  });

  it('treats a string "state.yaml" as a state-file event', () => {
    expect(isStateFileEvent('state.yaml')).toBe(true);
  });

  it('treats a null filename (platforms that omit it) as a state-file event', () => {
    expect(isStateFileEvent(null)).toBe(true);
  });

  it('ignores an unrelated string filename', () => {
    expect(isStateFileEvent('other.yaml')).toBe(false);
  });

  it('ignores an unrelated Buffer filename', () => {
    expect(isStateFileEvent(Buffer.from('other.yaml'))).toBe(false);
  });
});

// The identity of an attached agent-loop: a flow dismisses a loop's refs/mirror on terminate/restart
// by snapshotting its signature, and reveals them again only once the signature differs (a NEW loop).
describe('loopSignature', () => {
  const base: AgentLoopState = { status: 'planning', iteration: 1, pr: 179, branch: 'b', linkedIssues: [25] };

  it('is identical for two value-equal states', () => {
    expect(loopSignature({ ...base })).toBe(loopSignature({ ...base }));
  });

  it('differs when any mirrored field changes', () => {
    const sig = loopSignature(base);
    expect(loopSignature({ ...base, status: 'building' })).not.toBe(sig);
    expect(loopSignature({ ...base, iteration: 2 })).not.toBe(sig);
    expect(loopSignature({ ...base, pr: 200 })).not.toBe(sig);
    expect(loopSignature({ ...base, branch: 'c' })).not.toBe(sig);
    expect(loopSignature({ ...base, linkedIssues: [26] })).not.toBe(sig);
  });

  it('returns "" for a null state (no loop attached) and that differs from any real loop', () => {
    expect(loopSignature(null)).toBe('');
    expect(loopSignature(base)).not.toBe('');
  });
});
