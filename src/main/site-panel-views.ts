import { normalizeNavUrl } from '../core/genie-browser.js';

/**
 * LIVE SITE PANELS (beta.35 item 36, step 5; the owner, FTQ q_227d0bb6: site panels are LIVE pages). A workspace tab's
 * `site` panel is a real page: a view in the Genie browser's own session (its .gen routing, Genie's CA), placed over the
 * panel's box in the window. Never an iframe — the window's CSP blocks one and its session has no .gen route.
 *
 * One view per panel (`workspace:tab:cell`), made on its first showing; the box moving moves it, a different site loads
 * in it, a box that is off screen (zero-sized, or the tab not shown) hides it with its page kept, a panel that is gone
 * closes it. Only a Genie site this workstation serves is shown (core/genie-browser.ts `normalizeNavUrl`); one that stops
 * being served closes the panel's page rather than leave a stale one. The Electron views sit behind {@link PanelViewPort}.
 */

export interface Bounds {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface PanelViewPort {
    load(url: string): void;
    reload(): void;
    setBounds(bounds: Bounds): void;
    setVisible(visible: boolean): void;
    destroy(): void;
}

export interface SitePanelPorts {
    /** The `.gen` hosts this workstation serves, now. */
    readonly enabledHosts: () => readonly string[];
    readonly createView: (panelKey: string) => PanelViewPort;
}

export class SitePanelViews {
    readonly #ports: SitePanelPorts;
    readonly #panels = new Map<string, { view: PanelViewPort; url: string }>();

    constructor(ports: SitePanelPorts) {
        this.#ports = ports;
    }

    /** The panel's site, over its box — or why it is not shown (and nothing is). */
    show(panelKey: string, host: string, bounds: Bounds): { ok: true } | { ok: false; error: string } {
        const nav = normalizeNavUrl(host, new Set(this.#ports.enabledHosts()));
        if ('error' in nav) {
            this.remove(panelKey);
            return { ok: false, error: nav.error };
        }
        const url = `https://${new URL(nav.url).hostname}/`;
        let panel = this.#panels.get(panelKey);
        if (!panel) {
            panel = { view: this.#ports.createView(panelKey), url: '' };
            this.#panels.set(panelKey, panel);
        }
        if (panel.url !== url) {
            panel.url = url;
            panel.view.load(url);
        }
        const box = { x: Math.max(0, Math.round(bounds.x)), y: Math.max(0, Math.round(bounds.y)), width: Math.max(0, Math.round(bounds.width)), height: Math.max(0, Math.round(bounds.height)) };
        if (box.width === 0 || box.height === 0) {
            panel.view.setVisible(false);
            return { ok: true };
        }
        panel.view.setBounds(box);
        panel.view.setVisible(true);
        return { ok: true };
    }

    /** Off screen: hidden, its page kept. */
    hide(panelKey: string): void {
        this.#panels.get(panelKey)?.view.setVisible(false);
    }

    reload(panelKey: string): void {
        this.#panels.get(panelKey)?.view.reload();
    }

    /** The panel is gone: its page closes. */
    remove(panelKey: string): void {
        const panel = this.#panels.get(panelKey);
        if (!panel) return;
        this.#panels.delete(panelKey);
        panel.view.destroy();
    }

    /**
     * A workspace's tabs changed: each of ITS panels (`<workspaceId>:…`) that is no longer a site panel there closes. Other
     * workspaces' panels are untouched.
     */
    retainIn(workspaceId: string, keep: ReadonlySet<string>): void {
        for (const key of [...this.#panels.keys()]) if (key.startsWith(`${workspaceId}:`) && !keep.has(key)) this.remove(key);
    }

    closeAll(): void {
        for (const key of [...this.#panels.keys()]) this.remove(key);
    }
}
