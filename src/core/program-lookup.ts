// RED: the shape only.
export interface ProcessPorts { readonly platform: NodeJS.Platform; readonly env: NodeJS.ProcessEnv; readonly home: () => string; readonly chdir: (to: string) => void }
export function hardenProcess(_ports?: ProcessPorts): void {}
export interface LookupPorts { readonly platform: NodeJS.Platform; readonly env: NodeJS.ProcessEnv; readonly isFile?: (path: string) => boolean }
export function resolveProgram(name: string, _ports?: LookupPorts): string { return name; }
