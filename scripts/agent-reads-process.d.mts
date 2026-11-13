import type { AcquiredSample, RunIdentity, SampleRequest } from './agent-reads-acquire.mjs';

export function readMeasurementIdentity(runId: string): RunIdentity;
export function runMeasurementProcess(options: {
    readonly request: SampleRequest;
    readonly cwd: string;
    readonly out: string;
    readonly timeoutMs?: number;
    readonly scope?: 'full' | 'm4-diagnostic';
}): Promise<AcquiredSample>;
