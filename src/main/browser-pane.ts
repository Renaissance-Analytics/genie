import { classifyNavigation } from '../core/browser-policy.js';
import type { GenRoute } from '../core/gen-router.js';

/**
 * THE GENIE BROWSER'S PANE — the main-process half.
 *
 * A WebContentsView positioned over the box the renderer draws, navigated only through the browser
 * policy (`core/browser-policy.ts`): a `.gen` name loads at ITS OWN origin, `https://<name>.gen/…`
 * (S7 — the session routes and trusts it, `electron-browser-view.ts`), so two sites never share a
 * cookie jar; refused schemes never reach the view; with no url the view is HIDDEN rather than left
 * showing a stale page. Back, forward and reload are the view's own history. What the view reports
 * after any navigation (a link, a redirect, back) is the address — the pane does not guess it.
 * The Electron view sits behind `ViewPort` so the logic is tested with a fake and the Electron
 * wiring is a thin adapter.
 */

export interface ViewHistory {
    readonly url: string;
    readonly canGoBack: boolean;
    readonly canGoForward: boolean;
}

export interface ViewPort {
    loadURL(url: string): Promise<void>;
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
    setVisible(visible: boolean): void;
    goBack(): void;
    goForward(): void;
    reload(): void;
    /** Every committed navigation (did-navigate / did-navigate-in-page in Electron), with the history around it. */
    onNavigated(listener: (state: ViewHistory) => void): () => void;
}

/**
 * A ViewPort that creates the real view on the FIRST loadURL and not before.
 *
 * CI's real-window smokes attach to the first `type: "page"` CDP target; a WebContentsView created at
 * boot is a second page target (about:blank) that can be found first — PR #43's smoke hung on it for
 * five minutes. Bounds and visibility set before creation are kept and applied on it; history calls
 * before creation have no history to act on and do nothing.
 */
export function lazyViewPort(create: () => ViewPort): ViewPort {
    let view: ViewPort | null = null;
    let bounds: { x: number; y: number; width: number; height: number } | null = null;
    let visible: boolean | null = null;
    const listeners = new Set<(state: ViewHistory) => void>();
    const ensure = (): ViewPort => {
        if (view) return view;
        view = create();
        if (bounds) view.setBounds(bounds);
        if (visible !== null) view.setVisible(visible);
        view.onNavigated((state) => { for (const l of listeners) l(state); });
        return view;
    };
    return {
        loadURL: (url) => ensure().loadURL(url),
        setBounds: (b) => { bounds = b; view?.setBounds(b); },
        setVisible: (v) => { visible = v; view?.setVisible(v); },
        goBack: () => view?.goBack(),
        goForward: () => view?.goForward(),
        reload: () => view?.reload(),
        onNavigated: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
}

export interface PaneState {
    readonly url: string | null;
    readonly canGoBack: boolean;
    readonly canGoForward: boolean;
}

export class BrowserPane {
    readonly #view: ViewPort;
    readonly #routes: () => readonly GenRoute[];
    #state: PaneState = { url: null, canGoBack: false, canGoForward: false };
    readonly #listeners = new Set<(state: PaneState) => void>();
    /** How many navigations the view has reported. */
    #reports = 0;

    constructor(view: ViewPort, routes: () => readonly GenRoute[]) {
        this.#view = view;
        this.#routes = routes;
        view.onNavigated((s) => {
            this.#reports += 1;
            this.#set({ url: s.url, canGoBack: s.canGoBack, canGoForward: s.canGoForward });
        });
    }

    /** Navigate per policy. The answer carries the URL loaded — for a site, its own https origin. */
    async show(input: string): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
        const nav = classifyNavigation(input, this.#routes());
        if (nav.kind === 'refused') return { ok: false, reason: nav.reason };
        if (nav.kind === 'no-site') return { ok: false, reason: `nothing is serving ${nav.host}` };
        const seen = this.#reports;
        await this.#view.loadURL(nav.url);
        this.#view.setVisible(true);
        // The view's own report wins (a redirect lands elsewhere); only a view that reported nothing gets the asked URL.
        if (this.#reports === seen) this.#set({ ...this.#state, url: nav.url });
        return { ok: true, url: nav.url };
    }

    back(): void {
        if (this.#state.canGoBack) this.#view.goBack();
    }

    forward(): void {
        if (this.#state.canGoForward) this.#view.goForward();
    }

    reload(): void {
        if (this.#state.url !== null) this.#view.reload();
    }

    setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
        this.#view.setBounds(bounds);
    }

    hide(): void {
        this.#view.setVisible(false);
        this.#set({ url: null, canGoBack: false, canGoForward: false });
    }

    current(): string | null {
        return this.#state.url;
    }

    state(): PaneState {
        return this.#state;
    }

    onChange(listener: (state: PaneState) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #set(next: PaneState): void {
        const s = this.#state;
        if (s.url === next.url && s.canGoBack === next.canGoBack && s.canGoForward === next.canGoForward) return;
        this.#state = next;
        for (const l of this.#listeners) l(next);
    }
}
