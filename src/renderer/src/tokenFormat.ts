const UNITS: { size: number; suffix: string }[] = [
  { size: 1e3, suffix: 'k' },
  { size: 1e6, suffix: 'M' },
  { size: 1e9, suffix: 'B' },
];

export function abbreviatedTokens(n: number): string {
  if (n < UNITS[0].size) return String(n);
  for (const [i, unit] of UNITS.entries()) {
    const tenths = Math.round(n / (unit.size / 10));
    if (tenths < 10_000 || i === UNITS.length - 1) return `${(tenths / 10).toFixed(1)}${unit.suffix}`;
  }
  return String(n);
}

export function exactTokens(n: number): string {
  return n.toLocaleString('en-US');
}
