import { Icon } from '@particle-academy/react-fancy';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** What the window offers a live panel: main's view placed over the box, hidden, reloaded, or the site in the browser. */
export interface SitePanelLive {
    /** `workspace:tab:cell` (core/workspace-tabs.ts `panelKey`). */
    readonly panelKey: string;
    readonly onBounds: (panelKey: string, host: string, bounds: { x: number; y: number; width: number; height: number }) => void;
    readonly onHide: (panelKey: string) => void;
    readonly onReload: (panelKey: string) => void;
    readonly onOpenInWindow: (host: string) => void;
}

/**
 * A GENIE SITE IN A PANEL (Tynn #282; LIVE since beta.35 item 36, step 5): a small bar — the site, Reload, Open in the
 * Genie browser — over a box main places the live page on (a view in the Genie browser's session: never an iframe, which
 * the window's CSP blocks and whose session has no .gen route). The box's bounds go to main on every resize; leaving the
 * screen hides the page, which is kept. With no site chosen the panel asks for one. A window with no live panels (one
 * driving another machine) says where the site opens instead.
 */
export function SitePanel({ host, onPick, live }: { host: string | null; onPick: (host: string) => void; live?: SitePanelLive | undefined }) {
    const [typed, setTyped] = useState('');
    if (!host) {
        const valid = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.gen$/i.test(typed.trim());
        return (
            <form data-site-pick="" onSubmit={(e) => { e.preventDefault(); if (valid) onPick(typed.trim().toLowerCase()); }} className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-[12px] text-[var(--fg-3)]">
                <label htmlFor="site-host">Which site? A .gen address this workstation serves.</label>
                <div className="flex gap-1.5">
                    <input id="site-host" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="moic.gen" className="rounded-md border border-[var(--border-1)] bg-transparent px-2 py-1 text-[var(--fg-1)]" />
                    <button type="submit" disabled={!valid} className="rounded-md border border-[var(--border-1)] px-2 py-1 disabled:opacity-50">Show</button>
                </div>
            </form>
        );
    }
    if (!live) {
        return <p className="flex flex-1 items-center justify-center p-4 text-[12px] text-[var(--fg-3)]">{host} is served by the machine this window drives; it shows live in that machine’s own Genie window.</p>;
    }
    return <LiveSite host={host} live={live} />;
}

function LiveSite({ host, live }: { host: string; live: SitePanelLive }) {
    const box = useRef<HTMLDivElement | null>(null);
    const { panelKey } = live;
    // The parent's callbacks change every render; the page must not be hidden and re-shown each time (a flicker).
    const calls = useRef(live);
    calls.current = live;
    useLayoutEffect(() => {
        const report = () => {
            const r = box.current?.getBoundingClientRect();
            if (r) calls.current.onBounds(panelKey, host, { x: r.left, y: r.top, width: r.width, height: r.height });
        };
        report();
        const ro = new ResizeObserver(report);
        if (box.current) ro.observe(box.current);
        window.addEventListener('resize', report);
        return () => { ro.disconnect(); window.removeEventListener('resize', report); };
    }, [panelKey, host]);
    // Off screen (the tab changed, the panel unmounted): the page is hidden and kept.
    useEffect(() => () => calls.current.onHide(panelKey), [panelKey]);
    const button = 'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]';
    return (
        <div data-site-panel={panelKey} className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex h-7 shrink-0 items-center gap-1 border-b border-[var(--border-1)] px-2 text-[11px]">
                <Icon name="lock" size="xs" className="text-[var(--success)]" />
                <span className="truncate font-mono text-[var(--fg-2)]">{host}</span>
                <span className="ml-auto flex items-center gap-1">
                    <button type="button" data-site-panel-action="reload" aria-label={`Reload ${host}`} title="Reload" className={button} onClick={() => live.onReload(panelKey)}>
                        <Icon name="rotate-cw" size="xs" />
                    </button>
                    <button type="button" data-site-panel-action="open-window" title={`Open ${host} in the Genie browser`} className={button} onClick={() => live.onOpenInWindow(host)}>
                        <Icon name="globe" size="xs" />
                        Open in browser
                    </button>
                </span>
            </div>
            {/* The live page is placed over this box by main. */}
            <div ref={box} data-site-panel-box="" className="min-h-0 flex-1" />
        </div>
    );
}
