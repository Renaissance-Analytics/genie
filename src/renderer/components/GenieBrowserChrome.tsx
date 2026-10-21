import { Icon, Input, Select } from '@particle-academy/react-fancy';
import type { CSSProperties, RefObject } from 'react';
import type { BrowserSnapshot } from '../../main/genie-browser-window.js';

/**
 * THE GENIE BROWSER WINDOW'S CHROME (beta.35 item 36, step 2 — Genie 1's renderer/pages/testing-browser.tsx). The title
 * row is the window's drag area (the title bar is hidden; the native buttons sit over its right end on Windows), then the
 * tabs, the toolbar — back / forward / reload, the lock and the address (a TEXT field: `tynn` is an address here), the
 * device presets — a row of the Genie sites, one line for what went wrong, and the page box main places the active
 * tab's view over. Everything shown is main's snapshot; every click is a call back to main.
 */
export interface GenieBrowserChromeProps {
    readonly snapshot: BrowserSnapshot;
    /** The last address the person typed that was refused, in the rule's words; `null` when none. */
    readonly refusal: string | null;
    readonly onNavigate: (address: string) => void;
    /** A site chip: the active tab goes there (a tab is opened when there is none). */
    readonly onOpen: (address: string) => void;
    readonly onActivate: (id: string) => void;
    readonly onClose: (id: string) => void;
    readonly onNewTab: () => void;
    readonly onBack: () => void;
    readonly onForward: () => void;
    readonly onReload: () => void;
    readonly onPreset: (id: string) => void;
    /** The page box — its bounds are reported to main, which places the view over it. */
    readonly pageRef?: RefObject<HTMLDivElement | null>;
    readonly isMac?: boolean;
    /** The width the native window buttons take at the title row's right (renderer/window-chrome.ts useControlsInset). */
    readonly controlsInset?: number;
}

const chromeButton = 'shrink-0 rounded-md p-1.5 text-[var(--fg-2)] hover:bg-[var(--bg-2)] disabled:opacity-40 disabled:hover:bg-transparent';
const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties;

export function GenieBrowserChrome(p: GenieBrowserChromeProps) {
    const { snapshot: s } = p;
    const active = s.tabs.find((t) => t.id === s.active) ?? null;
    const onScreenHost = active ? hostOf(active.url) : null;
    const error = active?.error ?? p.refusal;
    return (
        <div data-genie-browser="" className="flex h-screen flex-col overflow-hidden bg-[var(--bg-0)] text-[var(--fg-2)]">
            {/* The window's title row and drag area; clear of the native buttons (measured — env(titlebar-area-width) resolves
                to nothing in a real window) or the macOS traffic lights. */}
            <div
                data-browser-titlebar=""
                className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border-1)] bg-[var(--bg-1)] pl-3 text-[11px]"
                style={{ WebkitAppRegion: 'drag', paddingRight: (p.controlsInset ?? 0) + 12 } as CSSProperties}
            >
                {p.isMac ? <span className="w-[64px] shrink-0" /> : null}
                <span className="font-semibold text-[var(--fg-1)]">Genie browser</span>
                <span className="truncate text-[var(--fg-3)]">this workstation’s Genie sites, served only inside this window</span>
            </div>

            <div data-browser-tabs="" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border-1)] px-2 py-1">
                {s.tabs.map((t) => {
                    const on = t.id === s.active;
                    return (
                        <div key={t.id} className={`flex max-w-[220px] shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs ${on ? 'bg-[var(--bg-2)] text-[var(--fg-1)]' : 'text-[var(--fg-3)] hover:bg-[var(--bg-1)]'}`}>
                            <button type="button" data-browser-tab={t.id} {...(on ? { 'data-current': 'true' } : {})} className="truncate" title={t.url} onClick={() => p.onActivate(t.id)}>
                                {t.loading ? <Icon name="loader" size="xs" className="mr-1 inline animate-spin" /> : null}
                                {t.title || t.url}
                            </button>
                            <button type="button" data-browser-close={t.id} aria-label={`Close ${t.title || t.url}`} className="text-[var(--fg-4)] hover:text-[var(--fg-1)]" onClick={() => p.onClose(t.id)}>
                                <Icon name="x" size="xs" />
                            </button>
                        </div>
                    );
                })}
                <button type="button" data-browser-new-tab="" aria-label="New tab" title="New tab" className={chromeButton} onClick={p.onNewTab}>
                    <Icon name="plus" size="xs" />
                </button>
            </div>

            <div data-browser-toolbar="" className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1.5" style={noDrag}>
                <button type="button" data-browser-nav="back" aria-label="Back" title="Back" disabled={!active?.canGoBack} onClick={p.onBack} className={chromeButton}>
                    <Icon name="chevron-left" size="xs" />
                </button>
                <button type="button" data-browser-nav="forward" aria-label="Forward" title="Forward" disabled={!active?.canGoForward} onClick={p.onForward} className={chromeButton}>
                    <Icon name="chevron-right" size="xs" />
                </button>
                <button type="button" data-browser-nav="reload" aria-label="Reload" title="Reload" disabled={active === null} onClick={p.onReload} className={chromeButton}>
                    <Icon name="rotate-cw" size="xs" />
                </button>
                {/* Keyed by the page: the field shows where the view IS (a link, a redirect, back), never a stale entry. */}
                <form
                    key={`${active?.id ?? ''}:${active?.url ?? ''}`}
                    className="flex-1"
                    onSubmit={(e) => { e.preventDefault(); p.onNavigate(String(new FormData(e.currentTarget).get('address') ?? '')); }}
                >
                    <Input
                        name="address"
                        type="text"
                        data-browser-address=""
                        defaultValue={active?.url ?? ''}
                        placeholder="tynn.gen"
                        spellCheck={false}
                        autoComplete="off"
                        leading={<span data-browser-lock="" className="text-[var(--success)]"><Icon name="lock" size="xs" /></span>}
                    />
                </form>
                <div data-browser-presets="" className="w-36 shrink-0">
                    <Select list={s.presets.map((x) => ({ value: x.id, label: x.label }))} value={s.presetId} onValueChange={p.onPreset} aria-label="Device viewport" />
                </div>
            </div>

            {s.sites.length > 0 ? (
                <div data-browser-sites="" className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border-1)] px-2 py-1">
                    {s.sites.map((host) => (
                        <button
                            key={host}
                            type="button"
                            data-browser-site={host}
                            aria-current={onScreenHost === host ? 'page' : undefined}
                            onClick={() => p.onOpen(`https://${host}/`)}
                            className={`rounded-md px-2 py-0.5 font-mono text-[11px] hover:bg-[var(--bg-2)] ${onScreenHost === host ? 'bg-[var(--bg-2)] text-[var(--fg-1)]' : 'text-[var(--fg-2)]'}`}
                        >
                            {host}
                        </button>
                    ))}
                </div>
            ) : null}

            {error ? (
                <div data-browser-error="" className="shrink-0 border-b border-[var(--danger)] bg-[var(--bg-1)] px-3 py-1 text-xs text-[var(--danger)]">{error}</div>
            ) : null}

            {/* The page box: main places the active tab's view over it. */}
            <div ref={p.pageRef} data-browser-page="" className="relative min-h-0 flex-1">
                {active === null ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-[var(--fg-3)]">
                        <div>No site open.</div>
                        {s.sites.length === 0
                            ? <div className="max-w-sm text-xs">No Genie sites are being served. Add one in Hosting, and it appears here.</div>
                            : <div className="text-xs">Pick a site above to open it.</div>}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function hostOf(url: string): string | null {
    try {
        return new URL(url).hostname;
    } catch {
        return null;
    }
}
