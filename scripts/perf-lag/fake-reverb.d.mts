export const ORIGIN_NOT_ALLOWED: string;

export interface FakeReverbConnection {
    /** The Origin header as it arrived on the wire; `null` = none was sent. */
    readonly origin: string | null;
    readonly allowed: boolean;
    readonly path: string;
    /** The client sent a close frame. A refused socket never answers it. */
    readonly closeAsked: boolean;
    readonly received: readonly string[];
}

export interface FakeReverb {
    readonly connections: readonly FakeReverbConnection[];
    config(key?: string): { broadcaster: 'reverb'; key: string; host: string; port: number; scheme: 'http' };
    url(key?: string): string;
    close(): Promise<void>;
}

export function startFakeReverb(options: { allowedOrigins: readonly string[]; subscribe?: 'answer' | 'subscription-error' | 'pusher-error' | 'silent' }): Promise<FakeReverb>;
