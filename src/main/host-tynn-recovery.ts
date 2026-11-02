import type { AgentRecord } from '../core/identity.js';
export const RECOVERY_STEPS_MS: readonly number[] = [30_000, 120_000, 600_000, 1_800_000];
export interface HostTynnRecoveryPorts {
    names(asked: { readonly secretsMoved?: boolean }): Promise<string[]>;
    waiting(): boolean;
    recheck(): Promise<unknown>;
    readonly host: unknown;
    record(id: string): AgentRecord | null;
    threadOf(id: string): string | null;
    cwdFor(record: AgentRecord): string;
    readonly schedule?: (ms: number, fn: () => void) => () => void;
    readonly log?: (line: string) => void;
}
/** RED STUB. */
export function hostTynnRecovery(_ports: HostTynnRecoveryPorts) {
    return { recover: async (_asked: { readonly secretsMoved?: boolean } = {}): Promise<void> => {}, kick: (): void => {} };
}
