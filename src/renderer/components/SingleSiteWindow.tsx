import type { RefObject } from 'react';
import type { BrowserSnapshot } from '../../main/genie-browser-window.js';
import { SingleSiteBar } from './SingleSiteBar.js';

/**
 * A SITE POPPED OUT OF ITS PANEL (the host split, P2b; the owner: "a single site ux"). The browser's `--single` window: the
 * same bar as the panel, the page box main places the view over, the door's notice, and no tabs.
 */
export function SingleSiteWindow(p: {
    readonly snapshot: BrowserSnapshot;
    readonly pageRef?: RefObject<HTMLDivElement | null>;
    readonly onBack: () => void;
    readonly onForward: () => void;
    readonly onReload: () => void;
    readonly onPop: () => void;
}) {
    const tab = p.snapshot.tabs.find((t) => t.id === p.snapshot.active) ?? null;
    let host = '';
    try { host = tab ? new URL(tab.url).hostname : ''; } catch { /* not an address yet */ }
    return (
        <div data-genie-browser="" className="flex h-screen flex-col overflow-hidden bg-[var(--bg-0)] text-[var(--fg-2)]">
            <SingleSiteBar
                host={host}
                state={{ canGoBack: tab?.canGoBack === true, canGoForward: tab?.canGoForward === true, loading: tab?.loading === true }}
                where="window"
                onBack={p.onBack}
                onForward={p.onForward}
                onReload={p.onReload}
                onPop={p.onPop}
            />
            {p.snapshot.notice ? <div data-browser-notice="" className="shrink-0 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-3 py-1 text-[11px] text-[var(--fg-2)]">{p.snapshot.notice}</div> : null}
            {tab?.error ? <div data-browser-error="" className="shrink-0 border-b border-[var(--danger)] bg-[var(--bg-1)] px-3 py-1 text-[11px]">{tab.error}</div> : null}
            <div ref={p.pageRef} data-browser-page="" className="relative min-h-0 flex-1" />
        </div>
    );
}
