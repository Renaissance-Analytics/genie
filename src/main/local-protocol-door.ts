import type { IpcMainEvent, WebContents } from 'electron';
import type { ServerTransport } from '../core/remote-protocol.js';

export interface LocalDoorIpc {
    on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): unknown;
    removeListener(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): unknown;
}
export type LocalDoorContents = Pick<WebContents, 'id' | 'mainFrame' | 'isDestroyed' | 'on' | 'removeListener'>;
export interface LocalProtocolDoor extends ServerTransport {
    admit(contents: LocalDoorContents): void;
    dispose(): void;
}

/** Contract shell for the test-first door slice; not wired into main yet. */
export function localProtocolDoor(_ipcMain: LocalDoorIpc): LocalProtocolDoor {
    return { admit: () => {}, dispose: () => {}, onConnection: () => () => {} };
}
