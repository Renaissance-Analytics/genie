import { useEffect, useRef, useState, type ComponentType } from 'react';
import type { GenieBridge } from '../bridge.js';
import type { TerminalPaneProps } from './TerminalPane.js';

/**
 * THE TAKE OVER WINDOW — one terminal, nothing else (§1).
 *
 * A second BrowserWindow loads the renderer with `genie://takeover/<terminalId>` and `App`
 * renders this instead of the Shell: no rail, no title bar, no Deck. The TUI is the window.
 *
 * It does not open the terminal — the main process did, at the click — it ATTACHES: asks for
 * the terminal's scrollback through `open` (which re-joins an existing pty rather than
 * spawning), then streams. Closing the window is what ends the TUI, and that is the main
 * process's `closed` handler, not anything here.
 *
 * The pane is the same client-side-only `TerminalPane` the Workspace uses, for the same
 * reason: `@xterm/addon-fit` cannot be evaluated under Node.
 */

export interface TakeOverWindowProps {
    terminalId: string;
    terminals: GenieBridge['terminals'];
}

export function TakeOverWindow({ terminalId, terminals }: TakeOverWindowProps) {
    const [output, setOutput] = useState('');
    const [exited, setExited] = useState<number | null>(null);
    const [Pane, setPane] = useState<ComponentType<TerminalPaneProps> | null>(null);
    const size = useRef<{ cols: number; rows: number }>({ cols: 120, rows: 36 });

    useEffect(() => {
        let live = true;
        void import('./TerminalPane.js').then((m) => { if (live) setPane(() => m.TerminalPane); });
        return () => { live = false; };
    }, []);

    // A reopened window JOINS the TUI (§6.5): the scrollback so far seeds the pane; the live bytes follow. The
    // window is the host's own, so it may join whichever workspace the terminal is in (null).
    useEffect(() => {
        let live = true;
        void terminals.attach(null, terminalId).then((joined) => {
            if (live && joined) setOutput((o) => (o.length === 0 ? joined.scrollback : o));
        });
        return () => { live = false; };
    }, [terminals, terminalId]);

    // Output for every terminal arrives on one channel; keep only this window's.
    useEffect(() => {
        const offData = terminals.onData((id, data) => { if (id === terminalId) setOutput((o) => o + data); });
        const offExit = terminals.onExit((id, code) => { if (id === terminalId) setExited(code); });
        return () => { offData(); offExit(); };
    }, [terminals, terminalId]);

    return (
        <main data-surface="takeover" data-terminal={terminalId} className="h-screen w-screen bg-[var(--bg-0)]">
            {Pane ? (
                <Pane
                    paneId={terminalId}
                    output={output}
                    readOnly={exited !== null}
                    onData={(data) => terminals.write(terminalId, data)}
                    onResize={({ cols, rows }) => {
                        size.current = { cols, rows };
                        terminals.resize(terminalId, cols, rows);
                    }}
                />
            ) : null}
            {/*
             * The TUI ended. The window stays so the last screen can be read; its title says
             * what happened, with the code. Closing it is the user's, and there is nothing to
             * restart — Genie does not manage this (§1).
             */}
            {exited !== null ? (
                <div data-takeover-ended={exited} className="absolute inset-x-0 top-0 bg-[var(--bg-2)] px-3 py-1 font-mono text-[11px] text-[var(--fg-3)]">
                    the TUI exited with code {exited} — close this window when you are done reading
                </div>
            ) : null}
        </main>
    );
}
