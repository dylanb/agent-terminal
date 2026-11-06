export function isOneOf<V extends string | boolean>(values: readonly V[], value: unknown): value is V {
  return (values as readonly unknown[]).includes(value);
}
