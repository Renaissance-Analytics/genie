export interface Summary { count: number; p50: number; p95: number; max: number }
export interface Gap { startedMs: number; endedMs: number; ms: number }
export interface GapGauge { beat(): void; reset(): void; snapshot(): { ticks: number; dropped: number; worstMs: number; gaps: Gap[] } }
export interface CallFrame { functionName: string; url: string; lineNumber: number; columnNumber?: number }
export interface CpuProfile {
    nodes: Array<{ id: number; callFrame: CallFrame; children?: number[] }>;
    startTime: number;
    endTime: number;
    samples: number[];
    timeDeltas: number[];
}
export interface ProfileIndex {
    samples: Array<{ t: number; id: number }>;
    stack(id: number, depth?: number): string[];
    has(id: number, fn: string): boolean;
    kind(id: number): 'js' | 'program' | 'gc' | 'idle';
    fnOf(id: number): string;
}
export interface WindowProfile {
    samples: number;
    ms: { js: number; program: number; gc: number; idle: number };
    stacks: Array<{ ms: number; stack: string }>;
    ownFrames: Array<{ ms: number; frame: string }>;
}
export function summarize(values: number[]): Summary;
export function createGapGauge(options: { intervalMs: number; thresholdMs: number; cap?: number; now: () => number }): GapGauge;
export function worstGaps(gaps: Gap[], fromMs: number, toMs: number, n?: number): Gap[];
export function indexProfile(profile: CpuProfile, resolve?: (frame: CallFrame) => string | null): ProfileIndex;
export function firstSampleWith(index: ProfileIndex, fn: string): number | null;
export function windowProfile(index: ProfileIndex, fromMs: number, toMs: number, options?: { top?: number; depth?: number; isOwn?: (frame: string) => boolean }): WindowProfile;
export function budgetVerdict(gaps: Gap[], budgetMs: number): { ok: boolean; budgetMs: number; over: number; worstMs: number };
