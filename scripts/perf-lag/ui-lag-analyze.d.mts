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
export interface PagingPass { pass: string; states: number; pageNext: number }
export function pagingVerdict(passes: PagingPass[], options?: { maxPerState?: number; growth?: number; slack?: number }): {
    ok: boolean; maxPerState: number; rows: Array<PagingPass & { perState: number | null }>; reasons: string[];
};
export function pushVerdict(passes: Array<{ pass: string; sizes: number[] }>, options?: { p95Bytes?: number; meanBytes?: number }): {
    ok: boolean; p95Bytes: number; meanBytes: number;
    rows: Array<{ pass: string; count: number; meanBytes: number | null; p95Bytes: number | null; maxBytes: number | null }>; reasons: string[];
};
export function pageVerdict(input: { idle: { count: number; p95: number } | null; streaming: { count: number; p95: number; worstFrameGapMs: number } | null }, options?: { p95SlackMs?: number; maxFrameGapMs?: number }): {
    ok: boolean; p95SlackMs: number; maxFrameGapMs: number; idleP95: number | null; streamingP95: number | null; worstFrameGapMs: number | null; reasons: string[];
};
export interface Slice { count: number; p95: number; worstGapMs: number }
export function sliceVerdict(input: { on: Slice[]; off: Slice[] }, options?: { p95SlackMs?: number; maxFrameGapMs?: number; minSlices?: number }): {
    ok: boolean; p95SlackMs: number; maxFrameGapMs: number; pairs: number; diffP95: number | null; diffs: Array<number | null>; onP95: number | null; offP95: number | null; onWorstGapMs: number | null; reasons: string[];
};
export function retryOnTimeout<T>(run: (attempt: number) => T, options?: { attempts?: number; reset?: (attempt: number) => void }): { value: T; tries: Array<{ attempt: number; ms: number; ok: boolean; timedOut?: boolean }> };
export function throughputVerdict(input: { on: Slice[]; off: Slice[] }, options?: { minRatio?: number; minSlices?: number }): {
    ok: boolean; minRatio: number; pairs: number; ratio: number | null; ratios: Array<number | null>; reasons: string[];
};
export interface TraceEvent { ph: string; name: string; pid: number; tid: number; ts?: number; dur?: number; args?: { name?: string } & Record<string, unknown> }
export function traceSummary(events: TraceEvent[], options?: { top?: number }): {
    threads: Array<{ thread: string; ms: number }>; top: Array<{ thread: string; name: string; ms: number; count: number }>;
};
