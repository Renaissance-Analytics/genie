import { SitePanelViews, type Bounds, type PanelViewPort } from '../core/site-panel-views.js';

/**
 * THE LAYER THE PANELS' PAGES LIVE IN (the host split, P2b). A site panel is a <webview>, and moving one in the DOM reloads
 * it (measured on Electron 45.2.2, `moveBefore` too), while a panel's page must survive its tab being off screen. So a page
 * is a stable element in this one layer, placed over the panel's box, hidden and shown, never moved. A different site is a
 * new element, because main decides at attach and the renderer never changes where a page points.
 */

export type Prepared = { readonly ok: true } | { readonly ok: false; readonly error: string };

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
}

export interface SiteWebviewLayer {
    show(panelKey: string, host: string, bounds: Bounds): Promise<Prepared>;
    hide(panelKey: string): void;
    reload(panelKey: string): void;
    retainIn(workspaceId: string, keep: ReadonlySet<string>): void;
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

    const createView = (): PanelViewPort => {
        let element: LayerElement | null = null;
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
                place();
                root().appendChild(element as never);
            },
            reload() {
                // Electron throws until the page's dom-ready; there is nothing to reload yet.
                try { element?.reload?.(); } catch { /* not ready */ }
            },
            setBounds(bounds) { box = bounds; place(); },
            setVisible(value) { visible = value ? 'visible' : 'hidden'; place(); },
            destroy() { element?.remove(); element = null; },
        };
    };
    const views = new SitePanelViews({ enabledHosts: () => [...allowed], createView });

    return {
        async show(panelKey, host, bounds) {
            const mine = ticket(panelKey);
            const prepared = await options.prepare(host);
            if (tickets.get(panelKey) !== mine) return { ok: true };
            if (!prepared.ok) {
                allowed.delete(host.toLowerCase());
                views.remove(panelKey);
                return prepared;
            }
            allowed.add(host.toLowerCase());
            return views.show(panelKey, host, bounds);
        },
        hide(panelKey) { ticket(panelKey); views.hide(panelKey); },
        reload(panelKey) { views.reload(panelKey); },
        retainIn(workspaceId, keep) { views.retainIn(workspaceId, keep); },
    };
}

const layers = new WeakMap<object, SiteWebviewLayer>();

/** One layer per bridge: a Workspace mounting again finds the pages it left. */
export function siteWebviewLayerFor(bridge: { prepare(host: string): Promise<Prepared> }): SiteWebviewLayer {
    let found = layers.get(bridge);
    if (!found) {
        found = siteWebviewLayer({ doc: document as unknown as LayerDocument, prepare: (host) => bridge.prepare(host) });
        layers.set(bridge, found);
    }
    return found;
}
