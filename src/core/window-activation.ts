/**
 * GENIE NEVER TAKES THE KEYBOARD ON ITS OWN (genie#1235; the owner, 2026-10-26: "the most annoying thing ever").
 *
 * A window is shown active, raised, restored or focused ONLY as the direct result of a gesture the person made in Genie:
 * the tray, a menu, a Genie notification clicked, a button or a link they pressed. That is `user-gesture`. Everything
 * else — an agent's tool call, a job finishing, a page script, a timer — is `background`: it may navigate a window, and
 * it may flash a taskbar button the person is not looking at, and nothing more. A NEW window opened in the background
 * paints with `showInactive()`; `show()` activates.
 *
 * Main puts a window in front through `bringUp` / `showWhenReady` and nothing else (window-activation-wiring.test.ts
 * holds src/main to that), so every request is in the ledger, and every focus Electron reports can be pinned on one.
 */

export type Activation = 'user-gesture' | 'background';

/** The slice of an Electron BrowserWindow the rule touches. */
export interface ActivatableWindow {
    isDestroyed(): boolean;
    isMinimized(): boolean;
    isVisible(): boolean;
    isFocused(): boolean;
    restore(): void;
    show(): void;
    showInactive(): void;
    focus(): void;
    flashFrame(flag: boolean): void;
}

export interface ActivationRequest {
    readonly activation: Activation;
    /** What asked, in words a log reader can find in the code: `tray: Open`, `openFileForUser`, `sites open (agent)`. */
    readonly reason: string;
    /** Where the request is recorded for the focus diagnostic. */
    readonly ledger?: ActivationLedger;
    /** Which window (`windowLabelOf`); defaults to `window`. */
    readonly label?: string;
    readonly now?: number;
}

function record(request: ActivationRequest): void {
    request.ledger?.note({ reason: request.reason, activation: request.activation, label: request.label ?? 'window', at: request.now ?? Date.now() });
}

/**
 * An EXISTING window, asked for. The person's gesture: restored, shown (from the tray too), focused. Background: never
 * restored, shown or focused — its taskbar button flashes if the person is not in it, which takes nothing from them.
 */
export function bringUp(win: ActivatableWindow, request: ActivationRequest): void {
    if (win.isDestroyed()) return;
    record(request);
    if (request.activation === 'user-gesture') {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        return;
    }
    if (!win.isFocused()) win.flashFrame(true);
}

/** A NEW window's first paint (`ready-to-show`): active for the person's gesture, `showInactive()` for anything else. */
export function showWhenReady(win: ActivatableWindow, request: ActivationRequest): void {
    if (win.isDestroyed()) return;
    record(request);
    if (request.activation === 'user-gesture') win.show();
    else win.showInactive();
}

export interface ActivationEntry {
    readonly reason: string;
    readonly activation: Activation;
    readonly label: string;
    readonly at: number;
}

/** How long after a request a focus is still put down to it. */
export const FOCUS_WINDOW_MS = 2000;

/**
 * THE FOCUS DIAGNOSTIC: the latest activation request, so main's `browser-window-focus` can log which window took the
 * keyboard and what asked for it — or that nothing in Genie did, which points at the person, the OS, or a path that
 * went round `bringUp` (a new one is a bug: add it here).
 */
export class ActivationLedger {
    #last: ActivationEntry | null = null;

    note(entry: ActivationEntry): void {
        this.#last = entry;
    }

    last(): ActivationEntry | null {
        return this.#last;
    }

    explain(label: string, now: number): string {
        const last = this.#last;
        const head = `[genie] focus: ${label} took focus`;
        if (last === null || now - last.at > FOCUS_WINDOW_MS || now < last.at) {
            return `${head} — no Genie request in the last ${FOCUS_WINDOW_MS} ms (the person clicked or alt-tabbed, the OS, or an unrecorded path)`;
        }
        const said = `${head} — ${now - last.at} ms after Genie asked: ${last.reason} (${last.activation}, ${last.label})`;
        return last.activation === 'background' ? `${said} — a background request must never focus (genie#1235)` : said;
    }
}

/** Which Genie window a URL is, for the log: main, remote, takeover, login, files, question, browser, doctor. */
export function windowLabelOf(url: string): string {
    if (url === '') return 'unknown';
    const hashAt = url.indexOf('#');
    const hash = hashAt >= 0 ? url.slice(hashAt + 1) : '';
    const page = (hashAt >= 0 ? url.slice(0, hashAt) : url).split('?')[0] ?? '';
    const query = hashAt >= 0 ? url.slice(0, hashAt).split('?')[1] ?? '' : url.split('?')[1] ?? '';
    if (page.endsWith('/question.html')) return 'question';
    if (page.endsWith('/browser.html')) return 'browser';
    if (page.endsWith('/doctor.html')) return 'doctor';
    if (hash.startsWith('genie://takeover/')) return hash.includes('?login=') ? 'login' : 'takeover';
    if (hash.startsWith('genie://files/')) return 'files';
    if (/(^|&)remote=/.test(query)) return 'remote';
    if (page.endsWith('/index.html')) return 'main';
    return 'unknown';
}
