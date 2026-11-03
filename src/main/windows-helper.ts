import type { EventEmitter } from 'node:events';

export class HelperLost extends Error {
    constructor(message: string) { super(message); this.name = 'HelperLost'; }
}
export interface HelperChild extends EventEmitter {
    readonly pid?: number | undefined;
    readonly stdin: { write(text: string): unknown; end(): unknown } | null;
    readonly stdout: EventEmitter | null;
    kill(): boolean;
}
export interface HelperRequest {
    readonly stdin: EventEmitter & { write(text: string): boolean; end(text?: string): void; destroy(): void };
    readonly stdout: EventEmitter;
    readonly completed: Promise<{ stdout: string; stderr: string }>;
    kill(): void;
}
export interface WindowsHelperOptions {
    readonly spawn?: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => HelperChild;
    readonly deadlineMs?: number;
    readonly log?: (line: string) => void;
}
export function helperSpawnArgs(): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
    throw new Error('not built yet');
}
export class WindowsHelper {
    constructor(_options: WindowsHelperOptions = {}) {}
    get pid(): number | null { return null; }
    run(_body: string): HelperRequest { throw new Error('not built yet'); }
    stop(): void { throw new Error('not built yet'); }
}
