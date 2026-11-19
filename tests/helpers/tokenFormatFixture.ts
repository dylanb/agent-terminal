// The rail's abbreviated and the table's exact form of a token count, written by hand from the requirement: the
// rail is exact below 1,000 and otherwise 1 decimal with k, M or B, never "1000.0k"; the table is exact digits with
// en-US thousands separators.

export interface TokenFormatCase {
  n: number;
  rail: string;
  table: string;
}

export const TOKEN_FORMAT_CASES: TokenFormatCase[] = [
  { n: 0, rail: '0', table: '0' },
  { n: 7, rail: '7', table: '7' },
  { n: 999, rail: '999', table: '999' },
  { n: 1_000, rail: '1.0k', table: '1,000' },
  { n: 1_049, rail: '1.0k', table: '1,049' },
  { n: 1_050, rail: '1.1k', table: '1,050' },
  { n: 12_345, rail: '12.3k', table: '12,345' },
  { n: 999_949, rail: '999.9k', table: '999,949' },
  { n: 999_950, rail: '1.0M', table: '999,950' },
  { n: 4_500_000, rail: '4.5M', table: '4,500,000' },
  { n: 4_549_999, rail: '4.5M', table: '4,549,999' },
  { n: 999_950_000, rail: '1.0B', table: '999,950,000' },
  { n: 1_234_567_890, rail: '1.2B', table: '1,234,567,890' },
];
