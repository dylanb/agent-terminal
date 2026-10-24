export type Theme = 'light' | 'dark';
type ThemeValues = { readonly light: string; readonly dark: string };

const EXISTING_TOKENS = {
  '--board': { light: '#FBFCFE', dark: '#FBFCFE' },
  '--leaf': { light: '#FFFFFF', dark: '#FFFFFF' },
  '--rule': { light: '#E3E9F0', dark: '#E3E9F0' },
  '--rule-soft': { light: '#EEF2F7', dark: '#EEF2F7' },
  '--ink': { light: '#11161D', dark: '#11161D' },
  '--muted': { light: '#5E6B7A', dark: '#5E6B7A' },
  '--signal': { light: '#0098DB', dark: '#22C7FF' },
  '--signal-wash': { light: 'rgba(0,152,219,.12)', dark: 'rgba(34,199,255,.14)' },
  '--attn': { light: '#E5484D', dark: '#FF6168' },
  '--pass': { light: '#1F9D6B', dark: '#3DDC97' },
  '--danger': { light: '#B11F26', dark: '#FF8A8E' },
  '--danger-on': { light: '#FFFFFF', dark: '#0E141B' },
  '--signal-text': { light: '#006699', dark: '#22C7FF' },
  '--pass-text': { light: '#157F54', dark: '#3DDC97' },
  '--attn-text': { light: '#C02A2F', dark: '#FF6168' },
  '--bg': { light: '#FBFCFE', dark: '#0E141B' },
  '--card': { light: '#FFFFFF', dark: '#161E27' },
  '--hair': { light: '#E3E9F0', dark: '#26313C' },
  '--hair2': { light: '#EEF2F7', dark: '#1C2530' },
  '--text': { light: '#11161D', dark: '#E8EEF4' },
  '--dim': { light: '#5E6B7A', dark: '#8FA0B2' },
  '--term-bg': { light: '#0E141B', dark: '#0A0F15' },
  '--term-text': { light: '#D5DEE8', dark: '#D5DEE8' },
  '--term-dim': { light: '#6F7E8E', dark: '#65727F' },
  '--reveal': { light: '#F2A53C', dark: '#FFB454' },
  '--reveal-wash': { light: 'rgba(242,165,60,.22)', dark: 'rgba(255,180,84,.20)' },
  '--changed': { light: '#0098DB', dark: '#22C7FF' },
  '--changed-wash': { light: 'rgba(0,152,219,.12)', dark: 'rgba(34,199,255,.14)' },
  '--syn-keyword': { light: '#B3202B', dark: '#FF7B72' },
  '--syn-string': { light: '#0A3069', dark: '#A5D6FF' },
  '--syn-comment': { light: '#59636E', dark: '#9AA6B2' },
  '--syn-number': { light: '#0550AE', dark: '#79C0FF' },
  '--syn-func': { light: '#6639BA', dark: '#D2A8FF' },
  '--syn-type': { light: '#116329', dark: '#7EE787' },
  '--syn-var': { light: '#953800', dark: '#FFA657' },
  '--syn-punct': { light: '#24292F', dark: '#C9D1D9' },
} as const satisfies Record<`--${string}`, ThemeValues>;

export type ExistingToken = keyof typeof EXISTING_TOKENS;

export const STATUSES = ['error', 'needs-human', 'working', 'completed', 'idle'] as const;
export type Status = (typeof STATUSES)[number];
export type StatusToken =
  | `--status-${Status}`
  | `--status-${Status}-text`
  | `--status-${Status}-tint`
  | '--status-error-border'
  | '--status-needs-human-border';

type StatusTokenSpec =
  | { readonly alias: ExistingToken; readonly light?: never; readonly dark?: never }
  | (ThemeValues & { readonly alias?: never });

const STATUS_TOKENS: Readonly<Record<StatusToken, StatusTokenSpec>> = {
  '--status-error': { alias: '--attn' },
  '--status-error-text': { alias: '--danger' },
  '--status-error-tint': { light: 'rgba(229,72,77,.08)', dark: 'rgba(255,97,104,.11)' },
  '--status-error-border': { light: 'rgba(229,72,77,.45)', dark: 'rgba(255,97,104,.45)' },
  '--status-needs-human': { light: '#C97F14', dark: '#FFB454' },
  '--status-needs-human-text': { light: '#8A5300', dark: '#FFB454' },
  '--status-needs-human-tint': { light: 'rgba(242,165,60,.15)', dark: 'rgba(255,180,84,.12)' },
  '--status-needs-human-border': { light: 'rgba(214,135,30,.50)', dark: 'rgba(255,180,84,.45)' },
  '--status-working': { alias: '--signal' },
  '--status-working-text': { alias: '--signal-text' },
  '--status-working-tint': { light: 'rgba(0,152,219,.10)', dark: 'rgba(34,199,255,.12)' },
  '--status-completed': { alias: '--pass' },
  '--status-completed-text': { alias: '--pass-text' },
  '--status-completed-tint': { light: 'rgba(31,157,107,.08)', dark: 'rgba(61,220,151,.10)' },
  '--status-idle': { alias: '--dim' },
  '--status-idle-text': { alias: '--dim' },
  '--status-idle-tint': { alias: '--hair2' },
};

const LENGTH_TOKENS = {
  '--focus-ring-w': '2px',
  '--focus-ring-offset': '2px',
  '--focus-ring-extent': '4px',
  '--r': '7px',
} as const satisfies Record<`--${string}`, string>;

export type DesignToken = ExistingToken | StatusToken;
export type LengthToken = keyof typeof LENGTH_TOKENS;

export const EXISTING_TOKEN_NAMES = Object.keys(EXISTING_TOKENS) as readonly ExistingToken[];
export const STATUS_TOKEN_NAMES = Object.keys(STATUS_TOKENS) as readonly StatusToken[];
export const LENGTH_TOKEN_NAMES = Object.keys(LENGTH_TOKENS) as readonly LengthToken[];

export function aliasOf(name: StatusToken): ExistingToken | null {
  return STATUS_TOKENS[name].alias ?? null;
}

export function expectedColor(name: DesignToken, theme: Theme): string {
  const spec: StatusTokenSpec =
    name in STATUS_TOKENS ? STATUS_TOKENS[name as StatusToken] : EXISTING_TOKENS[name as ExistingToken];
  return spec.alias === undefined ? spec[theme] : EXISTING_TOKENS[spec.alias][theme];
}

export function expectedLength(name: LengthToken): string {
  return LENGTH_TOKENS[name];
}
