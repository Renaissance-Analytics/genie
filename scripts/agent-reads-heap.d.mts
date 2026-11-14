export interface HeapFrame {
    readonly error?: { readonly message?: string };
    readonly result?: { readonly usedSize?: number; readonly [key: string]: unknown };
    readonly [key: string]: unknown;
}
export interface HeapCdp {
    send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<HeapFrame>;
}
export interface HeapPoint { readonly phase: 'baseline' | 'stream' | 'after-gc'; readonly elapsedMs: number; readonly usedBytes: number }
export interface HeapReport {
    readonly heapBeforeBytes: number;
    readonly heapAfterGcBytes: number;
    readonly gc: boolean;
    readonly heapSeries: readonly HeapPoint[];
}
export function createHeapSampler(cdp: HeapCdp, now?: () => number): {
    start(): Promise<void>;
    sample(): Promise<void>;
    finish(): Promise<HeapReport>;
};
