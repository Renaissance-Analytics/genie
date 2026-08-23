/**
 * PURE. What a GApp window is called (Tynn #250, owner correction 2026-08-22).
 *
 * `[{GApp Name}] - {window.title}`, where the suffix is whatever the hosted page
 * set as its own title, live, changing as the page navigates.
 *
 * Two requirements meet here and they pull against each other.
 *
 * The PREFIX is a grouping key. One GApp gets one window per hosted site, so an
 * app with three repos has three windows, and `[Trader]` on every one of them is
 * what says they belong to the same app. It has to be byte-identical across them
 * or it stops grouping anything.
 *
 * The SUFFIX is the app's own voice — which part of it you are looking at — and
 * it is the only thing distinguishing those three windows from each other.
 *
 * And URLS ARE NEVER EXPOSED. No address bar, no origin shown anywhere: the GApp
 * window is technically a browser and none of its UX may read as one. That is the
 * constraint the suffix has to survive, and it does not survive it by accident —
 * see below.
 */

/**
 * Does this title actually name a location?
 *
 * Chromium gives a page with no `<title>` its own URL as `document.title`. So
 * without this check, the pages a developer has NOT finished yet are exactly the
 * ones that would print their address into the window chrome — the URL leak
 * arriving through the back door, in the one place nobody thinks to look for it.
 *
 * It is not about trusting the app either: a page can set its title to anything,
 * and one that wrote a URL there would put an address in Genie's chrome just as
 * effectively. The rule is a property of the WINDOW, so it applies to any origin,
 * not only the app's own.
 *
 * Deliberately narrow. A title is the app's voice and dropping one is a real cost,
 * so this only fires on something that genuinely parses as a URL or a host —
 * never on prose that merely contains a dot (`Trader v2.1`, `P&L · today`).
 */
function looksLikeALocation(title: string): boolean {
    // A full URL, of any scheme.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(title)) return true;
    // A bare host, optionally with a port and a path, and NOTHING else — no
    // spaces, so a sentence containing a domain is still a sentence.
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(title) ||
        /^localhost(:\d+)?(\/\S*)?$/i.test(title);
}

/**
 * The window title for a GApp window.
 *
 * `pageUrl` is taken but not read into the output — it is here so that a future
 * rule which needs to compare the title against the page's own origin has the
 * fact available, and so that no caller is tempted to build the title from a URL
 * because it was the only thing to hand.
 */
export function gappWindowTitle(appName: string, pageTitle: string, pageUrl: string): string {
    void pageUrl;
    const prefix = `[${appName}]`;
    const title = pageTitle.trim();
    // No title, or a title that is really an address: the prefix alone. Not
    // `[Trader] - Trader` — a title repeating itself reads as a bug, and the
    // prefix on its own is the honest answer to "which window is this?".
    if (!title || looksLikeALocation(title)) return prefix;
    return `${prefix} - ${title}`;
}
