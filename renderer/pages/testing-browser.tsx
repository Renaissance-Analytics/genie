import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
    api,
    hasGenieBridge,
    type TestingBrowserState,
} from '../lib/genie';

/**
 * Testing Browser chrome (serve-local-sites Phase D, design §4). This React page
 * is the browser CHROME only — URL bar, tab strip, device presets, enabled-`.gen`
 * quick-nav. The actual site content is a main-owned `WebContentsView` composited
 * OVER the reserved content region below; we report that region's bounds to main
 * so it positions the view. All navigation is driven over `testing-browser:*` IPC
 * (main holds the session, shim, and Genie CA — never the renderer).
 */
export default function TestingBrowserPage() {
    const [bridgeReady, setBridgeReady] = useState(false);
    useEffect(() => {
        if (hasGenieBridge()) {
            setBridgeReady(true);
            return;
        }
        const t = setInterval(() => {
            if (hasGenieBridge()) {
                setBridgeReady(true);
                clearInterval(t);
            }
        }, 150);
        return () => clearInterval(t);
    }, []);
    if (!bridgeReady) {
        return (
            <div className="surface flex min-h-screen items-center justify-center text-sm text-zinc-400">
                Starting the Testing Browser…
            </div>
        );
    }
    return <TestingBrowserInner />;
}

function TestingBrowserInner() {
    const [state, setState] = useState<TestingBrowserState | null>(null);
    const [address, setAddress] = useState('');
    const [error, setError] = useState<string | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);

    // Subscribe to main's state pushes + read the initial snapshot.
    useEffect(() => {
        let mounted = true;
        void api()
            .testingBrowser.state()
            .then((s) => {
                if (mounted && s) setState(s);
            });
        const off = api().testingBrowser.onState((s) => {
            if (mounted) setState(s);
        });
        const offErr = api().testingBrowser.onLoadError((e) => {
            if (mounted) setError(`Couldn't load ${e.url} (${e.description || e.code}).`);
        });
        return () => {
            mounted = false;
            off();
            offErr();
        };
    }, []);

    // Mirror the active tab's URL into the address bar when it changes upstream.
    const activeTab = state?.tabs.find((t) => t.id === state.activeTabId) ?? null;
    useEffect(() => {
        if (activeTab) setAddress(activeTab.url === 'about:blank' ? '' : activeTab.url);
    }, [activeTab?.id, activeTab?.url]);

    // Report the content region's bounds to main whenever it resizes, so the
    // WebContentsView is positioned exactly under the chrome.
    const reportBounds = useCallback(() => {
        const el = contentRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        void api().testingBrowser.setBounds({
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
        });
    }, []);
    useLayoutEffect(() => {
        reportBounds();
        const ro = new ResizeObserver(reportBounds);
        if (contentRef.current) ro.observe(contentRef.current);
        window.addEventListener('resize', reportBounds);
        return () => {
            ro.disconnect();
            window.removeEventListener('resize', reportBounds);
        };
    }, [reportBounds]);
    // Re-report when the tab strip / device row changes the reserved height.
    useLayoutEffect(reportBounds, [state?.tabs.length, state?.presetId, reportBounds]);

    const go = useCallback(
        async (value: string) => {
            setError(null);
            const res = await api().testingBrowser.navigate(value);
            if (!res.ok && res.error) setError(res.error);
        },
        [],
    );

    const sites = state?.sites ?? [];
    const presets = state?.presets ?? [];

    return (
        <div className="surface flex h-screen flex-col overflow-hidden bg-[#0a0a0c] text-zinc-200">
            {/* Genie-owned badge — this is a Genie surface, not real Chrome. */}
            <div className="flex items-center gap-2 border-b border-zinc-800 bg-[#131318] px-3 py-1.5 text-[11px]">
                <span className="rounded bg-emerald-900/60 px-1.5 py-0.5 font-semibold text-emerald-300">
                    GENIE TESTING BROWSER
                </span>
                <span className="text-zinc-400">
                    tunneling {state?.hostname ?? 'host'} · *.gen served only inside this session
                </span>
                <button
                    className="ml-auto rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800"
                    onClick={() => void api().testingBrowser.refreshSites()}
                    title="Refresh the enabled .gen sites from the host"
                >
                    ⟳ sites
                </button>
            </div>

            {/* Tab strip */}
            <div className="flex items-center gap-1 border-b border-zinc-800 bg-[#0f0f14] px-2 py-1">
                {(state?.tabs ?? []).map((t) => {
                    const active = t.id === state?.activeTabId;
                    return (
                        <div
                            key={t.id}
                            className={`flex max-w-[220px] items-center gap-1 rounded-t px-2 py-1 text-xs ${
                                active ? 'bg-[#1c1c24] text-zinc-100' : 'bg-transparent text-zinc-400 hover:bg-zinc-800/50'
                            }`}
                        >
                            <button
                                className="truncate"
                                onClick={() => void api().testingBrowser.activateTab(t.id)}
                                title={t.url}
                            >
                                {t.title || t.url}
                            </button>
                            <button
                                className="text-zinc-500 hover:text-zinc-200"
                                onClick={() => void api().testingBrowser.closeTab(t.id)}
                            >
                                ×
                            </button>
                        </div>
                    );
                })}
                <button
                    className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
                    onClick={() => void api().testingBrowser.newTab()}
                    title="New tab"
                >
                    +
                </button>
            </div>

            {/* Toolbar: nav + URL bar + device presets */}
            <div className="flex items-center gap-2 border-b border-zinc-800 bg-[#131318] px-2 py-1.5">
                <button
                    className="rounded px-2 py-1 text-sm text-zinc-300 disabled:text-zinc-600 hover:bg-zinc-800"
                    disabled={!state?.canGoBack}
                    onClick={() => void api().testingBrowser.back()}
                >
                    ‹
                </button>
                <button
                    className="rounded px-2 py-1 text-sm text-zinc-300 disabled:text-zinc-600 hover:bg-zinc-800"
                    disabled={!state?.canGoForward}
                    onClick={() => void api().testingBrowser.forward()}
                >
                    ›
                </button>
                <button
                    className="rounded px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800"
                    onClick={() => void api().testingBrowser.reload()}
                    title="Reload"
                >
                    {state?.loading ? '×' : '⟳'}
                </button>
                <form
                    className="flex flex-1 items-center"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void go(address);
                    }}
                >
                    <span className="mr-1 text-xs text-emerald-400">🔒</span>
                    <input
                        className="w-full rounded bg-[#0a0a0c] px-2 py-1 text-sm text-zinc-100 outline-none ring-1 ring-zinc-800 focus:ring-emerald-700"
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        placeholder="tynn.gen"
                        spellCheck={false}
                        autoComplete="off"
                    />
                </form>
                <select
                    className="rounded bg-[#0a0a0c] px-1.5 py-1 text-xs text-zinc-200 ring-1 ring-zinc-800"
                    value={state?.presetId ?? 'fit'}
                    onChange={(e) => void api().testingBrowser.setViewport(e.target.value)}
                    title="Device viewport"
                >
                    {presets.map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.label}
                        </option>
                    ))}
                </select>
            </div>

            {/* Enabled .gen quick-nav */}
            {sites.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 border-b border-zinc-900 bg-[#0f0f14] px-2 py-1">
                    {sites.map((s) => (
                        <button
                            key={s.genName}
                            className="rounded bg-zinc-800/70 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-700"
                            onClick={() => void go(`https://${s.genName}`)}
                            title={`${s.genName} → ${s.hostname}`}
                        >
                            {s.genName}
                        </button>
                    ))}
                </div>
            )}

            {error && (
                <div className="border-b border-red-900/50 bg-red-950/40 px-3 py-1 text-xs text-red-300">
                    {error}
                </div>
            )}

            {/* Reserved content region — main composites the WebContentsView here. */}
            <div ref={contentRef} className="relative flex-1 bg-[#0a0a0c]">
                {(!state || state.tabs.length === 0) && (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-zinc-500">
                        <div>No tunnel open.</div>
                        {sites.length === 0 ? (
                            <div className="max-w-sm text-xs">
                                Enable a repo’s <code>.gen</code> tunnel in this host’s workspace
                                settings, then it appears here.
                            </div>
                        ) : (
                            <div className="text-xs">Pick a site above to open it.</div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
