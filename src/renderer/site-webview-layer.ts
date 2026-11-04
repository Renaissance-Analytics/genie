import { SitePanelViews, type Bounds, type PanelViewPort } from '../core/site-panel-views.js';
import type { SiteState } from './components/SingleSiteBar.js';

/**
 * THE LAYER THE PANELS' PAGES LIVE IN (the host split, P2b). A site panel is a <webview>, and moving one in the DOM reloads
 * it (measured on Electron 45.2.2, `moveBefore` too), while a panel's page must survive its tab being off screen. So a page
 * is a stable element in this one layer, placed over the panel's box, hidden and shown, never moved. A different site is a
 * new element, because main decides at attach and the renderer never changes where a page points.
 */

export type Prepared = { readonly ok: true } | { readonly ok: false; readonly error: string; readonly locked?: boolean };
/** Why a panel shows no page. */
export type Refused = { readonly error: string; readonly locked?: boolean };

interface LayerDocument {
    readonly body: { appendChild(child: never): unknown };
    createElement(tag: string): unknown;
}

interface LayerElement {
    readonly style: Record<string, string> | CSSStyleDeclaration;
    setAttribute(name: string, value: string): void;
    appendChild(child: never): unknown;
    remove(): void;
    reload?(): void;
    goBack?(): void;
    goForward?(): void;
    canGoBack?(): boolean;
    canGoForward?(): boolean;
    addEventListener?(event: string, listener: () => void): void;
}

export interface SiteWebviewLayer {
    show(panelKey: string, host: string, bounds: Bounds): Promise<Prepared>;
    hide(panelKey: string): void;
    reload(panelKey: string): void;
    back(panelKey: string): void;
    forward(panelKey: string): void;
    /** What the panel's page can do, as it changes. Answers the leaving function. */
    onState(panelKey: string, listener: (state: SiteState) => void): () => void;
    retainIn(workspaceId: string, keep: ReadonlySet<string>): void;
    /** Its site is out in its own window, or back: out, its page closes, and a show makes none. */
    setPopped(panelKey: string, out: boolean): void;
    isPopped(panelKey: string): boolean;
    /** Why this panel shows no page, or null once it does. Answers the leaving function. */
    onRefused(panelKey: string, listener: (why: Refused | null) => void): () => void;
    onPopped(panelKey: string, listener: (out: boolean) => void): () => void;
}

export function siteWebviewLayer(options: { readonly doc: LayerDocument; readonly prepare: (host: string) => Promise<Prepared> }): SiteWebviewLayer {
    const allowed = new Set<string>();
    /** The latest ask per panel: a show main answers after the panel left, or after a newer show, does nothing. */
    const tickets = new Map<string, number>();
    const ticket = (panelKey: string): number => { const next = (tickets.get(panelKey) ?? 0) + 1; tickets.set(panelKey, next); return next; };
    let layer: LayerElement | null = null;
    const root = (): LayerElement => {
        if (layer === null) {
            layer = options.doc.createElement('div') as LayerElement;
            Object.assign(layer.style, { position: 'fixed', left: '0', top: '0', width: '0', height: '0', zIndex: '10' });
            options.doc.body.appendChild(layer as never);
        }
        return layer;
    };

    const listeners = new Map<string, Set<(state: SiteState) => void>>();
    const popped = new Set<string>();
    const refusedListeners = new Map<string, Set<(why: Refused | null) => void>>();
    const refused = (panelKey: string, why: Refused | null): void => { for (const listener of [...(refusedListeners.get(panelKey) ?? [])]) listener(why); };
    const poppedListeners = new Map<string, Set<(out: boolean) => void>>();
    const pages = new Map<string, { back(): void; forward(): void }>();
    const safely = (fn: (() => void) | undefined): void => { try { fn?.(); } catch { /* Electron throws until the page's dom-ready */ } };

    const createView = (panelKey: string): PanelViewPort => {
        let element: LayerElement | null = null;
        let loading = false;
        const report = (page: LayerElement) => {
            if (page !== element) return;
            let canGoBack = false;
            let canGoForward = false;
            try { canGoBack = page.canGoBack?.() === true; canGoForward = page.canGoForward?.() === true; } catch { /* not ready */ }
            for (const listener of [...(listeners.get(panelKey) ?? [])]) listener({ canGoBack, canGoForward, loading });
        };
        pages.set(panelKey, {
            back: () => safely(() => element?.goBack?.()),
            forward: () => safely(() => element?.goForward?.()),
        });
        let box: Bounds = { x: 0, y: 0, width: 0, height: 0 };
        let visible = 'hidden';
        const place = () => {
            if (element === null) return;
            Object.assign(element.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px`, visibility: visible });
        };
        return {
            load(url) {
                element?.remove();
                element = options.doc.createElement('webview') as LayerElement;
                Object.assign(element.style, { position: 'fixed', border: '0' });
                element.setAttribute('src', url);
                const page = element;
                loading = false;
                page.addEventListener?.('did-start-loading', () => { loading = true; report(page); });
                page.addEventListener?.('did-stop-loading', () => { loading = false; report(page); });
                page.addEventListener?.('did-navigate', () => report(page));
                page.addEventListener?.('did-navigate-in-page', () => report(page));
                place();
                root().appendChild(element as never);
            },
            reload() { safely(() => element?.reload?.()); },
            setBounds(bounds) { box = bounds; place(); },
            setVisible(value) { visible = value ? 'visible' : 'hidden'; place(); },
            destroy() { element?.remove(); element = null; pages.delete(panelKey); },
        };
    };
    const views = new SitePanelViews({ enabledHosts: () => [...allowed], createView });

    return {
        async show(panelKey, host, bounds) {
            const mine = ticket(panelKey);
            if (popped.has(panelKey)) return { ok: true };
            const prepared = await options.prepare(host);
            if (tickets.get(panelKey) !== mine) return { ok: true };
            if (!prepared.ok) {
                allowed.delete(host.toLowerCase());
                views.remove(panelKey);
                refused(panelKey, prepared.locked ? { error: prepared.error, locked: true } : { error: prepared.error });
                return prepared;
            }
            allowed.add(host.toLowerCase());
            refused(panelKey, null);
            return views.show(panelKey, host, bounds);
        },
        hide(panelKey) { ticket(panelKey); views.hide(panelKey); },
        reload(panelKey) { views.reload(panelKey); },
        back(panelKey) { pages.get(panelKey)?.back(); },
        forward(panelKey) { pages.get(panelKey)?.forward(); },
        onState(panelKey, listener) {
            const set = listeners.get(panelKey) ?? new Set();
            listeners.set(panelKey, set);
            set.add(listener);
            return () => { set.delete(listener); };
        },
        retainIn(workspaceId, keep) { views.retainIn(workspaceId, keep); },
        setPopped(panelKey, out) {
            if (out === popped.has(panelKey)) return;
            ticket(panelKey);
            if (out) { popped.add(panelKey); views.remove(panelKey); } else popped.delete(panelKey);
            for (const listener of [...(poppedListeners.get(panelKey) ?? [])]) listener(out);
        },
        isPopped(panelKey) { return popped.has(panelKey); },
        onRefused(panelKey, listener) {
            const set = refusedListeners.get(panelKey) ?? new Set();
            refusedListeners.set(panelKey, set);
            set.add(listener);
            return () => { set.delete(listener); };
        },
        onPopped(panelKey, listener) {
            const set = poppedListeners.get(panelKey) ?? new Set();
            poppedListeners.set(panelKey, set);
            set.add(listener);
            return () => { set.delete(listener); };
        },
    };
}

export interface SeenTabs {
    readonly workspaceId: string;
    readonly raw: unknown;
}

/**
 * Whether a workspace's tabs really changed, so a panel gone from them may close. Workspace mounts again before its settings
 * arrive, and "no tabs yet" must not close every page (batch SS on omarchy-test). A panel removed while its Workspace wasn't
 * mounted stays hidden until the next change: a cost of nothing.
 */
export function tabsChanged(before: SeenTabs | null, now: SeenTabs): boolean {
    return before !== null && typeof now.raw === 'string' && before.workspaceId === now.workspaceId && before.raw !== now.raw;
}

const layers = new WeakMap<object, SiteWebviewLayer>();

/** One layer per bridge: a Workspace mounting again finds the pages it left. */
export function siteWebviewLayerFor(bridge: { prepare(host: string): Promise<Prepared>; popped(): Promise<ReadonlyArray<{ readonly panelKey: string }>>; onPoppedBack(listener: (panelKey: string) => void): () => void }): SiteWebviewLayer {
    let found = layers.get(bridge);
    if (!found) {
        found = siteWebviewLayer({ doc: document as unknown as LayerDocument, prepare: (host) => bridge.prepare(host) });
        layers.set(bridge, found);
        const layer = found;
        bridge.onPoppedBack((panelKey) => layer.setPopped(panelKey, false));
        void bridge.popped().then((list) => { for (const { panelKey } of list) layer.setPopped(panelKey, true); }, () => {});
    }
    return found;
}
