/** The environment the window's terminal spawns with: `endpoint` is the window's own bridge, or null when its
 *  launch setup failed. */
export function windowSessionEnv(base: NodeJS.ProcessEnv, _endpoint: string | null): NodeJS.ProcessEnv {
  return { ...base };
}
