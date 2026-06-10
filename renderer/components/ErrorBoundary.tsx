import React from 'react';

/**
 * Last-resort safety net for the renderer. If any component below this
 * throws synchronously, we render a debuggable surface instead of the
 * dreaded blank window. Tells the user where to look + offers a reload
 * button. Logs the full error to the renderer console.
 */
export default class ErrorBoundary extends React.Component<
    { children: React.ReactNode },
    { error: Error | null; info: string | null }
> {
    constructor(props: { children: React.ReactNode }) {
        super(props);
        this.state = { error: null, info: null };
    }

    static getDerivedStateFromError(error: Error) {
        return { error, info: null };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        // eslint-disable-next-line no-console
        console.error('[Genie renderer error]', error, info);
        this.setState({ error, info: info.componentStack ?? null });
    }

    render() {
        if (!this.state.error) return this.props.children;

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
