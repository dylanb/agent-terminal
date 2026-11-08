export interface HelperProgramsDeps {
  /** The app-state home whose `.agent-terminal/helper-programs.yaml` lists the operator's helpers. */
  readonly appHome: string;
  now(): number;
}

export interface HelperPrograms {
  /** The program names the operator's helper file lists now. */
  names(): readonly string[];
}

export function createHelperPrograms(_deps: HelperProgramsDeps): HelperPrograms {
  return { names: () => [] };
}
