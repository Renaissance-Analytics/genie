import { useEffect, useRef, type ComponentType } from 'react';
import type { TerminalPaneProps } from './TerminalPane.js';

/**
 * A TERMINAL PANEL IS ONE TERMINAL (beta.33 item 9; the owner, 2026-10-20: "A … terminal panel is 1 panel for that
 * terminal. All this extra shit is stupid and already part of the Panel Design ux for custom tabs."). The cell shows the
 * ONE terminal it names, filling it — no layout modes, no `+ terminal`, no strip of shells: several terminals are
 * several panels, laid out by the tab. A cell with no terminal yet starts one, once (Genie 1's grid: the default shell,
 * no picker), and keeps it. A terminal that ended, or is no longer there, is said — with Start a new terminal — and is
 * never replaced by some other terminal.
 */
export interface TerminalCellProps {
    /** The terminal the cell names, or `null` = none yet. */
    readonly terminalId: string | null;
    /** The terminal as the workspace holds it, or `null` when it is not there. */
    readonly terminal: { readonly id: string; readonly exited: number | null } | null;
    readonly output: string;
    /** The pane, once its code has loaded (Workspace loads it lazily). */
    readonly Pane: ComponentType<TerminalPaneProps> | null;
    readonly root: string;
    readonly onData: (id: string, data: string) => void;
    readonly onResize: (id: string, size: { cols: number; rows: number }) => void;
    readonly onOpenFile?: TerminalPaneProps['onOpenFile'];
    /** Start a terminal and put it in this cell. */
    readonly onStart: () => void;
}

export function TerminalCell(p: TerminalCellProps) {
    // Started once per mount, whatever re-renders happen while the new terminal is opening.
    const started = useRef(false);
    useEffect(() => {
        if (p.terminalId !== null || started.current) return;
        started.current = true;
        p.onStart();
    }, [p.terminalId, p.onStart]);

    if (p.terminalId === null) {
        return <div data-terminal-panel-starting="" className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-[var(--fg-3)]">Starting a terminal…</div>;
    }
    const restart = (
        <button type="button" data-action="terminal-panel-restart" onClick={p.onStart} className="rounded-md border border-[var(--border-1)] px-2 py-0.5 text-[12px] text-[var(--fg-2)] hover:bg-[var(--bg-2)]">
            Start a new terminal
        </button>
    );
    if (p.terminal === null) {
        return (
            <div data-terminal-panel-gone={p.terminalId} className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-[12px] text-[var(--fg-3)]">
                <p>This terminal is no longer open.</p>
                {restart}
            </div>
        );
    }
    const t = p.terminal;
    return (
        <div data-terminal-panel={t.id} {...(t.exited === null ? {} : { 'data-exited': String(t.exited) })} className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg-0)]">
            {t.exited !== null ? (
                <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-1)] px-2 py-1 text-[11px] text-[var(--fg-3)]">
                    <span>This terminal ended (exit {t.exited}).</span>
                    {restart}
                </div>
            ) : null}
            <div className="min-h-0 min-w-0 flex-1">
                {p.Pane ? (
                    <p.Pane
                        paneId={t.id}
                        output={p.output}
                        readOnly={t.exited !== null}
                        onData={(data) => p.onData(t.id, data)}
                        onResize={(size) => p.onResize(t.id, size)}
                        root={p.root}
                        {...(p.onOpenFile ? { onOpenFile: p.onOpenFile } : {})}
                    />
                ) : null}
            </div>
        </div>
    );
}
