/**
 * STARTING GENIE'S HOST, SAID (Tynn #700). Measured on the Azure Windows gate, a fresh home: genie-host took 20 s to serve
 * its pipe, and the window, which makes its main window only once it is linked, showed nothing meanwhile. A start that
 * takes longer than HOST_WAIT_SHOW_AFTER_MS shows a small window that says Genie's host is starting and how long it has
 * been; it closes as soon as the link is up, or the host is known to have failed.
 *
 * NO SILENT FOREVER: the window keeps waiting while its host lives, and from HOST_WAIT_ACTIONS_AFTER_MS the wait also
 * offers "Open the log" and "Restart Genie's host", one at a time, each with progress and then its outcome in words.
 * Restart ends that host and starts a new one (engine-launch.ts linkToHost), and the same wait goes on. Quit is the
 * window's close.
 */
export const HOST_WAIT_SHOW_AFTER_MS = 1_500;
export const HOST_WAIT_ACTIONS_AFTER_MS = 60_000;

export type HostWaitAction = 'open-log' | 'restart';
export type HostWaitOutcome = { ok: true } | { ok: false; reason: string };

export interface HostWaitView {
    readonly title: string;
    readonly detail: string;
    /** "Open the log" and "Restart Genie's host" are offered (from HOST_WAIT_ACTIONS_AFTER_MS, then for good). */
    readonly actions: boolean;
    readonly busy: HostWaitAction | null;
    readonly outcome: { readonly ok: boolean; readonly text: string } | null;
}

export function hostWaitWords(elapsedMs: number): { readonly title: string; readonly detail: string } {
    return { title: 'Starting Genie’s host…', detail: `The first start can take a minute. ${Math.floor(elapsedMs / 1000)} s so far.` };
}

export const HOST_RESTARTED = 'Genie’s host was started again. Waiting for it.';

export interface HostWaitPorts {
    open(view: HostWaitView): void;
    update(view: HostWaitView): void;
    close(): void;
}

export interface HostWaitActions {
    /** Opens the host's log: `null`, or why it could not. */
    openLog(): Promise<string | null>;
    restart(): Promise<HostWaitOutcome>;
}

/** The wait's state: nothing for a quick start; opened once it is slow, updated, and closed once. Never throws into the link. */
export class HostWait {
    readonly #ports: HostWaitPorts;
    readonly #actions: HostWaitActions | undefined;
    readonly #showAfterMs: number;
    #shown = false;
    #done = false;
    #elapsedMs = 0;
    #offered = false;
    #busy: HostWaitAction | null = null;
    #outcome: HostWaitView['outcome'] = null;

    constructor(ports: HostWaitPorts, actions?: HostWaitActions, options: { readonly showAfterMs?: number } = {}) {
        this.#ports = ports;
        this.#actions = actions;
        this.#showAfterMs = options.showAfterMs ?? HOST_WAIT_SHOW_AFTER_MS;
    }

    #view(): HostWaitView {
        return { ...hostWaitWords(this.#elapsedMs), actions: this.#offered, busy: this.#busy, outcome: this.#outcome };
    }

    #draw(): void {
        if (this.#done) return;
        try {
            if (!this.#shown) { this.#shown = true; this.#ports.open(this.#view()); }
            else this.#ports.update(this.#view());
        } catch { /* a wait that cannot be drawn must not stop the host being reached */ }
    }

    /** The view as it is now, for a page that asks on load. `null` while nothing is shown. */
    current(): HostWaitView | null {
        return this.#shown && !this.#done ? this.#view() : null;
    }

    progress(elapsedMs: number): void {
        if (this.#done) return;
        this.#elapsedMs = elapsedMs;
        if (!this.#shown && elapsedMs < this.#showAfterMs) return;
        if (this.#actions && elapsedMs >= HOST_WAIT_ACTIONS_AFTER_MS) this.#offered = true;
        this.#draw();
    }

    /** One of the two actions, pressed: one at a time, busy while it runs, then its outcome. Never throws. */
    async act(action: HostWaitAction): Promise<void> {
        if (this.#done || !this.#offered || this.#busy !== null || !this.#actions) return;
        this.#busy = action;
        this.#outcome = null;
        this.#draw();
        try {
            if (action === 'open-log') {
                const failed = await this.#actions.openLog();
                this.#outcome = failed === null ? null : { ok: false, text: `Genie could not open the log: ${failed}` };
            } else {
                const r = await this.#actions.restart();
                this.#outcome = r.ok ? { ok: true, text: HOST_RESTARTED } : { ok: false, text: r.reason };
            }
        } catch (error) {
            this.#outcome = { ok: false, text: error instanceof Error ? error.message : String(error) };
        }
        this.#busy = null;
        this.#draw();
    }

    done(): void {
        if (this.#done) return;
        this.#done = true;
        if (!this.#shown) return;
        try { this.#ports.close(); } catch { /* already gone */ }
    }
}

/**
 * RESTART, HANDED TO THE LINK (engine-launch.ts linkToHost): the wait asks; the link, which holds the host's pid, takes
 * the ask at its next look, ends that host, starts a new one and settles the ask with how it went.
 */
export class HostRestart {
    #asked: ((outcome: HostWaitOutcome) => void) | null = null;
    #taken = false;

    request(): Promise<HostWaitOutcome> {
        if (this.#asked) return Promise.resolve({ ok: false, reason: 'Genie’s host is already being started again.' });
        return new Promise((done) => { this.#asked = done; this.#taken = false; });
    }

    /** The link's look: true once for each ask. */
    take(): boolean {
        if (!this.#asked || this.#taken) return false;
        this.#taken = true;
        return true;
    }

    settled(outcome: HostWaitOutcome): void {
        const done = this.#asked;
        this.#asked = null;
        done?.(outcome);
    }
}

/**
 * A DELAY BEFORE THE HOST WRITES ITS RECORD, for the real-window test that starts it late (scripts/host-late-ready-cdp.mjs).
 * Only when GENIE_TEST_HOST_READY_DELAY_MS is set to a whole number of ms; at most two minutes. Unset, nothing is delayed.
 */
export function testReadyDelayMs(env: Readonly<Record<string, string | undefined>>): number {
    const raw = env['GENIE_TEST_HOST_READY_DELAY_MS'];
    if (raw === undefined || !/^\d+$/.test(raw)) return 0;
    return Math.min(Number(raw), 120_000);
}
