import type { UpdateChannel } from '../core/update-channel.js';
import type { InstallResult, UpdateState } from './updater.js';
import type { HelperLaunch, UpdateFailedRecord } from './updates-host.js';

/**
 * THE WINDOW'S UPDATES, A REPLICA OF GENIE-HOST'S (the host split, P5b). The state is the host's `UpdateState`, sent whole
 * on the window's LOCAL link (`updates.dump` before ready, `updates.event` on every change); the Deck item, the update
 * window, the tray and the restart screen read it exactly as they read the window's own updater before. The person's
 * check, download, install and channel go to the host as calls; the window lends nothing.
 *
 * `install()` keeps `UpdateHost`'s contract: `null` when nothing is downloaded, otherwise the host's answer — the drain's
 * words and the teardown report. When the answer comes with the state `installing`, the window is told once
 * (`onInstalling`): the host has drained and exits, and the window quits without recording anything over the host's record.
 */

const IDLE: UpdateState = { phase: 'idle', version: null, percent: null, error: null, checkedAt: null };

export class UpdatesReplica {
    readonly #call: (method: string, args: readonly unknown[]) => Promise<unknown>;
    readonly #pid: number;
    #state: UpdateState = IDLE;
    readonly #listeners = new Set<(state: UpdateState) => void>();
    readonly #installing = new Set<() => void>();
    #told = false;
    readonly #failedListeners = new Set<(notice: UpdateFailedRecord) => void>();
    #failedPending: UpdateFailedRecord | null = null;

    constructor(call: (method: string, args: readonly unknown[]) => Promise<unknown>, pid: number) {
        this.#call = call;
        this.#pid = pid;
    }

    /** The host's state, whole (a dump or an event). */
    rebase(state: UpdateState): void {
        this.#state = state;
        for (const l of [...this.#listeners]) l(state);
    }

    state(): UpdateState {
        return this.#state;
    }

    check(): Promise<UpdateState> {
        return this.#call('check', []) as Promise<UpdateState>;
    }

    async download(): Promise<boolean> {
        return (await this.#call('download', [])) === true;
    }

    install(): Promise<InstallResult> | null {
        if (this.#state.phase !== 'downloaded') return null;
        // This window's pid: the host's teardown leaves its tree, and the helper waits for it to be gone.
        return (this.#call('install', [this.#pid]) as Promise<InstallResult | null>).then((result) => {
            if (result === null) throw new Error('there is nothing downloaded to install');
            if (this.#state.phase === 'installing' && !this.#told) {
                this.#told = true;
                for (const l of [...this.#installing]) l();
            }
            return result;
        });
    }

    refreshNotes(): Promise<UpdateState> {
        return this.#call('notes', []) as Promise<UpdateState>;
    }

    /** The `update_channel` setting, followed: the host's helper is re-configured with no restart. */
    setChannel(channel: UpdateChannel): void {
        void this.#call('setChannel', [channel]).catch(() => {});
    }

    /** How to start the updater helper: this window's executable (and, in a dev run, its app path). */
    async publishLaunch(launch: HelperLaunch): Promise<void> {
        await this.#call('launch', [launch]);
    }

    /** Why the last install did not happen, told once to the first window after it (a later subscriber still hears it). */
    onFailedInstall(listener: (notice: UpdateFailedRecord) => void): () => void {
        this.#failedListeners.add(listener);
        const pending = this.#failedPending;
        if (pending !== null) { this.#failedPending = null; listener(pending); }
        return () => { this.#failedListeners.delete(listener); };
    }

    /** The host's `updates.failed`: to the listeners now, or held for the first. */
    failedInstall(notice: UpdateFailedRecord): void {
        if (this.#failedListeners.size === 0) { this.#failedPending = notice; return; }
        for (const l of [...this.#failedListeners]) l(notice);
    }

    /** Told once, when the host answered an install and is on its way out. */
    onInstalling(listener: () => void): () => void {
        this.#installing.add(listener);
        return () => { this.#installing.delete(listener); };
    }

    onChange(listener: (state: UpdateState) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }
}
