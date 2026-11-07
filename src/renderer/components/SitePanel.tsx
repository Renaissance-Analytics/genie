import { Button } from '@particle-academy/react-fancy';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NO_SITE_STATE, SingleSiteBar, type SiteState } from './SingleSiteBar.js';

/** What the window offers a live panel: main's view placed over the box, hidden, reloaded, or the site in the browser. */
export interface SitePanelLive {
    /** `workspace:tab:cell` (core/workspace-tabs.ts `panelKey`). */
    readonly panelKey: string;
    readonly onBounds: (panelKey: string, host: string, bounds: { x: number; y: number; width: number; height: number }) => void;
    readonly onHide: (panelKey: string) => void;
    readonly onReload: (panelKey: string) => void;
    readonly onBack: (panelKey: string) => void;
    readonly onForward: (panelKey: string) => void;
    /** What the page can do, as it changes. Answers the leaving function. */
    readonly onState: (panelKey: string, listener: (state: SiteState) => void) => () => void;
    readonly onOpenInWindow: (host: string) => void;
    /** Its site is out in its own window. */
    readonly popped?: boolean;
    readonly onPopBack?: (panelKey: string) => void;
    /** Why this panel shows no page. */
    readonly refused?: { readonly error: string; readonly locked?: boolean };
    readonly onRefused?: (panelKey: string, listener: (why: { readonly error: string; readonly locked?: boolean } | null) => void) => () => void;
    readonly onRestart?: () => void;
    /** Whether it is out, as that changes. Answers the leaving function. */
    readonly onPopped?: (panelKey: string, listener: (out: boolean) => void) => () => void;
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
                    <Button size="xs" type="submit" disabled={!valid} className="rounded-md border border-[var(--border-1)] px-2 py-1 disabled:opacity-50">Show</Button>
                </div>
            </form>
        );
    }
    if (!live) {
        return <p className="flex flex-1 items-center justify-center p-4 text-[12px] text-[var(--fg-3)]">{host} is served by the machine this window drives; it shows live in that machine’s own Genie window.</p>;
    }
    return <PanelSite host={host} live={live} />;
}

function PanelSite({ host, live }: { host: string; live: SitePanelLive }) {
    const [out, setOut] = useState(live.popped === true);
    const { panelKey, onPopped } = live;
    const subscribe = useRef(onPopped);
    subscribe.current = onPopped;
    useEffect(() => subscribe.current?.(panelKey, setOut), [panelKey]);
    if (!out) return <LiveSite host={host} live={live} />;
    return (
        <div data-site-popped={panelKey} className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-[12px] text-[var(--fg-3)]">
            <p>{host} is in its own window.</p>
            <Button size="xs" type="button" data-site-action="pop-back" title="Back to the panel: the page reloads here" onClick={() => live.onPopBack?.(panelKey)}>Back to the panel (reloads)</Button>
        </div>
    );
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
    const [state, setState] = useState<SiteState>(NO_SITE_STATE);
    const [why, setWhy] = useState(live.refused ?? null);
    useEffect(() => calls.current.onRefused?.(panelKey, setWhy), [panelKey]);
    useEffect(() => calls.current.onState(panelKey, setState), [panelKey]);
    return (
        <div data-site-panel={panelKey} className="flex min-h-0 min-w-0 flex-1 flex-col">
            <SingleSiteBar
                host={host}
                state={state}
                where="panel"
                onBack={() => live.onBack(panelKey)}
                onForward={() => live.onForward(panelKey)}
                onReload={() => live.onReload(panelKey)}
                onPop={() => live.onOpenInWindow(host)}
            />
            {why ? (
                <div data-site-refused="" className="flex shrink-0 items-center gap-2 border-b border-[var(--border-1)] px-2 py-1 text-[11px] text-[var(--fg-2)]">
                    {why.error}
                    {why.locked ? <Button size="xs" type="button" data-site-action="restart" onClick={live.onRestart}>Restart</Button> : null}
                </div>
            ) : null}
            {/* The live page sits over this box, in the layer (renderer/site-webview-layer.ts). */}
            <div ref={box} data-site-panel-box="" className="min-h-0 flex-1" />
        </div>
    );
}
