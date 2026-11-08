/** Who started a Claude Code session's current turn, as the guard and the audit both judge it. `human` is only a
 *  prompt the operator typed into the window's terminal or sent over Remote Control. */
export type TurnOrigin = 'human' | 'not-human' | 'undetermined';
