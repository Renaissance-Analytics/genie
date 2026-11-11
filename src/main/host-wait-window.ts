/** RED stand-in (Tynn #700). */
export const HOST_WAIT_SHOW_AFTER_MS = 0;

export function hostWaitWords(_elapsedMs: number): { readonly title: string; readonly detail: string } {
    return { title: '', detail: '' };
}

export interface HostWaitPorts {
    open(title: string, detail: string): void;
    update(detail: string): void;
    close(): void;
}

export class HostWait {
    constructor(_ports: HostWaitPorts, _options: { readonly showAfterMs?: number } = {}) {}
    progress(_elapsedMs: number): void {}
    done(): void {}
}

/** RED stand-in: a delay before the host serves, for a test that starts it late. */
export function testReadyDelayMs(_env: Readonly<Record<string, string | undefined>>): number {
    return 0;
}
