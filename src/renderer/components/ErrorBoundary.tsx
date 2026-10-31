import { Component, type ErrorInfo, type ReactNode } from 'react';
import { renderErrorDetails, renderErrorLine } from '../../core/render-error.js';
import { CopyAnnounce, copyWords, useCopyText } from './CopyText.js';

/**
 * ONE SURFACE'S RENDER ERROR STAYS IN THAT SURFACE (parity audit 2026-10-30, top-15 #7).
 *
 * Genie 2's renderer had no boundary at all: one render throw anywhere unmounted the whole tree and left the window blank
 * until a reload. This is Genie 1's (`renderer/components/ErrorBoundary.tsx`, v0.7.0-beta.342), carried over:
 *
 * - **Compact by default.** A failed surface draws a small card in its place — "<surface> failed to draw", the error,
 *   Retry — and everything around it keeps working (Genie 1's `compact` variant, around each terminal at
 *   `Master/TerminalGrid.tsx:552` and each settings section at `pages/settings.tsx:992`).
 * - **`whole`** is the root's: the whole window, with Reload too (Genie 1's default variant, at `pages/_app.tsx:91`). It
 *   is the last net, under every surface's own.
 * - **`resetKeys`.** When any of them changes, a boundary showing its card tries again — so navigating away from a
 *   surface that crashed recovers without a manual Retry or a reload (Genie 1: "the loop the old root-only boundary left
 *   users stuck in").
 *
 * Added beyond Genie 1: **Copy details** (surface, message, stack, component stack — for an issue), and the error goes to
 * GENIE'S LOG, not only the renderer console: one line main forwards to `~/.genie/runtime/lifecycle.log`
 * (core/render-error.ts). Genie 1 logged to the console alone, which reaches no file.
 */
export interface ErrorBoundaryProps {
    /** The surface's name, as the person knows it: "Dashboard", "Chat", "Tynn". */
    surface: string;
    /** The root's variant: fills the window and offers Reload. */
    whole?: boolean | undefined;
    /** A change in any of these resets a boundary that is showing its card. */
    resetKeys?: ReadonlyArray<unknown> | undefined;
    children: ReactNode;
}

interface State {
    error: unknown;
    failed: boolean;
    componentStack: string | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
    override state: State = { error: null, failed: false, componentStack: null };

    static getDerivedStateFromError(error: unknown): Partial<State> {
        return { error, failed: true };
    }

    override componentDidCatch(error: unknown, info: ErrorInfo): void {
        // ONE line, which main forwards to Genie's log (core/render-error.ts); the error object itself after it, for DevTools.
        console.error(renderErrorLine(this.props.surface, error));
        console.error(error);
        this.setState({ componentStack: info.componentStack ?? null });
    }

    override componentDidUpdate(prev: ErrorBoundaryProps): void {
        if (this.state.failed && !sameKeys(prev.resetKeys, this.props.resetKeys)) this.retry();
    }

    retry = (): void => {
        this.setState({ error: null, failed: false, componentStack: null });
    };

    override render(): ReactNode {
        if (!this.state.failed) return this.props.children;
        return <SurfaceFailed surface={this.props.surface} whole={this.props.whole === true} error={this.state.error} componentStack={this.state.componentStack} onRetry={this.retry} />;
    }
}

function sameKeys(a?: ReadonlyArray<unknown>, b?: ReadonlyArray<unknown>): boolean {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    return a.every((v, i) => Object.is(v, b[i]));
}

const BUTTON = 'rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2.5 py-1 text-xs text-[var(--fg-1)] hover:bg-[var(--bg-2)]';

/** The card a failed surface draws in its place. */
function SurfaceFailed({ surface, whole, error, componentStack, onRetry }: { surface: string; whole: boolean; error: unknown; componentStack: string | null; onRetry: () => void }) {
    const copy = useCopyText();
    const message = error instanceof Error ? error.message || error.name : String(error);
    return (
        <div
            role="alert"
            data-surface-failed={surface}
            data-whole={whole ? 'true' : 'false'}
            className={whole ? 'flex h-full min-h-screen flex-col items-start gap-3 bg-[var(--bg-0)] p-6 text-[var(--fg-1)]' : 'm-2 flex flex-col items-start gap-2 rounded-lg border border-[color-mix(in_srgb,var(--rose-500,#f43f5e)_35%,var(--border-1))] bg-[var(--bg-2)] p-3 text-[13px] text-[var(--fg-1)]'}
        >
            <div className={whole ? 'text-lg font-semibold' : 'font-semibold'}>{whole ? 'Genie failed to draw' : `${surface} failed to draw`}</div>
            {whole ? <p className="text-[13px] text-[var(--fg-3)]">Agents, terminals and sites keep running in the background. Retry draws the window again; Reload starts it fresh.</p> : <p className="text-[12px] text-[var(--fg-3)]">The rest of Genie keeps working.</p>}
            <pre data-surface-error="" className="max-h-32 w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--rose-500,#f43f5e)]">{message}</pre>
            <div className="flex items-center gap-2">
                <button type="button" data-surface-retry="" onClick={onRetry} className={BUTTON}>Retry</button>
                {whole ? <button type="button" data-surface-reload="" onClick={() => window.location.reload()} className={BUTTON}>Reload</button> : null}
                <button
                    type="button"
                    data-surface-copy=""
                    onClick={() => { void copy.copy(renderErrorDetails({ surface, error, componentStack })); }}
                    className={BUTTON}
                >
                    {copyWords(copy.state, 'Copy details')}
                </button>
                <CopyAnnounce state={copy.state} />
            </div>
        </div>
    );
}
