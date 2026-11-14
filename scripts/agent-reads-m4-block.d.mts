export interface OrdinaryM4Open { readonly ms: number; readonly maxGapMs: number }
export interface M4Ordinary extends OrdinaryM4Open { readonly runs: readonly OrdinaryM4Open[] }
export interface M4StageDurations {
    readonly producerMs: number; readonly decodeMs: number; readonly rebuildMs: number; readonly totalMs: number;
    readonly [key: string]: unknown;
}
export interface M4BlockResult {
    readonly ordinary: M4Ordinary; readonly control: OrdinaryM4Open; readonly stages: M4StageDurations;
}
export function measureM4Block(ports: {
    readonly openOrdinary: () => Promise<OrdinaryM4Open>;
    readonly openControl: (ordinary: M4Ordinary) => Promise<OrdinaryM4Open>;
    readonly openStages: () => Promise<M4StageDurations>;
    readonly sleep: (ms: number) => Promise<void>;
}): Promise<M4BlockResult>;
