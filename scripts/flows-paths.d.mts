export const FLOW_NAME: RegExp;
export const WINDOW_PATH: readonly string[];
export const ALSO: readonly string[];
export function srcFiles(root?: string): string[];
export function runtimeImports(file: string, root?: string): { resolved: string[]; unresolved: string[] };
export function importGraph(root?: string): Map<string, string[]>;
export function flowsDependencySet(root?: string): string[];
export function touchedFlows(changed: readonly string[], root?: string): string[];
