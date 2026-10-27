/**
 * THE GENIE BROWSER'S RULES (beta.35 item 36; the owner, 2026-10-21: "The Genie 1 browser was damn near perfect … it's
 * its own window"; FTQ q_227d0bb6: Genie sites ONLY). Genie 1's main/testing-browser/chrome.ts, ported as it was — the
 * device presets, the address rule, the first page — plus the tab model the window runs on (Genie 1 kept it inside its
 * window module; here it is pure, so the window is only wiring). Display-independent: no Electron in this file.
 */

/** A device preset of the toolbar. `width`/`height` are the PAGE's (the view's bounds), not the window's. */
export interface DevicePreset {
    readonly id: string;
    readonly label: string;
    /** `null` = Fit: the page fills what the toolbar leaves. */
    readonly width: number | null;
    readonly height: number | null;
}

/** Genie 1's presets, in its order and words. */
export const DEVICE_PRESETS: readonly DevicePreset[] = [
    { id: 'fit', label: 'Fit', width: null, height: null },
    { id: 'desktop', label: 'Desktop 1280', width: 1280, height: 800 },
    { id: 'laptop', label: 'Laptop 1024', width: 1024, height: 768 },
    { id: 'tablet', label: 'Tablet 768', width: 768, height: 1024 },
    { id: 'mobile', label: 'Mobile 390', width: 390, height: 844 },
];

/** A preset by id; an unknown id is Fit. */
export function devicePreset(id: string): DevicePreset {
    return DEVICE_PRESETS.find((p) => p.id === id) ?? DEVICE_PRESETS[0]!;
}

/**
 * THE ADDRESS BAR: what was typed, as `https://<site>.gen/…` — a Genie site this workstation serves, or refused in Genie
 * 1's words. Takes `tynn.gen`, `https://tynn.gen/path`, `http://tynn.gen` (made https — `.gen` is https only) and a bare
 * `tynn` when tynn.gen is served. The open web is refused like any other host: this browser is for Genie's sites.
 */
export function normalizeNavUrl(input: string, enabledHosts: ReadonlySet<string>): { url: string } | { error: string } {
    const raw = (input ?? '').trim();
    if (!raw) return { error: 'Enter an enabled development address.' };
    const candidate = /^[a-z0-9-]+$/i.test(raw) ? `${raw.toLowerCase()}.gen` : raw;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
    let u: URL;
    try {
        u = new URL(withScheme);
    } catch {
        return { error: 'That is not a valid address.' };
    }
    const host = u.hostname.toLowerCase();
    if (!enabledHosts.has(host)) return { error: `${host} is not an enabled tunnel on this host.` };
    return { url: `https://${host}${u.pathname}${u.search}${u.hash}` };
}

/** The first page: the first site served, else `null` (the window shows its empty state, the sites as chips). */
export function initialGenUrl(enabledGenHosts: readonly string[]): string | null {
    const first = enabledGenHosts[0];
    return first ? `https://${first}/` : null;
}

/**
 * SECURE-ONLY TRAFFIC (Genie 1 site-view.ts): every request a page makes goes through this — its own scripts, sockets,
 * images — not just what is typed. https and wss, and the schemes Chromium uses for what a page makes itself (about:,
 * data:, blob:, devtools); everything else (`http`, `ws`, `file`, …) and anything that does not parse is cancelled.
 */
const SECURE_BROWSER_SCHEMES: ReadonlySet<string> = new Set(['https:', 'wss:', 'about:', 'data:', 'blob:', 'filesystem:', 'devtools:', 'chrome:', 'chrome-extension:', 'chrome-devtools:']);

export function isSecureBrowserUrl(url: string): boolean {
    try {
        return SECURE_BROWSER_SCHEMES.has(new URL(url).protocol.toLowerCase());
    } catch {
        return false;
    }
}

/** One tab of the window: its page as the view last reported it. */
export interface BrowserTab {
    readonly id: string;
    readonly url: string;
    readonly title: string | null;
    readonly loading: boolean;
    readonly canGoBack: boolean;
    readonly canGoForward: boolean;
    /** Why the last load failed, in words; `null` when it did not. */
    readonly error: string | null;
}

export interface BrowserState {
    readonly tabs: readonly BrowserTab[];
    readonly active: string | null;
}

export const EMPTY_BROWSER: BrowserState = { tabs: [], active: null };

export type BrowserAction =
    /** A new tab, active, beside the active one (an address typed into +, or a page's `_blank` — Genie 1: a tab). */
    /** `background`: an agent's open (genie#1265) — the tab is made beside the active one, which stays in front. */
    | { readonly kind: 'open'; readonly id: string; readonly url: string; readonly background?: boolean }
    | { readonly kind: 'activate'; readonly id: string }
    | { readonly kind: 'close'; readonly id: string }
    | { readonly kind: 'loading'; readonly id: string }
    | { readonly kind: 'loaded'; readonly id: string }
    | { readonly kind: 'navigated'; readonly id: string; readonly url: string; readonly title: string | null; readonly canGoBack: boolean; readonly canGoForward: boolean }
    | { readonly kind: 'failed'; readonly id: string; readonly url: string; readonly description: string };

/** The window's tabs after `action`. An action for a tab that is not there returns `state` itself. */
export function browserReduce(state: BrowserState, action: BrowserAction): BrowserState {
    if (action.kind === 'open') {
        const tab: BrowserTab = { id: action.id, url: action.url, title: null, loading: true, canGoBack: false, canGoForward: false, error: null };
        const at = state.tabs.findIndex((t) => t.id === state.active);
        const tabs = at < 0 ? [...state.tabs, tab] : [...state.tabs.slice(0, at + 1), tab, ...state.tabs.slice(at + 1)];
        // A background open leaves the person's tab in front; with no tab at all, the new one is the only thing to show.
        return { tabs, active: action.background === true && state.active !== null ? state.active : tab.id };
    }
    const at = state.tabs.findIndex((t) => t.id === action.id);
    if (at < 0) return state;
    if (action.kind === 'activate') return state.active === action.id ? state : { ...state, active: action.id };
    if (action.kind === 'close') {
        const tabs = state.tabs.filter((t) => t.id !== action.id);
        if (tabs.length === 0) return EMPTY_BROWSER;
        // The closed tab's right neighbour (now at its index), else its left.
        const active = state.active === action.id ? tabs[Math.min(at, tabs.length - 1)]!.id : state.active;
        return { tabs, active };
    }
    const change = (patch: Partial<BrowserTab>): BrowserState => ({ ...state, tabs: state.tabs.map((t, i) => (i === at ? { ...t, ...patch } : t)) });
    switch (action.kind) {
        case 'loading':
            return change({ loading: true, error: null });
        case 'loaded':
            return change({ loading: false });
        case 'navigated':
            return change({ url: action.url, title: action.title, canGoBack: action.canGoBack, canGoForward: action.canGoForward });
        case 'failed':
            return change({ loading: false, error: `Couldn't load ${action.url} (${action.description}).` });
    }
}
