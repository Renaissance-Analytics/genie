import type { DeckItem } from '../core/deck.js';
import { hostsFileBlock, hostsNames, mergeHostsFile } from '../core/gen-router.js';
import { hostsApprovalDeckItem, hostsApprovalTitle } from '../core/hosts-approval.js';
import { stepOutcome, type ElevationOutcome, type Elevator, type PrivilegedStep, type Step } from './elevate.js';

/**
 * THE HOSTS FILE — the Genie-owned block that makes `<name>.gen` resolve to loopback for external browsers.
 *
 * It follows the CONFIGURED names (genie#624 in Genie 1): a site that exists resolves whether or not it is running, so
 * starting or stopping a site never touches this administrator-owned file. Only a change to WHICH sites exist moves it.
 *
 * A SITE CHANGE NEVER ELEVATES ON ITS OWN (Tynn #753). The change may be an agent's `sites add`, a workspace's declared
 * site or Genie starting, and none of those is the person saying yes to an OS prompt. So the automatic path (begin,
 * changed, the debounce) writes the file plainly when the process may, and when it may not it only RECORDS that a write
 * is due: Genie asks in the Deck (core/hosts-approval.ts) and nothing is staged. The prompt runs from the person's
 * actions only: flush() (Approve in the Deck, Try again in Hosting) and joinElevation() (a Trust, whose one prompt
 * carries a due hosts write along, genie#604).
 *
 * Syncs are SERIALISED and DEBOUNCED, one write per burst of changes and never two prompts at once. A declined prompt is
 * reported with the block the person could paste themselves and is not retried: the same names are not asked about
 * again until the person asks (Try again), the set changes, or a Trust carries the write.
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
    /** `awaitingApproval`: nothing was tried yet; the write waits for the person's Approve in the Deck (Tynn #753). */
    | { changed: false; elevated: false; error: string; manualBlock: string; awaitingApproval?: true };

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
    /** Each sync's result, as it lands (and the ask put away by Not now). */
    readonly onResult: (result: HostsSyncResult) => void;
    /** When an ask was first raised; Date.now by default. */
    readonly now?: () => number;
}

type Attempt =
    | { kind: 'done'; result: HostsSyncResult }
    | { kind: 'elevate'; current: string; next: string; manualBlock: string };

/** The ask the Deck shows: for which names (joined), what it adds and takes out, and since when. */
interface Ask {
    readonly key: string;
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly manualBlock: string;
    readonly at: number;
}

/** The names a merge adds to the file and the `.gen` names it takes out, as the person reads them. */
function nameChanges(current: string, names: readonly string[]): { added: string[]; removed: string[] } {
    const tokens = new Set(current.split(/\s+/).filter((t) => t !== '' && !t.startsWith('#')));
    const want = hostsNames(names);
    const keep = new Set(want);
    return { added: want.filter((n) => !tokens.has(n)), removed: [...tokens].filter((t) => t.endsWith('.gen') && !keep.has(t)).sort() };
}

export class HostsSync {
    readonly #deps: HostsSyncDeps;
    #armed = false;
    #cancel: (() => void) | null = null;
    #pending: { promise: Promise<void>; resolve: () => void } | null = null;
    #lock: Promise<unknown> = Promise.resolve();
    /** The names (joined) the last sync tried — landed or not. The same names are not tried again by a change. */
    #tried: string | null = null;
    #result: HostsSyncResult | null = null;
    /** The write that waits for the person's Approve; null = none due. */
    #ask: Ask | null = null;
    /** The names (joined) the person said Not now to: that ask stays away until the names change. */
    #deferred: string | null = null;

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

    /**
     * The PERSON's sync: Approve in the Deck, Try again in Hosting. The only door, besides a Trust, that may raise the OS
     * prompt. Serialised behind any sync in flight; a pending debounce is folded into it.
     */
    flush(): Promise<HostsSyncResult> {
        this.#cancelPending();
        return this.#locked(async () => {
            const attempt = await this.#attempt();
            if (attempt.kind === 'done') return this.#settle(attempt.result);
            const step = await this.#stage(attempt);
            if ('result' in step) return this.#settle(step.result);
            const outcome = await this.#deps.elevator.run([step.step]);
            return this.#settle(this.#fromOutcome(outcome, [step.step], attempt.manualBlock));
        });
    }

    /**
     * Run `elevate` (another privileged step's batch — the Trust) with the hosts write folded in when one is due: the
     * names changed since the last try, the last try failed, or the write waits for approval. ONE prompt then carries
     * both. Holds the sync's lock throughout, so no separate hosts prompt can open beside it.
     */
    joinElevation(elevate: (hostsSteps: readonly PrivilegedStep[]) => Promise<{ outcome: ElevationOutcome; steps: readonly PrivilegedStep[] }>): Promise<ElevationOutcome> {
        this.#cancelPending();
        return this.#locked(async () => {
            const due = this.#key() !== this.#tried || (this.#result !== null && 'error' in this.#result);
            const attempt = due ? await this.#attempt() : null;
            if (attempt?.kind === 'done') this.#settle(attempt.result);
            const staged = attempt?.kind === 'elevate' ? await this.#stage(attempt) : null;
            if (staged && 'result' in staged) this.#settle(staged.result);
            const step = staged && 'step' in staged ? staged.step : null;
            const { outcome, steps } = await elevate(step ? [step] : []);
            if (step && attempt?.kind === 'elevate') this.#settle(this.#fromOutcome(outcome, steps, attempt.manualBlock));
            return outcome;
        });
    }

    /** The person's Not now: the ask goes from the Deck until the names change. Hosting's Try again still works. */
    defer(): void {
        if (this.#ask === null) return;
        this.#deferred = this.#ask.key;
        if (this.#result !== null) this.#deps.onResult(this.#result);
    }

    /** The Deck's ask, while a write waits for the person and they have not said Not now to these names. */
    deckItems(): DeckItem[] {
        const ask = this.#ask;
        if (ask === null || ask.key === this.#deferred) return [];
        return [hostsApprovalDeckItem({ added: ask.added, removed: ask.removed, manualBlock: ask.manualBlock, at: ask.at })];
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
            const pending = this.#pending;
            this.#pending = null;
            void this.#automatic();
            pending?.resolve();
        }, this.#deps.debounceMs);
    }

    /** The debounce's sync: a plain write, or the ask recorded. NEVER the Elevator (Tynn #753). */
    #automatic(): Promise<void> {
        return this.#locked(async () => {
            const attempt = await this.#attempt();
            if (attempt.kind === 'done') { this.#settle(attempt.result); return; }
            const key = this.#tried ?? this.#key();
            const { added, removed } = nameChanges(attempt.current, this.#deps.names());
            this.#ask = { key, added, removed, manualBlock: attempt.manualBlock, at: this.#ask?.key === key ? this.#ask.at : (this.#deps.now ?? Date.now)() };
            this.#land({ changed: false, elevated: false, error: `waiting for your approval in the Deck: ${hostsApprovalTitle(added, removed)}`, manualBlock: attempt.manualBlock, awaitingApproval: true });
        }).catch(() => undefined);
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

    /** Read, merge, and write plainly if the file changes; a refused plain write answers what the prompt would copy. */
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
            return { kind: 'elevate', current, next, manualBlock };
        } catch (error) {
            return { kind: 'done', result: { changed: false, elevated: false, error: (error as Error).message, manualBlock } };
        }
    }

    /** Staged only for the person's prompt, right before it: the step carries the hash of `next` (elevate.ts). */
    async #stage(attempt: Extract<Attempt, { kind: 'elevate' }>): Promise<{ step: PrivilegedStep } | { result: HostsSyncResult }> {
        try {
            return { step: { id: HOSTS_STEP_ID, label: HOSTS_STEP_LABEL, step: await this.#deps.io.stage(attempt.next) } };
        } catch (error) {
            return { result: { changed: false, elevated: false, error: (error as Error).message, manualBlock: attempt.manualBlock } };
        }
    }

    #fromOutcome(outcome: ElevationOutcome, steps: readonly PrivilegedStep[], manualBlock: string): HostsSyncResult {
        const mine = stepOutcome(outcome, steps, HOSTS_STEP_ID);
        return mine.ok ? { changed: true, elevated: true } : { changed: false, elevated: false, error: mine.error, manualBlock };
    }

    /** A sync the person's action (or a plain write) settled: whatever it came to, nothing waits in the Deck any more. */
    #settle(result: HostsSyncResult): HostsSyncResult {
        this.#ask = null;
        return this.#land(result);
    }

    #land(result: HostsSyncResult): HostsSyncResult {
        this.#result = result;
        this.#deps.onResult(result);
        return result;
    }
}
