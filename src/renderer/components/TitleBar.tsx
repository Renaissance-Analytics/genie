import {
    Icon,
    Tooltip,
    browserPlatformHints,
    detectPlatform,
    modifierKeyLabel,
    type FancyPlatform,
} from '@particle-academy/react-fancy';
import { useEffect, useState } from 'react';
import { FEATURE_ICONS } from '../../core/rail-view.js';
import type { SignalAction } from '../../core/deck.js';
import type { UpdateChip } from '../../core/update-chip.js';

/**
 * THE TITLE BAR — 36px, and the only chrome that is on every surface.
 *
 * Left to right: the brand mark, `Genie`, the four feature icons, **the current route**, the
 * ⌘K box, and the workstation chip.
 *
 * ## Why the route is in the chrome
 *
 * It is load-bearing, not decoration. All view state lives in the URL so that refresh, back
 * and deep links work — and so **an agent can hand a human a link to the exact place it needs
 * them**. `genie://agent/kai?tab=stream&at=ev_8831` only works as a handoff if the human can
 * see where they landed.
 *
 * ## ⌘K is an accelerator and never the only route
 *
 * The previous attempt deleted the navigation rail and called the palette its replacement. A
 * palette helps you find a surface you already know exists; it cannot be how someone reaches
 * the default screen for the first time. The mark on the left is a labelled route home, and
 * the rail beside it carries the rest.
 */

import { remoteBadge } from '../../core/remote-protocol.js';

export interface TitleBarProps {
    /** The current route, shown verbatim. */
    route: string;
    /**
     * The workstation, or `null` until it is known.
     *
     * Nullable because the alternative was a `healthy: false` default, and that paints a red
     * fault light on boot about a machine nobody has checked. Absent is the only honest
     * rendering of "we have not looked" — including absent of a grey dot, which still asserts
     * a reading.
     */
    workstation: { name: string; healthy: boolean } | null;
    /** Driving another machine (§6.8): the loud badge, who holds the baton, the lock. Absent on the local machine. */
    remote?: { host: string; driver: string | null; driving: boolean; locked: boolean } | null | undefined;
    onNavigate: (route: string) => void;
    onOpenPalette: () => void;
    /** The width the native window buttons take at the right, measured (core/window.ts `controlsInset`); 0 = none. */
    controlsInset?: number | undefined;
    /** The update, from `available` on (core/update-chip.ts); absent = nothing to act on. */
    update?: UpdateChip | null | undefined;
    /** Its next step: download, or restart to install. */
    onUpdateAction?: ((action: SignalAction) => void) | undefined;
    /**
     * The platform, for the palette's key hint. Injected so a test can render both branches on
     * one machine; resolved from the browser after mount when it is not.
     */
    platform?: FancyPlatform | undefined;
}

export function TitleBar({ route, workstation, remote, onNavigate, onOpenPalette, platform, controlsInset = 0, update, onUpdateAction }: TitleBarProps) {
    /**
     * The modifier label, from the KIT rather than from our own copy.
     *
     * I had written `modifierLabel`/`paletteHint` here first. react-fancy 5.35.0 shipped
     * `detectPlatform` / `modifierKeyLabel` with the same argument-taking shape and two
     * refinements mine did not have, so ours is deleted — never hand-roll what Fancy provides:
     *
     *  - **`generic` is the fallback**, and that is load-bearing. Submit accepts
     *    `metaKey || ctrlKey`, so `Ctrl` is a TRUE label on an Apple keyboard while `⌘` is
     *    false everywhere else. An unresolved platform gets the label that is pressable on all
     *    of them, not the prettier one.
     *  - **`detectPlatform` refuses to let free text overturn an enumerated answer.** When
     *    `userAgentData.platform` answers, it is final — because our OWN Electron user agent
     *    contains `AppleWebKit` on Linux, and a substring sweep would call that Apple. Mine
     *    read `navigator.platform` alone and would have been wrong there.
     *
     * Resolved AFTER mount, never during render: reading `navigator` while rendering turns a
     * wrong label into a hydration mismatch, which is a worse bug wearing a fix's clothes.
     * First paint says `Ctrl`; an Apple machine swaps on the next tick.
     */
    const [resolved, setResolved] = useState<FancyPlatform>('generic');
    useEffect(() => {
        if (platform === undefined) setResolved(detectPlatform(browserPlatformHints()));
    }, [platform]);

    const modifier = modifierKeyLabel(platform ?? resolved);
    const hint = modifier === 'Ctrl' ? 'Ctrl K' : `${modifier}K`;

    return (
        <div
            data-title-bar
            // The bar is the window's drag region (the OS title bar is hidden); every control inside
            // opts out below. The right padding is the width of the native window buttons the overlay
            // draws there on Windows/Linux — zero where there is no overlay.
            className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-2.5 [-webkit-app-region:drag]"
            // The measured space the native buttons take, plus the bar's own padding: nothing sits under them.
            data-controls-inset={controlsInset}
            style={{ paddingRight: `calc(${controlsInset}px + 10px)` }}
        >
            {/* The mark is a button, not an ornament: clicking it lands on the Dashboard. */}
            <button
                type="button"
                data-nav="genie://dashboard"
                aria-label="Genie — Dashboard"
                onClick={() => onNavigate('genie://dashboard')}
                className="[-webkit-app-region:no-drag] flex shrink-0 items-center gap-2"
            >
                <span
                    data-brand-mark
                    aria-hidden="true"
                    className="size-[18px] rounded-[5px] bg-gradient-to-br from-[var(--brand-grad-from)] via-[var(--brand-grad-via)] to-[var(--brand-grad-to)]"
                />
                <span className="text-[13px] font-semibold">Genie</span>
            </button>

            {/*
             * The four feature icons — GApps, Knowledge Graph, Flows, Genie OSA.
             *
             * The owner's decision, and the one thing the design board does not carry because
             * it predates it. Every one has an `aria-label` AND a tooltip from the same
             * string: four unexplained glyphs in the chrome is how a finished feature ships
             * and nobody ever finds it, which is exactly what happened to the Conversation UI.
             */}
            <div className="flex shrink-0 items-center gap-0.5">
                {FEATURE_ICONS.map((f) => (
                    <Tooltip key={f.label} content={f.label} placement="bottom">
                        <button
                            type="button"
                            data-feature={f.label}
                            aria-label={f.label}
                            onClick={() => onNavigate(f.route)}
                            className="[-webkit-app-region:no-drag] flex size-6 items-center justify-center rounded-md text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]"
                        >
                            <Icon name={f.icon} size="sm" />
                        </button>
                    </Tooltip>
                ))}
            </div>

            <span data-route className="truncate font-mono text-[11px] text-[var(--fg-4)]">
                {route}
            </span>

            {/*
             * The palette box. A button rather than an input: the real palette is Fancy's
             * `Command`, which owns its own input when it opens — two inputs for one search is
             * a focus fight nobody wins.
             */}
            <button
                type="button"
                data-palette
                aria-label="Search, jump, run"
                onClick={onOpenPalette}
                className="[-webkit-app-region:no-drag] mx-auto flex h-6 w-[280px] shrink-0 items-center gap-2 rounded-md border border-[var(--border-1)] px-2 text-[var(--fg-4)] hover:border-[var(--border-2)]"
            >
                <Icon name="search" size="xs" />
                <span className="text-xs">Search, jump, run</span>
                {/*
                 * The key this reader actually has. `⌘K` on Windows or Linux tells somebody to
                 * press a key that is not on their keyboard — and a reader who cannot act on a
                 * hint learns to ignore hints.
                 */}
                <span data-palette-hint className="ml-auto whitespace-nowrap font-mono text-[11px]">{hint}</span>
            </button>

            {/*
             * The workstation chip. Health is a DOT, not a word — the word would be read as a
             * status message and this is a persistent reading. A remote workstation shows its
             * own chip here, which is how "am I driving another machine" stays answerable.
             */}
            {remote ? (
                <div
                    data-remote-badge
                    className="flex shrink-0 items-center gap-2 rounded-md bg-[var(--warning)]/15 px-2 py-0.5 font-mono text-[11px] text-[var(--warning)]"
                >
                    <span className="font-semibold">{remoteBadge(remote.host)}</span>
                    <span className="text-[var(--fg-3)]">{remote.locked ? 'locked' : remote.driving ? 'you are driving' : remote.driver ? `${remote.driver} is driving` : 'nobody is driving'}</span>
                </div>
            ) : null}
            {/* THE UPDATE (the owner: "in the header, not buried in the deck page"): a button when there is a next step. */}
            {update ? (
                update.action && onUpdateAction ? (
                    <button
                        type="button"
                        data-update-chip={update.phase}
                        data-update-action={update.action}
                        onClick={() => onUpdateAction(update.action!)}
                        // no-drag: in the bar's drag region a click is the OS's, and this button never heard it (the owner, beta.21).
                        className="[-webkit-app-region:no-drag] flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--primary)]/15 px-2 py-0.5 text-[11px] font-medium text-[var(--primary)] hover:bg-[var(--primary)]/25"
                    >
                        <Icon name={update.action === 'update-install' ? 'rotate-cw' : 'download'} size="xs" />
                        {update.label}
                    </button>
                ) : (
                    <span data-update-chip={update.phase} className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--bg-2)] px-2 py-0.5 text-[11px] text-[var(--fg-3)]">
                        <Icon name="download" size="xs" />
                        {update.label}
                    </span>
                )
            ) : null}
            {workstation ? (
                <div
                    data-workstation-health={workstation.healthy ? 'healthy' : 'unhealthy'}
                    className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-[var(--fg-3)]"
                >
                    <span
                        aria-hidden="true"
                        className={`size-1.5 rounded-full ${workstation.healthy ? 'bg-[var(--success)]' : 'bg-[var(--danger)]'}`}
                    />
                    {workstation.name}
                </div>
            ) : null}
        </div>
    );
}
