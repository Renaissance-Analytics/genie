/**
 * STARTING GENIE'S HOST, SAID (Tynn #700). Measured on the Azure Windows gate, a fresh home: genie-host took 20 s to serve
 * its pipe, and the window, which makes its main window only once it is linked, showed nothing meanwhile. A start that
 * takes longer than HOST_WAIT_SHOW_AFTER_MS shows a small window that says Genie's host is starting and how long it has
 * been; it closes as soon as the link is up, or the host is known to have failed.
 */
export const HOST_WAIT_SHOW_AFTER_MS = 1_500;

export function hostWaitWords(elapsedMs: number): { readonly title: string; readonly detail: string } {
    return { title: 'Starting Genie’s host…', detail: `The first start can take a minute. ${Math.floor(elapsedMs / 1000)} s so far.` };
}

export interface HostWaitPorts {
    open(title: string, detail: string): void;
    update(detail: string): void;
    close(): void;
}

/** The wait's state: nothing for a quick start; opened once it is slow, updated, and closed once. Never throws into the link. */
export class HostWait {
    readonly #ports: HostWaitPorts;
    readonly #showAfterMs: number;
    #shown = false;
    #done = false;

    constructor(ports: HostWaitPorts, options: { readonly showAfterMs?: number } = {}) {
        this.#ports = ports;
        this.#showAfterMs = options.showAfterMs ?? HOST_WAIT_SHOW_AFTER_MS;
    }

    progress(elapsedMs: number): void {
        if (this.#done || elapsedMs < this.#showAfterMs) return;
        const words = hostWaitWords(elapsedMs);
        try {
            if (!this.#shown) { this.#shown = true; this.#ports.open(words.title, words.detail); }
            else this.#ports.update(words.detail);
        } catch { /* a wait that cannot be drawn must not stop the host being reached */ }
    }

    done(): void {
        if (this.#done) return;
        this.#done = true;
        if (!this.#shown) return;
        try { this.#ports.close(); } catch { /* already gone */ }
    }
}

/** The wait as a page: plain words, no controls (a window that only says what is happening). */
export function hostWaitPage(title: string, detail: string): string {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    return `<!doctype html><meta charset="utf-8"><title>Genie</title><body style="margin:0;font:14px system-ui,sans-serif;background:#111;color:#eee;display:flex;flex-direction:column;justify-content:center;height:100vh;padding:0 24px"><p style="margin:0 0 6px;font-weight:600" role="status">${esc(title)}</p><p id="detail" style="margin:0;color:#aaa">${esc(detail)}</p></body>`;
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
