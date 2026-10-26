import { browserReduce, devicePreset, DEVICE_PRESETS, EMPTY_BROWSER, initialGenUrl, normalizeNavUrl, type BrowserAction, type BrowserState, type BrowserTab } from '../core/genie-browser.js';

/**
 * THE GENIE BROWSER WINDOW'S BRAIN (beta.35 item 36, step 1 — Genie 1's main/testing-browser/index.ts, ported). The
 * window owns its tabs: one view per tab, the active one shown and the rest hidden, sized into the page area the chrome
 * reports by the device preset (Fit fills it; a device is a fixed viewport pinned to its corner, cut to it). Every
 * address — typed, or a page's new window — goes through the Genie-sites rule (core/genie-browser.ts), read at each
 * use, so a site served after the window opened can be visited. A page's new window becomes a tab beside it (Genie 1);
 * anything else it asks to open is not opened. Every change is pushed whole to the chrome.
 *
 * The Electron views sit behind {@link TabViewPort}; this file is tested with fakes (test/genie-browser-window.test.ts).
 */

export interface Bounds {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** One tab's page (an Electron WebContentsView in the real window). */
export interface TabViewPort {
    load(url: string): void;
    back(): void;
    forward(): void;
    reload(): void;
    setBounds(bounds: Bounds): void;
    setVisible(visible: boolean): void;
    /** Off the window and its page closed. */
    destroy(): void;
}

/** What a tab's page reports (Electron's did-navigate, page-title-updated, did-start/stop-loading, did-fail-load, window open). */
export interface TabViewEvents {
    navigated(url: string, canGoBack: boolean, canGoForward: boolean): void;
    title(title: string): void;
    loading(): void;
    loaded(): void;
    failed(code: number, description: string, url: string, isMainFrame: boolean): void;
    /** The page asked for a new window (`target=_blank`, `window.open`): never a window — a tab, for a Genie site. */
    openWindow(url: string): void;
}

/** What the chrome draws from. */
export interface BrowserSnapshot extends BrowserState {
    readonly presetId: string;
    readonly presets: ReadonlyArray<{ readonly id: string; readonly label: string }>;
    /** The Genie sites this window can open — the chrome's row of chips and its empty state. */
    readonly sites: readonly string[];
}

export interface GenieBrowserPorts {
    /** The `.gen` hosts this workstation serves, now. */
    readonly enabledHosts: () => readonly string[];
    readonly newTabId: () => string;
    readonly createView: (tabId: string, events: TabViewEvents) => TabViewPort;
    readonly push: (snapshot: BrowserSnapshot) => void;
}

export type BrowserAnswer = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** A URL's host, lower-cased; `null` when it is not a URL. */
function hostOf(url: string): string | null {
    try {
        return new URL(url).host.toLowerCase();
    } catch {
        return null;
    }
}

/** Electron's ERR_ABORTED: a load replaced by another (a click during a load) — not a failure to show. */
const ABORTED = -3;

export class GenieBrowser {
    readonly #ports: GenieBrowserPorts;
    readonly #views = new Map<string, TabViewPort>();
    #state: BrowserState = EMPTY_BROWSER;
    #presetId = 'fit';
    #page: Bounds = { x: 0, y: 0, width: 0, height: 0 };

    constructor(ports: GenieBrowserPorts) {
        this.#ports = ports;
    }

    /** A new tab on `input`, active — or the rule's refusal, with nothing made. */
    open(input: string): BrowserAnswer {
        const nav = normalizeNavUrl(input, new Set(this.#ports.enabledHosts()));
        if ('error' in nav) return { ok: false, error: nav.error };
        this.#openTab(nav.url);
        return { ok: true };
    }

    /** +: a new tab on the first Genie site (Genie 1), or why there is none to open. */
    newTab(): BrowserAnswer {
        const first = initialGenUrl(this.#ports.enabledHosts());
        return first === null ? { ok: false, error: 'No Genie sites are being served.' } : this.open(first);
    }

    /**
     * A SITE CHIP (genie#1196): SHOW that site — the tab already on its host, shown and NOT loaded again (each tab is its
     * own view, with its own page and history, so it is exactly where the person left it) — or a new tab on it. The
     * active tab first when it is on that host. Never re-navigates the tab on screen: that is what lost the page of the
     * site the person came back to.
     */
    showSite(input: string): BrowserAnswer {
        const nav = normalizeNavUrl(input, new Set(this.#ports.enabledHosts()));
        if ('error' in nav) return { ok: false, error: nav.error };
        const host = hostOf(nav.url);
        const onHost = (t: BrowserTab) => host !== null && hostOf(t.url) === host;
        const active = this.#state.tabs.find((t) => t.id === this.#state.active);
        const tab = active && onHost(active) ? active : this.#state.tabs.find(onHost);
        if (tab) {
            if (tab.id !== this.#state.active) this.activate(tab.id);
            return { ok: true };
        }
        this.#openTab(nav.url);
        return { ok: true };
    }

    /** The address bar: the active tab goes to `input`; with no tab open, one is opened. */
    navigate(input: string): BrowserAnswer {
        const active = this.#state.active;
        if (active === null) return this.open(input);
        const nav = normalizeNavUrl(input, new Set(this.#ports.enabledHosts()));
        if ('error' in nav) return { ok: false, error: nav.error };
        this.#views.get(active)?.load(nav.url);
        return { ok: true };
    }

    back(): void {
        this.#activeView()?.back();
    }

    forward(): void {
        this.#activeView()?.forward();
    }

    reload(): void {
        this.#activeView()?.reload();
    }

    activate(id: string): void {
        this.#apply({ kind: 'activate', id });
    }

    close(id: string): void {
        const view = this.#views.get(id);
        if (!view) return;
        this.#views.delete(id);
        view.destroy();
        this.#apply({ kind: 'close', id });
    }

    /** Every tab closed — the window is going away. */
    closeAll(): void {
        for (const id of [...this.#views.keys()]) this.close(id);
    }

    setPreset(id: string): void {
        this.#presetId = devicePreset(id).id;
        this.#layout();
        this.#push();
    }

    /** The page area the chrome leaves (its ResizeObserver), in window pixels. */
    setPageBounds(bounds: Bounds): void {
        this.#page = { x: Math.max(0, Math.round(bounds.x)), y: Math.max(0, Math.round(bounds.y)), width: Math.max(0, Math.round(bounds.width)), height: Math.max(0, Math.round(bounds.height)) };
        this.#layout();
    }

    snapshot(): BrowserSnapshot {
        return { ...this.#state, presetId: this.#presetId, presets: DEVICE_PRESETS.map((p) => ({ id: p.id, label: p.label })), sites: [...this.#ports.enabledHosts()] };
    }

    #openTab(url: string): void {
        const id = this.#ports.newTabId();
        const view = this.#ports.createView(id, this.#events(id));
        this.#views.set(id, view);
        this.#apply({ kind: 'open', id, url });
        view.load(url);
    }

    #events(id: string): TabViewEvents {
        const tab = (): BrowserTab | undefined => this.#state.tabs.find((t) => t.id === id);
        return {
            navigated: (url, canGoBack, canGoForward) => this.#apply({ kind: 'navigated', id, url, title: tab()?.title ?? null, canGoBack, canGoForward }),
            title: (title) => {
                const t = tab();
                if (t) this.#apply({ kind: 'navigated', id, url: t.url, title, canGoBack: t.canGoBack, canGoForward: t.canGoForward });
            },
            loading: () => this.#apply({ kind: 'loading', id }),
            loaded: () => this.#apply({ kind: 'loaded', id }),
            failed: (code, description, url, isMainFrame) => {
                if (isMainFrame && code !== ABORTED) this.#apply({ kind: 'failed', id, url, description });
            },
            openWindow: (url) => {
                const nav = normalizeNavUrl(url, new Set(this.#ports.enabledHosts()));
                if ('url' in nav) this.#openTab(nav.url);
            },
        };
    }

    #apply(action: BrowserAction): void {
        const next = browserReduce(this.#state, action);
        if (next === this.#state) return;
        const activeChanged = next.active !== this.#state.active;
        this.#state = next;
        if (activeChanged) this.#layout();
        this.#push();
    }

    #activeView(): TabViewPort | undefined {
        return this.#state.active === null ? undefined : this.#views.get(this.#state.active);
    }

    /** The active view shown in the page area by the preset; every other hidden (Genie 1 `applyLayout`). */
    #layout(): void {
        const preset = devicePreset(this.#presetId);
        const page = this.#page;
        for (const [id, view] of this.#views) {
            const active = id === this.#state.active;
            view.setVisible(active);
            if (!active) continue;
            view.setBounds(preset.width === null || preset.height === null
                ? page
                : { x: page.x, y: page.y, width: Math.min(preset.width, page.width), height: Math.min(preset.height, page.height) });
        }
    }

    #push(): void {
        this.#ports.push(this.snapshot());
    }
}
