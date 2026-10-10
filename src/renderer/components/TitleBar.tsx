import { Icon, Tooltip } from '@particle-academy/react-fancy';
import { FEATURE_ICONS } from '../../core/rail-view.js';

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
    onNavigate: (route: string) => void;
    onOpenPalette: () => void;
}

export function TitleBar({ route, workstation, onNavigate, onOpenPalette }: TitleBarProps) {
    return (
        <div className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-2.5">
            {/* The mark is a button, not an ornament: clicking it lands on the Dashboard. */}
            <button
                type="button"
                data-nav="genie://dashboard"
                aria-label="Genie — Dashboard"
                onClick={() => onNavigate('genie://dashboard')}
                className="flex shrink-0 items-center gap-2"
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
                            className="flex size-6 items-center justify-center rounded-md text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]"
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
                className="mx-auto flex h-6 w-[280px] shrink-0 items-center gap-2 rounded-md border border-[var(--border-1)] px-2 text-[var(--fg-4)] hover:border-[var(--border-2)]"
            >
                <Icon name="search" size="xs" />
                <span className="text-xs">Search, jump, run</span>
                <span className="ml-auto font-mono text-[11px]">⌘K</span>
            </button>

            {/*
             * The workstation chip. Health is a DOT, not a word — the word would be read as a
             * status message and this is a persistent reading. A remote workstation shows its
             * own chip here, which is how "am I driving another machine" stays answerable.
             */}
            {workstation ? (
                <div
                    data-workstation-health={workstation.healthy ? 'healthy' : 'unhealthy'}
                    className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-[var(--fg-3)]"
                >
                    <span
                        aria-hidden="true"
                        className={`size-1.5 rounded-full ${workstation.healthy ? 'bg-emerald-500' : 'bg-red-500'}`}
                    />
                    {workstation.name}
                </div>
            ) : null}
        </div>
    );
}
