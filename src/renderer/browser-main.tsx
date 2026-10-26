import { initTheme } from '@particle-academy/react-fancy';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { BrowserSnapshot } from '../main/genie-browser-window.js';
import { GenieBrowserChrome } from './components/GenieBrowserChrome.js';
import { registerAppIcons } from './icons.js';
import { useControlsInset, useOverlayColors } from './window-chrome.js';
import './styles.css';

/**
 * The Genie browser window's renderer: GenieBrowserChrome over the browser preload's `genieBrowser`. Pushed, never
 * polled: main sends the snapshot on every change; the window asks once on load. The page box's bounds go to main on
 * every resize (ResizeObserver), and again when the rows above it change height, so the view sits exactly over it.
 */
type Answer = { ok: true } | { ok: false; error: string };
interface BrowserBridge {
    state(): Promise<BrowserSnapshot>;
    navigate(address: string): Promise<Answer>;
    open(address: string): Promise<Answer>;
    /** A site chip: that site's tab, shown — or a new one (genie#1196). */
    showSite(address: string): Promise<Answer>;
    newTab(): Promise<Answer>;
    activate(id: string): Promise<void>;
    close(id: string): Promise<void>;
    back(): Promise<void>;
    forward(): Promise<void>;
    reload(): Promise<void>;
    setPreset(id: string): Promise<void>;
    setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
    /** The native window buttons are drawn over the title row (Windows, Linux): their colours follow the theme. */
    readonly overlay: boolean;
    setOverlayColors(color: string, symbolColor: string): Promise<boolean>;
    onState(listener: (snapshot: BrowserSnapshot) => void): () => void;
}
declare global {
    interface Window { genieBrowser?: BrowserBridge }
}

const EMPTY: BrowserSnapshot = { tabs: [], active: null, presetId: 'fit', presets: [], sites: [] };

function Browser({ bridge }: { bridge: BrowserBridge }) {
    const [snapshot, setSnapshot] = useState<BrowserSnapshot>(EMPTY);
    const [refusal, setRefusal] = useState<string | null>(null);
    const pageRef = useRef<HTMLDivElement | null>(null);
    const controlsInset = useControlsInset(bridge.overlay);
    useOverlayColors(bridge);
    useEffect(() => {
        void bridge.state().then(setSnapshot);
        return bridge.onState(setSnapshot);
    }, [bridge]);
    const report = useCallback(() => {
        const r = pageRef.current?.getBoundingClientRect();
        if (r) void bridge.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
    }, [bridge]);
    useLayoutEffect(() => {
        report();
        const ro = new ResizeObserver(report);
        if (pageRef.current) ro.observe(pageRef.current);
        return () => ro.disconnect();
    }, [report]);
    // The rows above the page change height (a site row, an error line): the box moved.
    const active = snapshot.tabs.find((t) => t.id === snapshot.active);
    useLayoutEffect(report, [report, snapshot.sites.length, active?.error, refusal]);
    const answer = (call: Promise<Answer>) => { void call.then((a) => setRefusal(a.ok ? null : a.error)); };
    return (
        <GenieBrowserChrome
            snapshot={snapshot}
            refusal={refusal}
            pageRef={pageRef}
            isMac={/Mac/i.test(navigator.platform ?? '')}
            controlsInset={controlsInset}
            onNavigate={(address) => answer(bridge.navigate(address))}
            onOpen={(address) => answer(bridge.showSite(address))}
            onNewTab={() => answer(bridge.newTab())}
            onActivate={(id) => { setRefusal(null); void bridge.activate(id); }}
            onClose={(id) => void bridge.close(id)}
            onBack={() => void bridge.back()}
            onForward={() => void bridge.forward()}
            onReload={() => void bridge.reload()}
            onPreset={(id) => void bridge.setPreset(id)}
        />
    );
}

initTheme();
registerAppIcons();
const bridge = window.genieBrowser;
const root = createRoot(document.getElementById('root')!);
root.render(bridge ? <Browser bridge={bridge} /> : <div className="p-6 text-sm">The Genie browser needs Genie.</div>);
