import { useSyncExternalStore } from 'react';
import { DEFAULT_SEND_KEY } from '../core/send-key.js';

/**
 * THE SEND KEY IN FORCE, FOR EVERY OPEN COMPOSER (Tynn issue #697). The app sets it from the settings; a composer reads it
 * as it takes each key, so a change in Settings applies to the composers already open, with nothing passed down to them.
 */
let current = DEFAULT_SEND_KEY;
const listeners = new Set<() => void>();

export function setSendKey(accelerator: string): void {
    if (accelerator === current) return;
    current = accelerator;
    for (const listener of [...listeners]) listener();
}

export function sendKeyNow(): string {
    return current;
}

const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function useSendKey(): string {
    return useSyncExternalStore(subscribe, sendKeyNow, () => DEFAULT_SEND_KEY);
}
