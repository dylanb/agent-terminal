import { describe, expect, it } from 'vitest';
import {
  BENCH_APP_ENDINGS,
  BENCH_LAUNCH_SCHEMA,
  decodeBenchLaunch,
  encodeBenchLaunch,
  parseBenchSpanEnd,
  serializeBenchSpanEnd,
  type BenchLaunch,
} from '../../src/shared/benchLaunch';

// #180 — the launch contract's two values: the launch value the runner hands the app, and the span-end file
// the app hands back.

const LAUNCH: BenchLaunch = {
  schema_version: BENCH_LAUNCH_SCHEMA,
  workingFolder: '/home/op/.agent-terminal/bench/s1/run-1/bench-s1-run-1',
  span: { first: 'red', last: 'refactor' },
  spanEndFile: '/home/op/.agent-terminal/bench/s1/run-1/span-end.json',
};

describe('the launch value', () => {
  it('decodes to what was encoded', () => {
    expect(decodeBenchLaunch(encodeBenchLaunch(LAUNCH))).toEqual({ ok: true, launch: LAUNCH });
  });

  it('refuses a value that is not a launch value', () => {
    const malformed = [
      '',
      '{ not json',
      encodeBenchLaunch({ ...LAUNCH, schema_version: 2 }),
      encodeBenchLaunch({ ...LAUNCH, workingFolder: 'relative/folder' }),
      encodeBenchLaunch({ ...LAUNCH, span: { first: 'red' } } as unknown as BenchLaunch),
      encodeBenchLaunch({ ...LAUNCH, spanEndFile: 7 } as unknown as BenchLaunch),
      encodeBenchLaunch({ ...LAUNCH, spanEndFile: 'span-end.json' }),
      encodeBenchLaunch({ ...LAUNCH, span: { first: ' ', last: 'refactor' } }),
      encodeBenchLaunch({ ...LAUNCH, span: { first: 'red', last: '' } }),
      encodeBenchLaunch({ ...LAUNCH, extra: true } as BenchLaunch),
    ];
    expect(malformed.map((v) => decodeBenchLaunch(v).ok)).toEqual(malformed.map(() => false));
  });
});

describe('the span-end file', () => {
  it('reads back each ending the app writes', () => {
    expect(BENCH_APP_ENDINGS.map((e) => parseBenchSpanEnd(serializeBenchSpanEnd(e)))).toEqual(BENCH_APP_ENDINGS.map((ending) => ({ ok: true, ending })));
  });

  it('refuses anything else, including the ending only the runner records', () => {
    const withEnding = (ending: string): string => serializeBenchSpanEnd('left span').replace('left span', ending);
    const others = ['', '{ not json', withEnding('app exited'), withEnding('Left Span'), serializeBenchSpanEnd('left span').replace('"schema_version":1', '"schema_version":2')];
    expect(others.map((v) => parseBenchSpanEnd(v).ok)).toEqual(others.map(() => false));
  });
});
