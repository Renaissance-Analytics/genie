import { useEffect, useRef, useState } from 'react';
import { Terminal as XtermTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Icon, Text } from '@particle-academy/react-fancy';
import '@xterm/xterm/css/xterm.css';
import {
    connectTerminal,
    type MobileTerminal,
    type TerminalConnection,
} from '../../lib/mobile-client';

/**
 * A FRESH, thin xterm for the phone — deliberately NOT
 * `components/Terminal/XTerm.tsx` (that one is wired to the Electron IPC bridge,
 * which doesn't exist over the wire). This instance talks ONLY to the
 * `/ws/term` bridge via `connectTerminal`:
 *   down  `data`    → term.write
 *   down  `dropped` → write a dim "[output dropped]" marker (backpressure)
 *   down  `exit`    → write the exit line + flag closed
 *   up    onData    → {type:'input'} (raw bytes)
 *   up    fit       → {type:'resize',cols,rows}
 *
 * On-screen key row gives touch users the keys a soft keyboard can't: Esc,
 * Ctrl-C, Enter, and the four arrows. Detaching (unmount / picking another
 * terminal) only closes the socket — the pty keeps running (viewer-only).
 */

// Raw byte sequences for the on-screen keys (xterm-style).
const KEYS: Array<{ label: string; seq: string; aria: string; wide?: boolean }> = [
    { label: 'Esc', seq: '\x1b', aria: 'Escape' },
    { label: 'Ctrl-C', seq: '\x03', aria: 'Control C' },
    { label: '↑', seq: '\x1b[A', aria: 'Up arrow' },
    { label: '↓', seq: '\x1b[B', aria: 'Down arrow' },
    { label: '←', seq: '\x1b[D', aria: 'Left arrow' },
    { label: '→', seq: '\x1b[C', aria: 'Right arrow' },
    { label: 'Enter', seq: '\r', aria: 'Enter', wide: true },
];

export default function MobileTerminalView({
    terminal,
}: {
    terminal: MobileTerminal;
}) {
    const hostRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<XtermTerminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const connRef = useRef<TerminalConnection | null>(null);
    const [exited, setExited] = useState<{ exitCode?: number } | null>(null);

    // One effect owns the whole xterm + WS lifecycle, keyed on the terminal id
    // so switching terminals tears down cleanly and rebuilds.
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;

        setExited(null);

        const term = new XtermTerminal({
            cursorBlink: true,
            fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, "Cascadia Code", Consolas, monospace',
            fontSize: 13,
            theme: { background: '#09090b', foreground: '#fafafa' },
            // Touch scrolling produces lots of wheel events; a roomy scrollback
            // keeps history without runaway memory.
            scrollback: 5_000,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(host);
        termRef.current = term;
        fitRef.current = fit;

        // Fit once mounted, then on every viewport change (rotation, soft
        // keyboard). Each fit pushes the new grid down to the pty.
        const doFit = () => {
            try {
                fit.fit();
                conn?.sendResize(term.cols, term.rows);
            } catch {
                /* host briefly zero-sized (during layout) — next fit recovers */
            }
        };

        // Connect the byte bridge. data → write, dropped → marker, exit → line.
        const conn = connectTerminal(terminal.id, {
            onData: (data) => term.write(data),
            onDropped: () =>
                term.write('\r\n\x1b[2m[output dropped]\x1b[0m\r\n'),
            onExit: ({ exitCode }) => {
                term.write(
                    `\r\n\x1b[2m[process exited${
                        exitCode != null ? ` with code ${exitCode}` : ''
                    }]\x1b[0m\r\n`,
                );
                setExited({ exitCode });
            },
        });
        connRef.current = conn;

        // Raw keystrokes up to the pty.
        const onDataDisp = term.onData((data) => conn.sendInput(data));

        // Initial fit after the browser has laid the host out.
        const raf = requestAnimationFrame(doFit);
        const ro = new ResizeObserver(doFit);
        ro.observe(host);
        window.addEventListener('resize', doFit);

        term.focus();

        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener('resize', doFit);
            ro.disconnect();
            onDataDisp.dispose();
            conn.close();
            term.dispose();
            termRef.current = null;
            fitRef.current = null;
            connRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [terminal.id]);

    const sendKey = (seq: string) => {
        connRef.current?.sendInput(seq);
        termRef.current?.focus();
    };

    return (
        <div className="m-term">
            <div className="m-term-bar">
                <Icon name="terminal" size="xs" />
                <Text size="xs" className="m-mono m-truncate" style={{ fontWeight: 600 }}>
                    {terminal.label}
                </Text>
                {exited && (
                    <span className="m-term-exited">
                        exited{exited.exitCode != null ? ` (${exited.exitCode})` : ''}
                    </span>
                )}
            </div>

            <div ref={hostRef} className="m-term-host" />

            <div className="m-keyrow">
                {KEYS.map((k) => (
                    <button
                        key={k.label}
                        type="button"
                        className={`m-key${k.wide ? ' m-key-wide' : ''}`}
                        aria-label={k.aria}
                        onClick={() => sendKey(k.seq)}
                    >
                        {k.label}
                    </button>
                ))}
            </div>
        </div>
    );
}
