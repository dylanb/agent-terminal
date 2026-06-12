import { describe, expect, it } from 'vitest';
import { createOutputGate } from '../../src/main/outputGate';

describe('createOutputGate (§4 Flow A / §8.1 — no renderer output dropped before load)', () => {
  it('buffers output emitted before the gate opens', () => {
    const out: string[] = [];
    const gate = createOutputGate((d) => out.push(d));
    gate.send('a');
    gate.send('b');
    expect(out).toEqual([]);
  });

  it('flushes buffered output in order when opened', () => {
    const out: string[] = [];
    const gate = createOutputGate((d) => out.push(d));
    gate.send('a');
    gate.send('b');
    gate.open();
    expect(out).toEqual(['a', 'b']);
  });

  it('passes output through immediately once open', () => {
    const out: string[] = [];
    const gate = createOutputGate((d) => out.push(d));
    gate.open();
    gate.send('a');
    gate.send('b');
    expect(out).toEqual(['a', 'b']);
  });

  it('flushes only once even if opened again', () => {
    const out: string[] = [];
    const gate = createOutputGate((d) => out.push(d));
    gate.send('a');
    gate.open();
    gate.open();
    expect(out).toEqual(['a']);
  });
});
