import type { GenieBridge } from './bridge.js';

export interface QuestionProtocol {
    readonly ready: Promise<{ ok: true } | { ok: false; reason: string }>;
    readonly bridge: Pick<GenieBridge, 'features' | 'questions'>;
    close(): void;
}

export function questionBridge(_preload: unknown, _connect: () => QuestionProtocol, _options: { idleMs?: number } = {}): never {
    throw new Error('2f-1: not built yet');
}
