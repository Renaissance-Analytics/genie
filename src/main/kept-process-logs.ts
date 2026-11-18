import type { ProcessLog } from '../core/output-tail.js';
import type { ProcessStatus } from './process-supervisor.js';

/** STUB (Tynn #860 RED). */
export interface KeptProcessLogsDeps {
    readonly supervisor: {
        readLog(id: string, lines?: number): ProcessLog | null;
        onOutput(listener: (id: string, data: string) => void): () => void;
        onChange(listener: (status: ProcessStatus) => void): () => void;
    };
    readonly owns: (id: string) => boolean;
    readonly schedule?: (fn: () => void, ms: number) => () => void;
}

export class KeptProcessLogs {
    static async open(_dir: string, _deps: KeptProcessLogsDeps): Promise<KeptProcessLogs> { return new KeptProcessLogs(); }
    read(_id: string, _lines?: number): ProcessLog | null { return null; }
    async flush(): Promise<void> {}
    async forget(_id: string): Promise<void> {}
}
