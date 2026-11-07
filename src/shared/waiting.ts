/** A Waiting terminal's commands: the earliest-started command's program label, and how many others are running. */
export interface WaitingValue {
  readonly program: string;
  readonly others: number;
}
