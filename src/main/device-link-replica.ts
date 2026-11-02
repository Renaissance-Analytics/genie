import type { DeviceLinkEvent, DeviceLinkOpened } from './device-link-service.js';

export class DeviceLinkReplica {
    constructor(_call: (method: string, args: readonly unknown[]) => Promise<unknown>) {}
    open(_url: string): Promise<DeviceLinkOpened> { throw new Error('not built yet'); }
    send(_channel: string, _text: string): void { throw new Error('not built yet'); }
    close(_channel: string): void { throw new Error('not built yet'); }
    hosts(): Promise<string[]> { throw new Error('not built yet'); }
    forget(_url: string): Promise<boolean> { throw new Error('not built yet'); }
    adopt(_url: string, _token: string): Promise<boolean> { throw new Error('not built yet'); }
    deliver(_event: DeviceLinkEvent): void { throw new Error('not built yet'); }
    lost(_reason: string): void { throw new Error('not built yet'); }
    onFrame(_listener: (channel: string, text: string) => void): () => void { throw new Error('not built yet'); }
    onClosed(_listener: (channel: string, reason: string | null) => void): () => void { throw new Error('not built yet'); }
}
