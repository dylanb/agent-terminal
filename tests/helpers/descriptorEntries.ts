// Looks up the engine-capabilities descriptor's entry for something the oracle names (#276), so a test takes its
// expected set from the oracle and reads only that entry's explanation strings from the descriptor.

import type { ActedName, EngineCapabilities, KeyCapability, KeyValues, PositionCapability } from '../../src/shared/engineCapabilities';
import type { OpenSet } from './engineCapabilityOracle';

export const positionIdOf = (p: PositionCapability): string => (p.yamlPath === '' ? p.definition : `${p.definition}.${p.yamlPath}`);

export function descriptorPosition(caps: EngineCapabilities, id: string): PositionCapability | undefined {
  return caps.positions.find((p) => positionIdOf(p) === id);
}

export function descriptorKey(caps: EngineCapabilities, id: string, key: string): KeyCapability | undefined {
  return descriptorPosition(caps, id)?.keys.find((k) => k.key === key);
}

export function descriptorActed(caps: EngineCapabilities, id: string, key: string, name: string): ActedName | undefined {
  const values = descriptorKey(caps, id, key)?.values;
  return values?.kind === 'open' ? values.acted.find((a) => a.name === name) : undefined;
}

/** An arg the engine reads beside an acted-on side-effect kind. */
export function descriptorArg(caps: EngineCapabilities, id: string, kind: string, arg: string): KeyCapability | undefined {
  return descriptorActed(caps, id, 'kind', kind)?.args?.find((a) => a.key === arg);
}

/** The values of the descriptor entry an oracle open set is written under: a position's key, or an arg. */
export function descriptorOpenSet(caps: EngineCapabilities, set: OpenSet): KeyValues | undefined {
  return set.argOf === undefined ? descriptorKey(caps, set.position, set.key)?.values : descriptorArg(caps, set.position, set.argOf, set.key)?.values;
}
