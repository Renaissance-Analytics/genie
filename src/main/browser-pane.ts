import { classifyNavigation } from '../core/browser-policy.js';
import type { GenRoute } from '../core/gen-router.js';

/**
 * THE GENIE BROWSER'S PANE — the main-process half.
 *
 * A WebContentsView positioned over the box the renderer draws, navigated only through the browser
 * policy (`core/browser-policy.ts`): a `.gen` name becomes its loopback target with a Host rewrite
 * registered so the site sees the name it was created under; refused schemes never reach the view;
 * with no url the view is HIDDEN rather than left showing a stale page. The Electron view sits behind
 * `ViewPort` so the logic is tested with a fake and the Electron wiring (`electron-browser-view.ts`)
 * is a thin adapter.
 */

export interface ViewPort {
    loadURL(url: string): Promise<void>;
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
    setVisible(visible: boolean): void;
    /** Register: requests to `target` carry `Host: host` (webRequest.onBeforeSendHeaders in Electron). */
    rewriteHost(host: string, target: string): void;
    clearRewrites(): void;
}

export class BrowserPane {
    readonly #view: ViewPort;
    readonly #routes: () => readonly GenRoute[];
    #current: string | null = null;

    constructor(view: ViewPort, routes: () => readonly GenRoute[]) {
        this.#view = view;
        this.#routes = routes;
    }

    /** Navigate per policy. The answer carries the ADDRESS to show (the .gen name for a site). */
    async show(input: string): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
        const nav = classifyNavigation(input, this.#routes());
        if (nav.kind === 'refused') return { ok: false, reason: nav.reason };
        if (nav.kind === 'no-site') return { ok: false, reason: `nothing is serving ${nav.host}` };
        this.#view.clearRewrites();
        let address: string;
        let load: string;
        if (nav.kind === 'site') {
            const route = this.#routes().find((r) => r.host === nav.host)!;
            this.#view.rewriteHost(nav.host, route.target);
            load = nav.url;
            address = new URL(nav.url).pathname + new URL(nav.url).search;
            address = `https://${nav.host}${address}`;
        } else {
            load = nav.url;
            address = nav.url;
        }
        await this.#view.loadURL(load);
        this.#view.setVisible(true);
        this.#current = address;
        return { ok: true, url: address };
    }

    setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
        this.#view.setBounds(bounds);
    }

    hide(): void {
        this.#view.setVisible(false);
        this.#current = null;
    }

    current(): string | null {
        return this.#current;
    }
}
