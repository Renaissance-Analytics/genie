import type { DeviceTokens } from './device-tokens.js';

export interface DeviceSocket {
    readyState: number;
    onopen: ((ev: unknown) => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onclose: ((ev: unknown) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    send(data: string): void;
    close(): void;
}

export type DeviceLinkEvent =
    | { readonly type: 'frame'; readonly channel: string; readonly text: string }
    | { readonly type: 'closed'; readonly channel: string; readonly reason: string | null };

export type DeviceLinkOpened = { readonly ok: true; readonly channel: string } | { readonly ok: false; readonly reason: string };

export interface DeviceLinkServiceOptions {
    readonly tokens: DeviceTokens;
    readonly socket: (url: string) => DeviceSocket;
    readonly send: (owner: string, event: DeviceLinkEvent) => void;
    readonly log: (line: string) => void;
    readonly dialTimeoutMs?: number;
}

export class DeviceLinkService {
    constructor(_options: DeviceLinkServiceOptions) {}
    open(_owner: string, _url: string): Promise<DeviceLinkOpened> { throw new Error('not built yet'); }
    send(_owner: string, _channel: string, _text: string): void { throw new Error('not built yet'); }
    close(_owner: string, _channel: string): void { throw new Error('not built yet'); }
    dropOwner(_owner: string): void { throw new Error('not built yet'); }
    call(_owner: string, _method: string, _args: readonly unknown[]): Promise<unknown> { throw new Error('not built yet'); }
}
