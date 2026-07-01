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
 * `components/Terminal/Terminal.tsx` (that one is wired to the Electron IPC bridge,
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
 *
 * LANDSCAPE ONLY: the pty is shared with the desktop. The xterm + its FitAddon
 * are mounted ONLY in landscape; in portrait we show a "rotate your phone"
 * overlay and mount nothing. This keeps the phone's grid wide enough that the
 * grow-only pty guard (server side) never has to clamp, and avoids fitting to a
 * tall-skinny portrait grid the desktop would otherwise inherit. Mobile-web
 * can't hard-lock orientation (iOS Safari ignores the Screen Orientation API
 * outside fullscreen), so we DETECT portrait via matchMedia and gate the mount;
 * a best-effort `screen.orientation.lock('landscape')` is attempted but never
 * depended on.
 */

/**
 * Track portrait vs landscape via matchMedia, and make a best-effort (never
 * relied-on) attempt to lock landscape. Returns true while the viewport is
 * portrait. We default to landscape (false) on the server / when matchMedia is
 * unavailable so SSR + odd browsers don't flash the overlay.
 */
function usePortrait(): boolean {
    const [portrait, setPortrait] = useState(false);
    useEffect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return;
        const mq = window.matchMedia('(orientation: portrait)');
        const apply = () => setPortrait(mq.matches);
        apply();
        // Best-effort landscape lock — works only in fullscreen on some
        // browsers and is a hard no-op on iOS Safari; we never depend on it.
        try {
            const orientation = (
                window.screen as unknown as {
                    orientation?: { lock?: (o: string) => Promise<void> };
                }
            ).orientation;
            void orientation?.lock?.('landscape').catch(() => {});
        } catch {
            /* unsupported — matchMedia gating is the real guard */
        }
        // addEventListener('change') is the modern API; older Safari only has
        // the deprecated addListener — support both.
        if (mq.addEventListener) mq.addEventListener('change', apply);
        else mq.addListener(apply);
        return () => {
            if (mq.removeEventListener) mq.removeEventListener('change', apply);
            else mq.removeListener(apply);
        };
    }, []);
    return portrait;
}

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
    const portrait = usePortrait();

    // One effect owns the whole xterm + WS lifecycle, keyed on the terminal id
    // AND orientation: portrait tears the xterm down (we mount nothing behind
    // the rotate overlay), landscape (re)builds + fits it. Gating the mount on
    // landscape is what keeps the phone from ever fitting the shared pty to a
    // narrow portrait grid.
    useEffect(() => {
        if (portrait) return; // overlay is shown; don't mount/fit the xterm
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

        // Phones autocorrect / autocapitalize / predict in the hidden xterm
        // textarea, which injects whole words + stray punctuation into the pty.
        // A terminal needs raw keystrokes — turn all of that off.
        const ta = term.textarea;
        if (ta) {
            ta.setAttribute('autocorrect', 'off');
            ta.setAttribute('autocapitalize', 'none');
            ta.setAttribute('autocomplete', 'off');
            ta.setAttribute('spellcheck', 'false');
        }

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
    }, [terminal.id, portrait]);

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

            <div className="m-term-stage">
                {/* The xterm host stays mounted so the effect's ref is stable;
                    in portrait the effect early-returns (nothing painted here)
                    and the overlay covers it. */}
                <div ref={hostRef} className="m-term-host" />
                {portrait && (
                    <div className="m-term-rotate" role="status">
                        <Icon name="rotate-cw" size="lg" />
                        <Text size="sm" style={{ fontWeight: 600 }}>
                            Rotate your phone to landscape
                        </Text>
                        <Text size="xs" className="text-zinc-500" style={{ textAlign: 'center' }}>
                            The terminal needs the full width so it doesn&apos;t
                            shrink the desktop view.
                        </Text>
                    </div>
                )}
            </div>

            {!portrait && (
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
            )}
        </div>
    );
}
