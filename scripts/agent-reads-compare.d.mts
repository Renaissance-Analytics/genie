export interface CompareRow { readonly row: string; readonly base: number | null; readonly value: number | null; readonly limit: number | null; readonly pass: boolean }
export function compareRuns(baseline: unknown, candidate: unknown): CompareRow[];
export function comparePairedRuns(report: unknown, options?: { readonly scope: 'full' | 'm4' | 'm5-m6' }): CompareRow[];
