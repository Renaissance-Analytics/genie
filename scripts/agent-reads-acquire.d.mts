export type SampleMode = 'ipc' | 'door' | 'door-revision';
export interface RunIdentity { readonly build: string; readonly vmId: string; readonly platform: string; readonly runId: string }
export interface SampleRequest { readonly identity: RunIdentity; readonly pairIndex: number; readonly mode: SampleMode }
export interface AcquiredSample extends SampleRequest { readonly finished: boolean; readonly [key: string]: unknown }
export interface AcquiredPair { readonly order: readonly ('ipc' | 'door')[]; readonly ipc?: AcquiredSample; readonly door?: AcquiredSample }
export interface AcquisitionReport {
    readonly identity: RunIdentity;
    readonly candidateMode: 'door' | 'door-revision';
    readonly pairs: readonly AcquiredPair[];
}
export function acquirePairedRuns(options: {
    readonly identity: RunIdentity;
    readonly candidateMode?: 'door' | 'door-revision';
    readonly pairCount?: number;
    readonly runSample: (request: SampleRequest) => Promise<AcquiredSample>;
    readonly checkpoint: (report: AcquisitionReport) => Promise<void>;
}): Promise<AcquisitionReport>;
