import type { UpdateChannel } from '../core/update-channel.js';
import type { InstallResult, UpdateState } from './updater.js';
import type { HelperLaunch, UpdateFailedRecord } from './updates-host.js';
import type { AgentDrainOutcome } from '../core/agent-shutdown-drain.js';
import type { UpdateScope } from '../core/update-kind.js';

/**
 * THE WINDOW'S UPDATES, A REPLICA OF GENIE-HOST'S (the host split, P5b). The state is the host's `UpdateState`, sent whole
 * on the window's LOCAL link (`updates.dump` before ready, `updates.event` on every change); the Deck item, the update
 * window, the tray and the restart screen read it exactly as they read the window's own updater before. The person's
 * check, download, install and channel go to the host as calls; the window lends nothing.
 *
 * `install()` keeps `UpdateHost`'s contract: `null` when nothing is downloaded, otherwise the host's answer — the drain's
 * words and the teardown report. When the answer comes with the state `installing`, the window is told once
 * (`onInstalling`), with what the update changes (its `scope`): the host has drained and exits, and the window quits without
 * recording anything over the host's record; or only the window is updated (client-only), and the window alone exits.
 */

const IDLE: UpdateState = { phase: 'idle', version: null, percent: null, error: null, checkedAt: null };

export class UpdatesReplica {
    readonly #call: (method: string, args: readonly unknown[]) => Promise<unknown>;
    readonly #pid: number;
    #state: UpdateState = IDLE;
    readonly #listeners = new Set<(state: UpdateState) => void>();
    readonly #installing = new Set<(scope: UpdateScope | undefined) => void>();
    #told = false;
    #atStart = false;
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
        // WHOEVER ASKED (Tynn #898 step 2d-2b): a phone or another workstation can install through genie-host, so every
        // window quits when the install restarts (its last step before the helper takes over), not only the one that asked.
        // Early only for an UPDATE's install: "Shut down everything" drains through the same phase (reason `quit`), and that
        // quit is the person's to carry out, never an install to leave for (the full gate, 1127-174858-edb743).
        const early = this.#atStart && state.installing?.reason !== 'quit';
        if (state.phase === 'installing' && (early || state.installing?.step === 'restarting')) this.#tellInstalling();
    }

    /**
     * UNDER THE LAUNCHER (Tynn #1058 L6): the window is told at the install's START, not its restart, and leaves: the
     * launcher's own window shows the drain and the swap, and the launcher opens Genie again after.
     */
    tellAtStart(): void {
        this.#atStart = true;
    }

    #tellInstalling(): void {
        if (this.#told) return;
        this.#told = true;
        const scope = this.#state.scope;
        for (const l of [...this.#installing]) l(scope);
    }

    /** This window says it is one, with its pid, each time it links: the host's install spares it and waits for it to go. */
    async announce(): Promise<void> {
        await this.#call('window', [this.#pid]);
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

    prepareQuit(): Promise<AgentDrainOutcome> { return this.#call('prepareQuit', []) as Promise<AgentDrainOutcome>; }
    async forceDrain(): Promise<boolean> { return (await this.#call('forceDrain', [])) === true; }
    async cancelDrain(): Promise<void> { await this.#call('cancelDrain', []); }

    install(): Promise<InstallResult> | null {
        if (this.#state.phase !== 'downloaded' && !(this.#state.phase === 'error' && this.#state.percent === 100 && this.#state.version !== null)) return null;
        // This window's pid: the host's teardown leaves its tree, and the helper waits for it to be gone.
        return (this.#call('install', [this.#pid]) as Promise<InstallResult | null>).then((result) => {
            if (result === null) throw new Error('there is nothing downloaded to install');
            if (this.#state.phase === 'installing') this.#tellInstalling();
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

    /** Told once, when the host answered an install, with the install's scope (P6-1): client-only = the host stays. */
    onInstalling(listener: (scope: UpdateScope | undefined) => void): () => void {
        this.#installing.add(listener);
        return () => { this.#installing.delete(listener); };
    }

    onChange(listener: (state: UpdateState) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }
}
