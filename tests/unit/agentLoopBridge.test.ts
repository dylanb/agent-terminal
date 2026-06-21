import { describe, expect, it } from 'vitest';
import { isStateFileEvent } from '../../src/main/agentLoopBridge';

// §24.2.3 T2 — fs.watch reports `filename` as `string | Buffer | null` (a Buffer on some
// platforms/encodings). A naive `filename === 'state.yaml'` is false for a Buffer, so a real
// state.yaml edit would silently NOT fire onChange. This pinning test asserts the predicate
// normalizes a Buffer name so the watcher fires regardless of platform encoding.
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
