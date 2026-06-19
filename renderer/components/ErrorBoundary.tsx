import React from 'react';

interface ErrorBoundaryProps {
    children: React.ReactNode;
    /**
     * Compact, INLINE fallback (a small error card) instead of the full-screen
     * takeover. Use to isolate a single panel (a terminal, the code view) so
     * its crash doesn't blank the whole app.
     */
    compact?: boolean;
    /** Short label for the compact fallback, e.g. "Code", "Terminal". */
    name?: string;
    /**
     * When any value here changes, a boundary in the error state auto-resets.
     * Keying this on the selected workspace / open file means switching away
     * from a crashing surface recovers WITHOUT a manual reload — the loop the
     * old root-only boundary left users stuck in.
     */
    resetKeys?: ReadonlyArray<unknown>;
}

/**
 * Renderer safety net. A synchronous throw below this renders a debuggable
 * surface instead of a blank window — full-screen at the app root, or a compact
 * inline card when scoped to a panel. `resetKeys` lets it self-heal on
 * navigation. Logs the full error to the renderer console.
 */
export default class ErrorBoundary extends React.Component<
    ErrorBoundaryProps,
    { error: Error | null; info: string | null }
> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = { error: null, info: null };
    }

    static getDerivedStateFromError(error: Error) {
        return { error, info: null };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        // eslint-disable-next-line no-console
        console.error('[Genie renderer error]', this.props.name ?? '', error, info);
        this.setState({ error, info: info.componentStack ?? null });
    }

    componentDidUpdate(prev: ErrorBoundaryProps) {
        // Auto-reset when the caller's resetKeys change (e.g. workspace switch),
        // so a user is never trapped on a surface that crashes every render.
        if (this.state.error && !shallowEqual(prev.resetKeys, this.props.resetKeys)) {
            this.setState({ error: null, info: null });
        }
    }

    render() {
        if (!this.state.error) return this.props.children;

        if (this.props.compact) {
            return (
                <div
                    style={{
                        margin: 8,
                        padding: 12,
                        background: 'var(--bg-2)',
                        border: '1px solid color-mix(in srgb, #f43f5e 35%, var(--border-1))',
                        borderRadius: 8,
                        color: 'var(--fg-1)',
                        fontSize: 13,
                    }}
                >
                    <div style={{ fontWeight: 600 }}>
                        {this.props.name ? `${this.props.name} hit an error` : 'This panel hit an error'}
                    </div>
                    <pre
                        style={{
                            marginTop: 6,
                            color: 'var(--rose-500)',
                            fontSize: 11,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            maxHeight: 120,
                            overflow: 'auto',
                        }}
                    >
                        {String(this.state.error?.message ?? this.state.error)}
                    </pre>
                    <button
                        type="button"
                        onClick={() => this.setState({ error: null, info: null })}
                        style={{
                            marginTop: 8,
                            padding: '4px 12px',
                            background: 'var(--bg-1)',
                            color: 'var(--fg-1)',
                            border: '1px solid var(--border-1)',
                            borderRadius: 6,
                            cursor: 'pointer',
                            fontSize: 12,
                        }}
                    >
                        Retry
                    </button>
                </div>
            );
        }

        return (
            <div
                style={{
                    minHeight: '100vh',
                    padding: 24,
                    background: 'var(--bg-0)',
                    color: 'var(--fg-1)',
                    fontFamily:
                        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                }}
            >
                <h1 style={{ margin: 0, fontSize: 18 }}>Genie hit an error</h1>
                <p
                    style={{
                        marginTop: 8,
                        color: 'var(--fg-3)',
                        fontSize: 13,
                        lineHeight: 1.5,
                    }}
                >
                    The renderer threw before reaching steady state. Common
                    causes: <code>window.genie</code> is undefined (preload
                    didn't load), a backend call returned an unexpected shape,
                    or a SQLite migration in main failed.
                </p>
                <pre
                    style={{
                        marginTop: 12,
                        padding: 12,
                        background: 'var(--bg-2)',
                        color: 'var(--rose-500)',
                        borderRadius: 8,
                        fontSize: 12,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        maxHeight: 240,
                        overflow: 'auto',
                    }}
                >
                    {String(this.state.error?.stack ?? this.state.error)}
                </pre>
                {this.state.info && (
                    <details
                        style={{ marginTop: 8, color: 'var(--fg-3)', fontSize: 12 }}
                    >
                        <summary>Component stack</summary>
                        <pre style={{ whiteSpace: 'pre-wrap' }}>
                            {this.state.info}
                        </pre>
                    </details>
                )}
                <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
                    <button
                        type="button"
                        onClick={() => window.location.reload()}
                        style={{
                            padding: '6px 14px',
                            background: 'var(--blue-500)',
                            color: '#fff',
                            border: 0,
                            borderRadius: 8,
                            cursor: 'pointer',
                        }}
                    >
                        Reload
                    </button>
                    <button
                        type="button"
                        onClick={() => this.setState({ error: null, info: null })}
                        style={{
                            padding: '6px 14px',
                            background: 'var(--bg-2)',
                            color: 'var(--fg-1)',
                            border: '1px solid var(--border-1)',
                            borderRadius: 8,
                            cursor: 'pointer',
                        }}
                    >
                        Dismiss
                    </button>
                </div>
            </div>
        );
    }
}

function shallowEqual(a?: ReadonlyArray<unknown>, b?: ReadonlyArray<unknown>): boolean {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    return a.every((v, i) => Object.is(v, b[i]));
}
