/**
 * A LINK OPENS IN THE BROWSER, NEVER IN GENIE (Tynn #763; Genie 1's clickable terminal URLs). A link the person clicks —
 * a URL in a terminal (fancy-term's `onLinkActivate`), a `target="_blank"` link in the GitHub panel or a rendered reply —
 * opens in their browser. Only http(s) ever leaves: never `file:`, `javascript:` or anything else. And a Genie window is
 * never navigated away from Genie: Electron's default for a new-window link is a NEW Genie window showing the site.
 */

/** The URL, when it may be opened in the browser (http or https); otherwise `null`. */
export function externalUrl(url: string): string | null {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
    } catch {
        return null;
    }
}

/** The page a window shows, without its in-page route (`#genie://…`): navigating within it is Genie's own. */
function pageOf(url: string): string {
    const hash = url.indexOf('#');
    return hash === -1 ? url : url.slice(0, hash);
}

export interface LinkGuardedContents {
    getURL(): string;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void;
    on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): unknown;
}

/** Guard a window: new-window links and navigation away from Genie go to the browser (http(s) only), or nowhere. */
export function guardWindowLinks(contents: LinkGuardedContents, openExternal: (url: string) => void): void {
    contents.setWindowOpenHandler(({ url }) => {
        const external = externalUrl(url);
        if (external) openExternal(external);
        return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
        if (pageOf(url) === pageOf(contents.getURL())) return;
        event.preventDefault();
        const external = externalUrl(url);
        if (external) openExternal(external);
    });
}
