import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import {
    activate,
    emptyWorkspace,
    terminalClosed,
    terminalData,
    terminalExited,
    terminalOpened,
    type WorkspaceState,
} from '../../core/workspace-view.js';
import { Icon } from '@particle-academy/react-fancy';
import type { GenieBridge } from '../bridge.js';
import type { TerminalPaneProps } from './TerminalPane.js';

/**
 * THE WORKSPACE SURFACE — §4.6. Terminals, for shells, builds, services and hosted sites.
 *
 * **No agent has one.** The only ids on this surface are workspace ids and terminal ids; the
 * bridge it talks to cannot express an agent, and that absence is the renderer's half of the
 * one rule.
 *
 * ## Shape
 *
 * A 32px tab strip — one tab per terminal, `+ terminal` at the end — over a single pane that
 * shows the ACTIVE terminal. `fancy-term`'s `<Terminal>` renders it: the controlled `output`
 * prop takes the whole buffer and writes only the appended delta; keystrokes come back through
 * `onData` and go to the pty; `onResize` keeps the pty's grid in step with the pane.
 *
 * Inactive terminals are not rendered at all. Their output accumulates in state and is written
 * in one piece when they become active, which is what `output` is for — rendering six xterms
 * to show one is six times the work for nothing on screen.
 *
 * State lives in `workspace-view.ts` and is pure; this file owns the wiring and nothing else.
 */

export interface WorkspaceProps {
    /** The registry's workspace row. `name` is optional there, so the id stands in — never an invented label. */
    workspace: { id: string; name?: string; path: string };
    terminals: GenieBridge['terminals'];
}

export function Workspace({ workspace, terminals }: WorkspaceProps) {
    const [state, setState] = useState<WorkspaceState>(emptyWorkspace);
    /*
     * The xterm pane, loaded CLIENT-SIDE ONLY. `@xterm/xterm` touches `self` at module
     * evaluation, so a static import of `fancy-term` anywhere Node can reach — the SSR render
     * tests — throws before any component runs. `TerminalPane.tsx` is the one module that
     * imports it, and it is reached only from this effect, which never runs under
     * `react-dom/server`. Until it resolves the pane renders nothing; the empty state and the
     * tab strip do not wait for it.
     */
    const [Pane, setPane] = useState<ComponentType<TerminalPaneProps> | null>(null);
    useEffect(() => {
        let live = true;
        void import('./TerminalPane.js').then((m) => { if (live) setPane(() => m.TerminalPane); });
        return () => { live = false; };
    }, []);
    /** A pane size the engine can be opened at, so the first paint is not the wrong shape. */
    const lastSize = useRef<{ cols: number; rows: number }>({ cols: 120, rows: 30 });

    // Output and exits for EVERY terminal arrive on the same channel; the reducer drops what is
    // not this workspace's. Subscribed once per mount, released on unmount — the old build
    // leaked one listener per reopened panel.
    useEffect(() => {
        const offData = terminals.onData((id, data) => setState((s) => terminalData(s, id, data)));
        const offExit = terminals.onExit((id, code) => setState((s) => terminalExited(s, id, code)));
        return () => {
            offData();
            offExit();
        };
    }, [terminals]);

    // Re-attach to terminals already open in this workspace — a reloaded window joins a running
    // build rather than losing it (§6.5). Their scrollback comes with the open.
    useEffect(() => {
        let live = true;
        void terminals.list(workspace.id).then((open) => {
            if (!live) return;
            for (const t of open) {
                void terminals
                    .open(workspace.id, { ...lastSize.current })
                    .then((opened) => {
                        if (!live) return;
                        setState((s) => terminalOpened(s, { ...t, workspaceId: workspace.id, exited: null }, opened.scrollback));
                    });
            }
        });
        return () => { live = false; };
    }, [terminals, workspace.id]);

    const openTerminal = useCallback(() => {
        void terminals.open(workspace.id, { ...lastSize.current }).then((opened) => {
            setState((s) =>
                terminalOpened(
                    s,
                    { id: opened.id, workspaceId: workspace.id, shell: opened.shell, pid: opened.pid, exited: null },
                    opened.scrollback,
                ),
            );
        });
    }, [terminals, workspace.id]);

    const closeTerminal = useCallback(
        (id: string) => {
            terminals.close(id);
            setState((s) => terminalClosed(s, id));
        },
        [terminals],
    );

    const active = state.terminals.find((t) => t.id === state.active) ?? null;

    return (
        <section data-surface="workspace" data-workspace={workspace.id} className="flex h-full min-h-0 flex-col">
            {/* View header, 56px — the workspace's name and path, like the Dashboard's group header. */}
            <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border-1)] px-5">
                <h1 className="text-[18px] font-semibold text-[var(--fg-1)]">{workspace.name ?? workspace.id}</h1>
                <span className="font-mono text-[11px] text-[var(--fg-4)]">{workspace.path}</span>
            </header>

            {/* Tab strip, 32px. One tab per terminal; the add button last. */}
            <div data-terminal-tabs="" className="flex h-8 shrink-0 items-stretch border-b border-[var(--border-1)] bg-[var(--bg-1)]">
                {state.terminals.map((t) => {
                    const isActive = t.id === state.active;
                    return (
                        <div
                            key={t.id}
                            data-terminal-tab={t.id}
                            data-active={isActive ? 'true' : 'false'}
                            {...(t.exited === null ? {} : { 'data-exited': String(t.exited) })}
                            className={`flex items-center gap-2 border-r border-[var(--border-1)] px-3 text-[12px] ${
                                isActive ? 'bg-[var(--bg-0)] text-[var(--fg-1)]' : 'text-[var(--fg-3)] hover:bg-[var(--bg-2)]'
                            }`}
                        >
                            <button type="button" onClick={() => setState((s) => activate(s, t.id))} className="flex items-center gap-2">
                                <Icon name="square-terminal" className="h-3.5 w-3.5" />
                                <span className="font-mono">{t.shell.split(/[\\/]/).pop()}</span>
                                {/*
                                 * An ended shell says so, with its code. `0` is an exit too: the
                                 * attribute is present for any number and absent only while
                                 * running — never a truthiness check (§5).
                                 */}
                                {t.exited === null ? null : (
                                    <span className="font-mono text-[11px] text-[var(--fg-4)]">exit {t.exited}</span>
                                )}
                            </button>
                            <button
                                type="button"
                                aria-label="Close terminal"
                                data-terminal-close={t.id}
                                onClick={() => closeTerminal(t.id)}
                                className="rounded px-1 text-[var(--fg-4)] hover:bg-[var(--bg-3)] hover:text-[var(--fg-1)]"
                            >
                                <Icon name="x" className="h-3 w-3" />
                            </button>
                        </div>
                    );
                })}
                <button
                    type="button"
                    data-terminal-add=""
                    onClick={openTerminal}
                    className="flex items-center gap-1.5 px-3 text-[12px] text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]"
                >
                    <Icon name="plus" className="h-3.5 w-3.5" />
                    terminal
                </button>
            </div>

            {/* The pane. One xterm, for the active terminal; an invitation when there is none. */}
            <div className="min-h-0 flex-1 bg-[var(--bg-0)]">
                {active && Pane ? (
                    <Pane
                        key={active.id}
                        paneId={active.id}
                        output={state.output[active.id] ?? ''}
                        readOnly={active.exited !== null}
                        onData={(data) => terminals.write(active.id, data)}
                        onResize={({ cols, rows }) => {
                            lastSize.current = { cols, rows };
                            terminals.resize(active.id, cols, rows);
                        }}
                    />
                ) : active ? null : (
                    <div data-terminal-empty="" className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-[var(--fg-3)]">
                        <p>No terminals open in {workspace.name ?? workspace.id}.</p>
                        <button
                            type="button"
                            data-terminal-add-empty=""
                            onClick={openTerminal}
                            className="rounded-md border border-[var(--border-1)] px-2.5 py-1 text-xs hover:bg-[var(--bg-2)]"
                        >
                            Open a terminal
                        </button>
                    </div>
                )}
            </div>
        </section>
    );
}
