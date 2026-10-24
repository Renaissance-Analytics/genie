import { hostsFileBlock, hostsNames, mergeHostsFile } from '../core/gen-router.js';
import { stepOutcome, type ElevationOutcome, type Elevator, type PrivilegedStep, type Step } from './elevate.js';

/**
 * THE HOSTS FILE — the Genie-owned block that makes `<name>.gen` resolve to loopback for external browsers.
 *
 * It follows the CONFIGURED names (genie#624 in Genie 1): a site that exists resolves whether or not it is running, so
 * starting or stopping a site never touches this administrator-owned file and never raises a prompt. Only the person
 * changing WHICH sites exist moves it — a moment they expect to be asked.
 *
 * Written only when the block actually CHANGES, plainly when the process may, through the OS prompt only when the
 * plain write is refused. Syncs are SERIALISED and DEBOUNCED — one write per burst of changes, never two prompts at
 * once — and a declined prompt is reported with the block the person could paste themselves, never retried into a
 * prompt loop: the same names are not tried again until the person asks (Try again), the set changes, or a Trust's
 * prompt carries the write along with it (joinElevation).
 */

export interface HostsIo {
    read(): Promise<string>;
    write(content: string): Promise<void>;
    /** Prepare `content` for the elevated copy and answer the step that copies it; nothing privileged happens here. */
    stage(content: string): Promise<Step>;
}

export type HostsSyncResult =
    | { changed: false; elevated: false }
    | { changed: true; elevated: boolean }
    | { changed: false; elevated: false; error: string; manualBlock: string };

export const HOSTS_STEP_ID = 'hosts';
export const HOSTS_STEP_LABEL = 'update the hosts file';

export interface HostsSyncDeps {
    /** The configured `.gen` names, now. */
    readonly names: () => readonly string[];
    readonly io: HostsIo;
    readonly elevator: Elevator;
    /** How long a burst of changes is waited out before the one write. */
    readonly debounceMs: number;
    readonly schedule: (fn: () => void, ms: number) => () => void;
    /** Each sync's result, as it lands. */
    readonly onResult: (result: HostsSyncResult) => void;
}

type Attempt =
    | { kind: 'done'; result: HostsSyncResult }
    | { kind: 'elevate'; step: PrivilegedStep; manualBlock: string };

export class HostsSync {
    readonly #deps: HostsSyncDeps;
    #armed = false;
    #cancel: (() => void) | null = null;
    #pending: { promise: Promise<void>; resolve: () => void } | null = null;
    #lock: Promise<unknown> = Promise.resolve();
    /** The names (joined) the last sync tried — landed or not. The same names are not tried again by a change. */
    #tried: string | null = null;
    #result: HostsSyncResult | null = null;

    constructor(deps: HostsSyncDeps) {
        this.#deps = deps;
    }

    get result(): HostsSyncResult | null {
        return this.#result;
    }

    /** Boot has loaded the sites: from here on the hosts file follows them, starting with one sync. */
    begin(): void {
        this.#armed = true;
        this.#request();
    }

    /** A site change. Nothing at all happens unless the configured names differ from what was last tried. */
    changed(): void {
        if (!this.#armed) return;
        if (this.#key() === this.#tried) return;
        this.#request();
    }

    /** Observe queued work, including its debounce, without requesting a sync or retrying a declined prompt. */
    async settled(): Promise<void> {
        for (;;) {
            await this.#pending?.promise;
            const lock = this.#lock;
            await lock;
            if (this.#pending === null && this.#lock === lock) return;
        }
    }

    /** Sync now — the person's Try again. Serialised behind any sync in flight; a pending debounce is folded into it. */
    flush(): Promise<HostsSyncResult> {
        this.#cancelPending();
        return this.#locked(async () => {
            const attempt = await this.#attempt();
            if (attempt.kind === 'done') return this.#land(attempt.result);
            const outcome = await this.#deps.elevator.run([attempt.step]);
            return this.#land(this.#fromOutcome(outcome, [attempt.step], attempt.manualBlock));
        });
    }

    /**
     * Run `elevate` (another privileged step's batch — the Trust) with the hosts write folded in when one is due: the
     * names changed since the last try, or the last try failed. ONE prompt then carries both. Holds the sync's lock
     * throughout, so no separate hosts prompt can open beside it.
     */
    joinElevation(elevate: (hostsSteps: readonly PrivilegedStep[]) => Promise<{ outcome: ElevationOutcome; steps: readonly PrivilegedStep[] }>): Promise<ElevationOutcome> {
        this.#cancelPending();
        return this.#locked(async () => {
            const due = this.#key() !== this.#tried || (this.#result !== null && 'error' in this.#result);
            const attempt = due ? await this.#attempt() : null;
            if (attempt?.kind === 'done') this.#land(attempt.result);
            const staged = attempt?.kind === 'elevate' ? attempt : null;
            const { outcome, steps } = await elevate(staged ? [staged.step] : []);
            if (staged) this.#land(this.#fromOutcome(outcome, steps, staged.manualBlock));
            return outcome;
        });
    }

    close(): void {
        this.#armed = false;
        this.#cancelPending();
    }

    #key(): string {
        try {
            return hostsNames(this.#deps.names()).join(' ');
        } catch {
            return `invalid:${this.#deps.names().join(' ')}`;
        }
    }

    #request(): void {
        this.#cancelPending();
        let resolve!: () => void;
        const promise = new Promise<void>((done) => { resolve = done; });
        this.#pending = { promise, resolve };
        this.#cancel = this.#deps.schedule(() => {
            this.#cancel = null;
            void this.flush();
        }, this.#deps.debounceMs);
    }

    #cancelPending(): void {
        this.#cancel?.();
        this.#cancel = null;
        this.#pending?.resolve();
        this.#pending = null;
    }

    #locked<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.#lock.then(fn);
        this.#lock = run.catch(() => undefined);
        return run;
    }

    /** Read, merge, and write plainly if the file changes; a refused plain write is staged for the prompt instead. */
    async #attempt(): Promise<Attempt> {
        const names = this.#deps.names();
        this.#tried = this.#key();
        let manualBlock: string;
        try {
            manualBlock = hostsFileBlock(names);
        } catch (error) {
            return { kind: 'done', result: { changed: false, elevated: false, error: (error as Error).message, manualBlock: '' } };
        }
        try {
            const current = await this.#deps.io.read();
            const next = mergeHostsFile(current, names);
            if (next === current) return { kind: 'done', result: { changed: false, elevated: false } };
            try {
                await this.#deps.io.write(next);
                return { kind: 'done', result: { changed: true, elevated: false } };
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== 'EACCES' && code !== 'EPERM') return { kind: 'done', result: { changed: false, elevated: false, error: (error as Error).message, manualBlock } };
            }
            const step = await this.#deps.io.stage(next);
            return { kind: 'elevate', step: { id: HOSTS_STEP_ID, label: HOSTS_STEP_LABEL, step }, manualBlock };
        } catch (error) {
            return { kind: 'done', result: { changed: false, elevated: false, error: (error as Error).message, manualBlock } };
        }
    }

    #fromOutcome(outcome: ElevationOutcome, steps: readonly PrivilegedStep[], manualBlock: string): HostsSyncResult {
        const mine = stepOutcome(outcome, steps, HOSTS_STEP_ID);
        return mine.ok ? { changed: true, elevated: true } : { changed: false, elevated: false, error: mine.error, manualBlock };
    }

    #land(result: HostsSyncResult): HostsSyncResult {
        this.#result = result;
        this.#deps.onResult(result);
        return result;
    }
}
