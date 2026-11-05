import { bytesToBase64 } from '../core/mobile.js';
import { fromBase64 } from '../core/mobile-wire.js';

/** Local byte transport avoids an intermediate binary string where the window supports it. */
export function encodeLocalBase64(bytes: Uint8Array): string {
    const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
    return typeof native === 'function' ? native.call(bytes) : bytesToBase64(bytes);
}

/** Callers retain their wire-format/length/hash guards; older windows retain the original decoder. */
export function decodeLocalBase64(text: string): Uint8Array | null {
    const native = (Uint8Array as typeof Uint8Array & { fromBase64?: (text: string) => Uint8Array }).fromBase64;
    try { return typeof native === 'function' ? native.call(Uint8Array, text) : fromBase64(text); }
    catch { return null; }
}
