/** A run's identity: its flow's name and its Start instant in epoch ms (§27.9.1). */
export interface RunIdentity {
  flow: string;
  startedAt: number;
}

export const RUN_IDENTITY_KEYS = ['flow', 'startedAt'] as const satisfies readonly (keyof RunIdentity)[];

export const sameRun = (a: RunIdentity, b: RunIdentity): boolean => a.flow === b.flow && a.startedAt === b.startedAt;

/** A string that is equal for two identities exactly when `sameRun` holds. */
export const runKeyOf = (run: RunIdentity): string => JSON.stringify([run.flow, run.startedAt]);
