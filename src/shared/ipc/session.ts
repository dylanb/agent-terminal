export type SessionId = string;

/** The single fixed session id in this version (§6). */
export const SESSION_ID: SessionId = 's1';

export interface ChannelSpec {
  readonly name: string;
  readonly does: string;
}

export type ChannelSpecs = Readonly<Record<string, ChannelSpec>>;

export type ChannelNames<T extends ChannelSpecs> = { readonly [K in keyof T]: T[K]['name'] };

export function channelNames<T extends ChannelSpecs>(specs: T): ChannelNames<T> {
  return Object.fromEntries(Object.entries(specs).map(([key, spec]) => [key, spec.name])) as ChannelNames<T>;
}
