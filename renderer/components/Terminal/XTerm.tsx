import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { api, ulid } from '../../lib/genie';
import '@xterm/xterm/css/xterm.css';

interface XTermProps {
    /** Optional stable id. Otherwise a fresh ulid is minted on mount. */
    id?: string;
    /** Working directory for the spawned shell. */
    cwd: string;
    /** Optional shell override. Falls through to the OS default in main. */
    shell?: string;
    /** Optional args appended to the shell. */
    args?: string[];
    /** Extra env vars merged on top of process.env in main. */
    env?: Record<string, string>;
    /** Fires when the underlying pty exits, with the captured exit code. */
    onExit?: (info: { exitCode: number; signal?: number }) => void;
    /** Optional className applied to the host element (height/width should be set here). */
    className?: string;
}

/**
 * Single embedded terminal. Owns the xterm.js instance + the fit addon
 * and wires user input → main (write) and main pty data → xterm. Resize
 * is observed via ResizeObserver: any change to the host element re-fits
 * the terminal and tells the main-side pty to match. Lifecycle:
 *
 *   mount   → ulid + api.terminal.create({id, cwd, cols, rows})
 *   resize  → fit + api.terminal.resize(id, cols, rows)
 *   exit    → onExit({exitCode}) + clean up listeners
 *   unmount → api.terminal.kill(id) (main also kills on webContents destroy)
 *
 * The component is intentionally dumb: tabs, splits, and "open a TUI
 * here" UX all live one layer up. This piece just renders one pty.
 */
export default function XTerm({
    id: providedId,
    cwd,
    shell,
    args,
    env,
    onExit,
    className,
}: XTermProps) {
    const hostRef = useRef<HTMLDivElement>(null);
    const ptyIdRef = useRef<string | null>(null);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;

        const term = new Terminal({
            convertEol: true,
            cursorBlink: true,
            fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, "Cascadia Code", Consolas, monospace',
            fontSize: 13,
            theme: { background: '#09090b', foreground: '#fafafa' },
            allowProposedApi: true,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.loadAddon(new WebLinksAddon());
        term.open(host);
        fit.fit();

        const id = providedId ?? ulid();
        ptyIdRef.current = id;
        const { cols, rows } = term;
        let alive = true;

        const offData = api().on.terminalData(({ id: hitId, data }) => {
            if (hitId !== id || !alive) return;
            term.write(data);
        });
        const offExit = api().on.terminalExit((payload) => {
            if (payload.id !== id || !alive) return;
            term.writeln(
                `\r\n\x1b[2m[process exited with code ${payload.exitCode}]\x1b[0m`,
            );
            onExit?.({ exitCode: payload.exitCode, signal: payload.signal });
        });

        const inputDisposable = term.onData((data) => {
            // Swallow IPC errors here — if the main-side handler is briefly
            // unavailable (during bootstrap, after a hot-reload) the input
            // is just lost for that key. A thrown promise rejection bubbles
            // up as a Next.js runtime error and blanks the page; better to
            // drop a keystroke than crash the panel.
            void api().terminal.write(id, data).catch(() => {});
        });

        let createFailed = false;
        void api()
            .terminal.create({ id, cwd, shell, args, env, cols, rows })
            .then((res) => {
                // If we're attaching to an already-running pty (because
                // another window had it open), replay the scrollback so this
                // window doesn't start staring at a blank screen.
                if (res.scrollback) term.write(res.scrollback);
            })
            .catch((err: unknown) => {
                createFailed = true;
                const msg = err instanceof Error ? err.message : String(err);
                term.writeln(`\r\n\x1b[31mFailed to start terminal: ${msg}\x1b[0m`);
            });

        const resize = (): void => {
            try {
                fit.fit();
            } catch {
                /* host detached */
                return;
            }
            if (createFailed) return;
            void api().terminal.resize(id, term.cols, term.rows).catch(() => {});
        };

        const observer = new ResizeObserver(resize);
        observer.observe(host);

        return () => {
            alive = false;
            observer.disconnect();
            offData();
            offExit();
            inputDisposable.dispose();
            // Detach (soft release) — the pty keeps running while any other
            // window is still attached. Last detach kills the pty in main.
            if (!createFailed && ptyIdRef.current) {
                void api().terminal.detach(ptyIdRef.current);
            }
            term.dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div
            ref={hostRef}
            className={className ?? 'h-full w-full'}
            style={{ background: '#09090b' }}
        />
    );
}
