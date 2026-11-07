/** The window's frame port carries strings, never a credential or a per-method IPC call. */
export const LOCAL_FRAME_CHANNELS = { toHost: 'genie:local-frame', toWindow: 'genie:local-frame-back' } as const;
export const LOCAL_FRAME_LIMIT_BYTES = 1024 * 1024;
export type LocalFrameAction = 'open' | 'frame' | 'close';
export type LocalFrameReply = 'frame' | 'closed';
export interface LocalFramePort {
    send(action: LocalFrameAction, connection: string, text: string): void;
    onFrame(listener: (action: LocalFrameReply, connection: string, text: string) => void): () => void;
}
