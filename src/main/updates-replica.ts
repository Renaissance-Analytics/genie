import type { UpdateChannel } from '../core/update-channel.js';
import type { InstallResult, UpdateState } from './updater.js';
import type { HelperLaunch } from './updates-host.js';

/**
 * THE WINDOW'S UPDATES, A REPLICA OF GENIE-HOST'S (the host split, P5b). Not built yet: the shape the P5b tests drive.
 */

const NOT_BUILT = 'P5b: the window’s updates replica is not built yet';

export class UpdatesReplica {
    constructor(_call: (method: string, args: readonly unknown[]) => Promise<unknown>, _pid: number) {}

    rebase(_state: UpdateState): void {}

    state(): UpdateState {
        throw new Error(NOT_BUILT);
    }

    check(): Promise<UpdateState> {
        return Promise.reject(new Error(NOT_BUILT));
    }

    download(): Promise<boolean> {
        return Promise.reject(new Error(NOT_BUILT));
    }

    install(): Promise<InstallResult> | null {
        return Promise.reject(new Error(NOT_BUILT));
    }

    refreshNotes(): Promise<UpdateState> {
        return Promise.reject(new Error(NOT_BUILT));
    }

    setChannel(_channel: UpdateChannel): void {}

    publishLaunch(_launch: HelperLaunch): Promise<void> {
        return Promise.reject(new Error(NOT_BUILT));
    }

    onInstalling(_listener: () => void): () => void {
        return () => {};
    }

    onChange(_listener: (state: UpdateState) => void): () => void {
        return () => {};
    }
}
