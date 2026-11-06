import type { BrowserPage } from './browser-service.js';
import type { DrivablePage } from './mcp-tools-pages.js';

/**
 * THE GENIE BROWSER'S PAGES, AS THE WINDOW HOLDS THEM (the host split, P2b). The `pages` tool reads its pages at once and a
 * page's revision whenever it asks, and these live in another process: the browser says what it has, this keeps the
 * latest, and a call crosses the host. A page held across a change reads its revision now, or an agent's stale action would
 * go through after a navigation.
 */
export class BrowserPagesReplica {
    readonly #call: (pageId: string, method: string, args: unknown[]) => Promise<unknown>;
    #pages = new Map<string, BrowserPage>();

    constructor(call: (pageId: string, method: string, args: unknown[]) => Promise<unknown>) {
        this.#call = call;
    }

    apply(pages: readonly BrowserPage[]): void {
        this.#pages = new Map(pages.map((p) => [p.id, p]));
    }

    list(): DrivablePage[] {
        return [...this.#pages.values()].map((page) => ({
            id: page.id,
            url: page.url,
            title: page.title,
            revision: () => this.#pages.get(page.id)?.revision ?? page.revision,
            transport: { call: (method: string, args: unknown[]) => this.#call(page.id, method, args) },
        }));
    }
}
