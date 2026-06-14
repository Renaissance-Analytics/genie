import { useEffect, useRef } from 'react';
import {
    Terminal as FancyTerminal,
    type TerminalHandle,
    type ShellProfile,
} from '@particle-academy/fancy-term';
import { SerializeAddon } from '@xterm/addon-serialize';
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

/** How often a live terminal proactively snapshots itself (reliability floor). */
const SNAPSHOT_INTERVAL_MS = 30_000;

/**
 * Single embedded terminal on fancy-term's <Terminal>. The wrapper owns
 * xterm.js + fit; this component owns the pty lifecycle and the IPC
 * wiring (user input → main write, main pty data → handle.write). The
 * controlled `output` prop is deliberately NOT used — pty streams write
 * through the TerminalHandle so high-volume output never round-trips
 * React state.
 *
 * Lifecycle:
 *   mount   → ulid + api.terminal.create({id, cwd, cols, rows})
 *   resize  → onResize → api.terminal.resize(id, cols, rows)
 *   exit    → onExit({exitCode}) + clean up listeners
 *   unmount → final snapshot, then api.terminal.detach(id)
 *
 * Tier 1 persistence:
 *   - After fit, a SerializeAddon is loaded onto the live xterm via a ref.
 *   - A 30s interval + a quit-time `terminal:snapshot-request` + clean unmount
 *     all serialize the buffer and send `terminal:snapshot`.
 *   - On a COLD spawn that returns a `snapshot`, we replay it, draw a dim
 *     "— previous session —" divider, full-reset, THEN wire the live shell.
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
    const serializeRef = useRef<SerializeAddon | null>(null);
    // Latest fitted grid from onResize. fancy-term fits on mount, which
    // fires onResize before our create effect runs in the same commit?
    // No — effects run after; the initial fit's resize may land before
    // OR after create. Track it either way: create uses the latest
    // known size, and any later resize is forwarded to the pty.
    const sizeRef = useRef<{ cols: number; rows: number }>({ cols: 80, rows: 24 });

    useEffect(() => {
        const handle = handleRef.current;
        if (!handle) return;

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

        handle.fit();

        // Load the SerializeAddon onto the live xterm instance, exposed by
        // fancy-term 0.3.0's `handle.xterm` escape hatch (non-null after the
        // fit above mounts it). Best-effort — a missing instance just disables
        // snapshots for this terminal, it never breaks the session.
        const live = handle.xterm;
        if (live) {
            try {
                const addon = new SerializeAddon();
                live.loadAddon(addon);
                serializeRef.current = addon;
            } catch {
                serializeRef.current = null;
            }
        }

        const serializeNow = (): string | null => {
            const addon = serializeRef.current;
            if (!addon) return null;
            try {
                return addon.serialize();
            } catch {
                return null;
            }
        };
        const sendSnapshot = (): void => {
            const data = serializeNow();
            if (!data) return;
            void api().terminal.snapshot(id, data).catch(() => {});
        };

        void api()
            .terminal.create({
                id,
                cwd,
                shell,
                args,
                env,
                cols: sizeRef.current.cols,
                rows: sizeRef.current.rows,
            })
            .then((res) => {
                if (res.existing) {
                    // Warm reattach: another window already has this pty live.
                    // Replay the scrollback so this window catches up. Do NOT
                    // replay the on-disk snapshot — the live buffer supersedes
                    // it and double-drawing would duplicate history.
                    if (res.scrollback) handle.write(res.scrollback);
                } else if (res.snapshot?.serialized) {
                    // Cold spawn with a previous-session snapshot. Frame it:
                    // restored history → dim divider → full reset (\x1bc) so
                    // the fresh shell starts on a clean screen below the
                    // history. The reset clears any alt-screen/TUI state the
                    // snapshot captured (e.g. quitting inside vim), which is
                    // why we serialize rather than raw-replay.
                    handle.write(res.snapshot.serialized);
                    handle.write('\r\n\x1b[2m— previous session —\x1b[0m\r\n');
                    handle.write('\x1bc');
                }
                // The fit may have landed between create and now — sync the
                // pty to whatever the grid actually is.
                void api()
                    .terminal.resize(id, sizeRef.current.cols, sizeRef.current.rows)
                    .catch(() => {});
            })
            .catch((err: unknown) => {
                createFailedRef.current = true;
                const msg = err instanceof Error ? err.message : String(err);
                handle.writeln(
                    `\r\n\x1b[31mFailed to start terminal: ${msg}\x1b[0m`,
                );
            });

        // Reliability floor: snapshot every 30s while the terminal is live, so
        // a crash (not a clean quit) still leaves recent history on disk.
        const interval = setInterval(sendSnapshot, SNAPSHOT_INTERVAL_MS);

        // Quit handshake: main broadcasts snapshot-request on before-quit; send
        // our final buffer immediately so it lands inside the bounded wait.
        const offSnapReq = api().on.terminalSnapshotRequest(() => {
            if (!alive || createFailedRef.current) return;
            sendSnapshot();
        });

        return () => {
            alive = false;
            clearInterval(interval);
            offSnapReq();
            offData();
            offExit();
            // Snapshot on clean unmount/detach so reopening picks up the very
            // latest buffer even without a quit.
            if (!createFailedRef.current) sendSnapshot();
            serializeRef.current = null;
            // Detach (soft release) — the pty keeps running while any other
            // window is still attached. Last detach kills the pty in main.
            if (!createFailedRef.current && ptyIdRef.current) {
                void api().terminal.detach(ptyIdRef.current);
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className={className ?? 'h-full w-full'}>
            <FancyTerminal
                ref={handleRef}
                className="h-full w-full"
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
                    sizeRef.current = { cols, rows };
                    const id = ptyIdRef.current;
                    if (!id || createFailedRef.current) return;
                    void api().terminal.resize(id, cols, rows).catch(() => {});
                }}
            />
        </div>
    );
}
