/** Stub (2g-2 RED). */
export interface HostSummary { readonly terminals: readonly { readonly workspaceId: string; readonly pid: number | null }[]; readonly armedFlows: readonly string[]; readonly scheduledTasks: readonly string[] }
export const EMPTY_HOST_SUMMARY: HostSummary = { terminals: [], armedFlows: [], scheduledTasks: [] };
export function hostSummaryOf(_t: unknown, _f: unknown, _k: unknown): HostSummary { throw new Error('2g-2: not built yet'); }
export function readHostSummary(_raw: unknown): HostSummary { throw new Error('2g-2: not built yet'); }
export function hostSummaryFeed(_p: { read(): HostSummary; onChange(l: () => void): () => void }): { now(): HostSummary; subscribe(l: (s: HostSummary) => void): () => void } { throw new Error('2g-2: not built yet'); }
