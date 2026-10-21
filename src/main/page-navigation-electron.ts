import type { WebContents } from 'electron';
import { domNavigationCallScript } from '@particle-academy/agent-integrations/dom-navigation';
import { DOM_NAVIGATION_SCRIPT } from '@particle-academy/agent-integrations/dom-navigation/script';
import type { DrivablePage } from './mcp-tools-pages.js';

/**
 * EVERY OPEN GENIE PAGE, DRIVABLE BY AN AGENT (browser rebuild step 7) — the Electron half. Each page Genie shows (a tab
 * of the Genie browser window, a live site panel) gets fancy's navigation script, injected into an ISOLATED world on
 * every load (`dom-ready`): the page's own scripts cannot see or call it, and Genie never runs anything in the page's own
 * world. Calls go to that same world. A navigation — the person's or the agent's — moves the page's revision, so an
 * agent acting on what it saw before is told to look again (the bridge's stale-intent guard).
 *
 * Which pages an agent may drive, and what asks the person, is mcp-tools-pages.ts (tested); this file only touches
 * Electron, and its load-bearing lines are source-checked (test/pages-tool.test.ts).
 */
export const NAV_WORLD = 1001;

const open = new Map<string, { readonly wc: WebContents; revision: number }>();

/** Attach a view's page under `id`; the returned function detaches it (the view closed). */
export function attachPageNavigation(id: string, wc: WebContents): () => void {
    const entry = { wc, revision: 1 };
    open.set(id, entry);
    wc.on('dom-ready', () => {
        void wc.executeJavaScriptInIsolatedWorld(NAV_WORLD, [{ code: DOM_NAVIGATION_SCRIPT }]).catch(() => { /* a page that went away mid-load */ });
    });
    const moved = () => { entry.revision += 1; };
    wc.on('did-navigate', moved);
    wc.on('did-navigate-in-page', moved);
    return () => { if (open.get(id) === entry) open.delete(id); };
}

/** The pages open now, each with its transport into the isolated world. */
export function drivablePages(): DrivablePage[] {
    return [...open].filter(([, e]) => !e.wc.isDestroyed()).map(([id, e]) => ({
        id,
        url: e.wc.getURL(),
        title: e.wc.getTitle(),
        revision: () => e.revision,
        transport: {
            call: (method: string, args: unknown[]) =>
                e.wc.executeJavaScriptInIsolatedWorld(NAV_WORLD, [{ code: domNavigationCallScript(method as Parameters<typeof domNavigationCallScript>[0], args) }]),
        },
    }));
}
