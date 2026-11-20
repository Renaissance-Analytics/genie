/** Stub (2f-2 RED): pieces of a device frame. */
export const DEVICE_PIECE_CHARS = 128 * 1024;
export function framePieces(_text: string): string[] { throw new Error('2f-2: not built yet'); }
export class FrameJoiner {
    constructor(_limitChars: number) {}
    add(_key: string, _piece: string, _more: boolean): { ok: true; text: string } | { ok: false; reason: string } | null { throw new Error('2f-2: not built yet'); }
    drop(_key: string): void { throw new Error('2f-2: not built yet'); }
}
