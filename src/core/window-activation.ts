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

/** The slice of a NEW Electron BrowserWindow that `onceShowable` listens on. */
export interface FirstShowWindow {
    once(event: 'ready-to-show', listener: () => void): unknown;
    readonly webContents: { once(event: 'did-finish-load', listener: () => void): unknown };
}

/**
 * WHEN A NEW WINDOW IS SHOWN (genie#1370). A window is created hidden and shown on its first paint (`ready-to-show`),
 * so the person never sees an empty frame. That works on Windows, macOS and X11. It does not work on native Wayland
 * (Omarchy's Hyprland, Electron's default there): the compositor sends frame callbacks only to a mapped surface, so a
 * hidden window gets no frames. A page that draws after load (React into an empty root, as every Genie page does)
 * never makes its first visually non-empty paint, and `ready-to-show` never fires. Measured on omarchy-test: the page
 * loaded, the window stayed hidden, and a `showInactive()` made it paint at once.
 *
 * So on Linux the window is shown at whichever comes first, `ready-to-show` or the page's load. On X11 the two come a
 * millisecond apart; on Wayland only the load comes. Other platforms keep waiting for the paint. `show` runs once.
 */
export function onceShowable(win: FirstShowWindow, platform: NodeJS.Platform, show: () => void): void {
    let shown = false;
    const first = (): void => {
        if (shown) return;
        shown = true;
        show();
    };
    win.once('ready-to-show', first);
    if (platform === 'linux') win.webContents.once('did-finish-load', first);
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
    if (hash.startsWith('genie://flow/')) return 'flow';
    if (/(^|&)remote=/.test(query)) return 'remote';
    if (page.endsWith('/index.html')) return 'main';
    return 'unknown';
}

/** How long after `show()` a new window's first focus may take before the trace says the compositor never showed it. */
export const FIRST_SHOW_FOCUS_MS = 10_000;

export type FirstShowStep = 'did-finish-load' | 'ready-to-show' | 'focus';

/**
 * A NEW WINDOW'S FIRST SHOW, EACH STEP TIMED (Tynn #1032). On Linux CI a terminal "dropped" typed input in 4 of 39
 * smoke runs: the keys reached the shell and were echoed, xterm's buffer held them, and its rows never drew them. In
 * all four, and in none of the 35 passes, the main window never took focus at launch. On Wayland a window the
 * compositor has not shown gets no frames (genie#1370), so everything drawn on a frame (xterm's renderer, anything on
 * requestAnimationFrame) stops, while the page, its DOM and its input carry on, and nothing said so.
 *
 * So each step of the first show is logged with its time since the window was made (the load, the paint, `show()` and
 * the event that called it, the first focus), and a window shown and NOT focused within `FIRST_SHOW_FOCUS_MS` is said
 * once. Only the first of each step: a reload's load or a later focus is not the first show.
 */
export class FirstShowTrace {
    readonly #label: string;
    readonly #madeAt: number;
    readonly #log: (line: string) => void;
    readonly #seen = new Set<string>();
    #shownAt: number | null = null;
    #shownOn: string | null = null;
    #focused = false;
    #reported = false;

    constructor(label: string, madeAt: number, log: (line: string) => void) {
        this.#label = label;
        this.#madeAt = madeAt;
        this.#log = log;
    }

    #say(text: string): void {
        this.#log(`[genie] window ${this.#label}: ${text}`);
    }

    note(step: FirstShowStep, now: number): void {
        if (this.#seen.has(step)) return;
        this.#seen.add(step);
        if (step === 'focus') {
            this.#focused = true;
            const after = this.#shownAt === null ? '' : ` (${now - this.#shownAt} ms after show())`;
            this.#say(`focus at +${now - this.#madeAt} ms${after}`);
            return;
        }
        this.#say(`${step} at +${now - this.#madeAt} ms`);
    }

    /** `show()` (or `showInactive()`) was called, by the event that made the window showable. */
    shown(on: string, now: number): void {
        if (this.#shownAt !== null) return;
        this.#shownAt = now;
        this.#shownOn = on;
        this.#say(`show() at +${now - this.#madeAt} ms, on ${on}`);
    }

    /** Called on a timer: says, once, that a shown window never took focus. */
    check(now: number): void {
        if (this.#reported || this.#focused || this.#shownAt === null) return;
        if (now - this.#shownAt < FIRST_SHOW_FOCUS_MS) return;
        this.#reported = true;
        this.#say(`NOT FOCUSED ${FIRST_SHOW_FOCUS_MS} ms after show() (on ${this.#shownOn}): the compositor has not shown it, and a window it does not show gets no frames (Tynn #1032)`);
    }

    /** Nothing more to say: focused, or reported. */
    get done(): boolean {
        return this.#focused || this.#reported;
    }
}
