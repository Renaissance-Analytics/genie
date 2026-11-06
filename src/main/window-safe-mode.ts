import type { SafeModeView } from '../core/safe-mode.js';
import { SafeMode } from './safe-mode-host.js';

export type SafeModeAnswer = { ok: true } | { ok: false; reason: string };

/** What the window reads of genie-host's safe mode over the link (session-engine-client.ts). */
export interface LinkSafeMode {
    safeModeView(): SafeModeView | null;
    leaveSafeMode(): Promise<SafeModeAnswer>;
    onSafeMode(listener: (view: SafeModeView) => void): () => void;
}

/**
 * SAFE MODE AS THE WINDOW READS IT (Tynn #386).
 *
 * With genie-host it is the host's, over the link: the window reads its view, asks it to leave, and never touches the
 * runtime files — the marker is the host's to read and write.
 *
 * On the EMERGENCY NO-HOST PATH (the host could not start, so this window runs the agents, flows, scheduled tasks, kept
 * processes, sites and engines itself) the window IS the run: it opens the same runtime files the host would
 * (safe-mode-host.ts), so a host that keeps crashing does not fall back into a window that starts everything; it beats;
 * and its own clean end writes the clean-exit marker (`endCleanly`), after its quit has run.
 */
export class WindowSafeMode {
    readonly #link: LinkSafeMode | null;
    readonly #own: SafeMode | null;

    private constructor(link: LinkSafeMode | null, own: SafeMode | null) {
        this.#link = link;
        this.#own = own;
    }

    static open(p: { readonly link: LinkSafeMode | null; readonly runtimeDir: string; readonly log?: (line: string) => void; readonly now?: () => number; readonly pid?: number }): WindowSafeMode {
        if (p.link) return new WindowSafeMode(p.link, null);
        return new WindowSafeMode(null, SafeMode.open(p.runtimeDir, { ...(p.now ? { now: p.now } : {}), ...(p.pid !== undefined ? { pid: p.pid } : {}), ...(p.log ? { log: p.log } : {}) }));
    }

    active(): boolean {
        return this.view()?.active === true;
    }

    view(): SafeModeView | null {
        return this.#link ? this.#link.safeModeView() : this.#own!.view();
    }

    async leave(): Promise<SafeModeAnswer> {
        if (this.#link) return this.#link.leaveSafeMode();
        this.#own!.leave();
        return { ok: true };
    }

    onChange(listener: (view: SafeModeView) => void): () => void {
        return this.#link ? this.#link.onSafeMode(listener) : this.#own!.onChange(listener);
    }

    /** The window's own safe mode on the no-host path (to name what it held); `null` with a host. */
    own(): SafeMode | null {
        return this.#own;
    }

    /** No host: this window's sign of life, what the next start reads if it dies. With a host, the host beats. */
    beat(agents: readonly string[]): void {
        this.#own?.beat(agents);
    }

    /** No host: the clean-exit marker, the last thing this window's quit does. With a host: nothing (the host writes it). */
    endCleanly(reason: string): void {
        this.#own?.writeCleanExit(reason);
    }
}
