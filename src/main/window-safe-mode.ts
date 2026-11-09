import type { SafeModeView } from '../core/safe-mode.js';

export type SafeModeAnswer = { ok: true } | { ok: false; reason: string };

/** What the window reads of genie-host's safe mode over the link (session-engine-client.ts). */
export interface LinkSafeMode {
    safeModeView(): SafeModeView | null;
    leaveSafeMode(): Promise<SafeModeAnswer>;
    onSafeMode(listener: (view: SafeModeView) => void): () => void;
}

/**
 * SAFE MODE AS THE WINDOW READS IT (Tynn #386). It is genie-host's, over the link: the window reads its view, asks it to
 * leave, and never touches the runtime files, which are the host's to read and write (Tynn #415: the window has no safe
 * mode of its own, because it runs nothing of its own).
 */
export class WindowSafeMode {
    readonly #link: LinkSafeMode;

    private constructor(link: LinkSafeMode) {
        this.#link = link;
    }

    static open(p: { readonly link: LinkSafeMode }): WindowSafeMode {
        return new WindowSafeMode(p.link);
    }

    active(): boolean {
        return this.view()?.active === true;
    }

    view(): SafeModeView | null {
        return this.#link.safeModeView();
    }

    leave(): Promise<SafeModeAnswer> {
        return this.#link.leaveSafeMode();
    }

    onChange(listener: (view: SafeModeView) => void): () => void {
        return this.#link.onSafeMode(listener);
    }
}
