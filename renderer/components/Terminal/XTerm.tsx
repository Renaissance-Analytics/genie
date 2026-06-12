import { useEffect, useRef } from 'react';
import {
    Terminal as FancyTerminal,
    type TerminalHandle,
    type ShellProfile,
} from '@particle-academy/fancy-term';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { api, ulid } from '../../lib/genie';
import '@xterm/xterm/css/xterm.css';

interface XTermProps {
    /** Optional stable id. Otherwise a fresh ulid is minted on mount. */
    id?: string;
    /** Working directory for the spawned shell. */
    cwd: string;
    /** Optional shell override. Falls through to the configured default in main. */
    shell?: string;
    /** Optional args appended to the shell. */
    args?: string[];
    /** Extra env vars merged on top of process.env in main. */
    env?: Record<string, string>;
    /** Fires when the underlying pty exits, with the captured exit code. */
    onExit?: (info: { exitCode: number; signal?: number }) => void;
    /** Optional className applied to the host element (height/width should be set here). */
    className?: string;
    /** Shell profiles offered by the host (renders fancy-term's ShellSwitcher when set). */
    shells?: ShellProfile[];
    /** Controlled active-shell id for the switcher. */
    activeShell?: string;
    /** The user picked a different shell — host respawns the pty. */
    onShellChange?: (id: string, profile: ShellProfile) => void;
}

/**
 * Single embedded terminal on fancy-term's <Terminal>. The wrapper owns
 * xterm.js + fit; this component owns the pty lifecycle and the IPC
 * wiring (user input → main write, main pty data → ref.write). The
 * controlled `output` prop is deliberately NOT used — pty streams write
 * through the TerminalHandle so high-volume output never round-trips
 * React state. Lifecycle:
 *
 *   mount   → ulid + api.terminal.create({id, cwd, cols, rows})
 *   resize  → onResize → api.terminal.resize(id, cols, rows)
 *   exit    → onExit({exitCode}) + clean up listeners
 *   unmount → api.terminal.detach(id) (last detach kills the pty in main)
 *
 * Shell switching is host-driven per fancy-term's contract: the switcher
 * UI fires onShellChange and the parent respawns this component (key
 * change) with the new shell — the wrapper never spawns anything.
 */
export default function XTerm({
    id: providedId,
    cwd,
    shell,
    args,
    env,
    onExit,
    className,
    shells,
    activeShell,
    onShellChange,
}: XTermProps) {
    const handleRef = useRef<TerminalHandle>(null);
    const ptyIdRef = useRef<string | null>(null);
    const createFailedRef = useRef(false);

    useEffect(() => {
        const handle = handleRef.current;
        const xterm = handle?.xterm;
        if (!handle || !xterm) return;

        // Escape hatches fancy-term doesn't surface as props: pty data on
        // Windows ConPTY arrives \n-only from some tools, and links in dev
        // output should be clickable.
        xterm.options.convertEol = true;
        xterm.loadAddon(new WebLinksAddon());
        handle.fit();

        const id = providedId ?? ulid();
        ptyIdRef.current = id;
        let alive = true;

        const offData = api().on.terminalData(({ id: hitId, data }) => {
            if (hitId !== id || !alive) return;
            handle.write(data);
        });
        const offExit = api().on.terminalExit((payload) => {
            if (payload.id !== id || !alive) return;
            handle.writeln(
                `\r\n\x1b[2m[process exited with code ${payload.exitCode}]\x1b[0m`,
            );
            onExit?.({ exitCode: payload.exitCode, signal: payload.signal });
        });

        void api()
            .terminal.create({
                id,
                cwd,
                shell,
                args,
                env,
                cols: xterm.cols,
                rows: xterm.rows,
            })
            .then((res) => {
                // Attaching to an already-running pty (another window has it
                // open) — replay the scrollback so this window catches up.
                if (res.scrollback) handle.write(res.scrollback);
            })
            .catch((err: unknown) => {
                createFailedRef.current = true;
                const msg = err instanceof Error ? err.message : String(err);
                handle.writeln(
                    `\r\n\x1b[31mFailed to start terminal: ${msg}\x1b[0m`,
                );
            });

        return () => {
            alive = false;
            offData();
            offExit();
            // Detach (soft release) — the pty keeps running while any other
            // window is still attached. Last detach kills the pty in main.
            if (!createFailedRef.current && ptyIdRef.current) {
                void api().terminal.detach(ptyIdRef.current);
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <FancyTerminal
            ref={handleRef}
            className={className ?? 'h-full w-full'}
            style={{ background: '#09090b' }}
            theme={{ background: '#09090b', foreground: '#fafafa' }}
            fontFamily='ui-monospace, SFMono-Regular, Menlo, "Cascadia Code", Consolas, monospace'
            fontSize={13}
            cursorBlink
            shells={shells}
            activeShell={activeShell}
            onShellChange={onShellChange}
            showShellBar={Boolean(shells && shells.length > 1)}
            onData={(data) => {
                // Swallow IPC errors — if the main-side handler is briefly
                // unavailable (bootstrap, hot-reload) the keystroke is lost;
                // better than a thrown rejection blanking the page.
                const id = ptyIdRef.current;
                if (!id) return;
                void api().terminal.write(id, data).catch(() => {});
            }}
            onResize={({ cols, rows }) => {
                const id = ptyIdRef.current;
                if (!id || createFailedRef.current) return;
                void api().terminal.resize(id, cols, rows).catch(() => {});
            }}
        />
    );
}
