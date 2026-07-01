import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Terminal as FancyTerminal,
    type TerminalHandle,
    type ShellProfile,
} from '@particle-academy/fancy-term';
import { SerializeAddon } from '@xterm/addon-serialize';
import { api, ulid } from '../../lib/genie';
import { buildClipboardMenu, handleOsc52 } from '../../lib/terminal-clipboard';
import { findUrls } from '../../lib/terminal-links';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
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
export default function Terminal({
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
}: TerminalProps) {
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
    // The xterm selection captured at the instant of a right-click mousedown —
    // BEFORE the click can clear it — so the right-click "Copy" still has text to
    // copy even when the live selection was cleared (common over a mouse-reporting
    // TUI). Overwritten on every right-mousedown, so it never goes stale.
    const rightClickSelRef = useRef('');

    // Copy/paste behaviour (Settings → Customization). REACTIVE: read on mount AND
    // re-read on settings:changed, so changing the mode applies to LIVE terminals
    // with no restart. 'contextmenu' shows a right-click Copy/Paste menu;
    // 'linux' = highlight-to-copy + right/middle-click paste; 'winmac' =
    // Ctrl/Cmd+C copies the selection, Ctrl/Cmd+V pastes. All modes also honour
    // Ctrl+Shift+C. (See the mode effect below.)
    const [copyPaste, setCopyPaste] = useState<'contextmenu' | 'linux' | 'winmac'>(
        'contextmenu',
    );
    // Flips true once fancy-term has actually mounted the live xterm
    // (handle.xterm). fancy-term opens xterm only after it can measure the
    // container, so a late-laid-out / background panel can still have a null
    // handle.xterm when our effects first run. Everything that needs the live
    // instance (OSC 52 clipboard, copy keybindings, right-click snapshot, links)
    // keys off this so it wires the moment xterm is ready — not just once at
    // mount, which is why copy silently failed in "some terminals but not others".
    const [xtermReady, setXtermReady] = useState(false);
    useEffect(() => {
        const read = () => {
            void api()
                .settings.get()
                .then((s) => {
                    const m = s.terminal_copy_paste;
                    if (m === 'linux' || m === 'winmac' || m === 'contextmenu') setCopyPaste(m);
                })
                .catch(() => {});
        };
        read();
        return api().on.settingsChanged((keys) => {
            if (keys.includes('terminal_copy_paste')) read();
        });
    }, []);

    // Copy/paste go through Electron's MAIN clipboard via IPC — the renderer's
    // navigator.clipboard (what fancy-term uses) fails SILENTLY in a sandboxed
    // window, so terminal copy never reached the OS clipboard. These are the ONLY
    // copy/paste paths wired below (the package's own clipboard is overridden).
    const copyText = useCallback((text: string) => {
        if (text) void api().clipboard.write(text).catch(() => {});
    }, []);
    const pasteFromClipboard = useCallback(() => {
        const handle = handleRef.current;
        if (!handle) return;
        void api()
            .clipboard.read()
            .then((t) => {
                if (t) handle.paste(t);
            })
            .catch(() => {})
            .finally(() => handle.focus());
    }, []);

    // The right-click menu for 'contextmenu' mode — Copy/Paste routed through the
    // IPC clipboard (not fancy-term's navigator default). Disabled in the other
    // modes (linux right-clicks to paste; winmac is keyboard-driven).
    const contextMenuConfig = useMemo(
        () =>
            copyPaste === 'contextmenu'
                ? buildClipboardMenu({
                      copy: copyText,
                      paste: pasteFromClipboard,
                      // A right-click can clear xterm's live selection before the
                      // menu reads it — fall back to the selection snapshotted at
                      // right-mousedown (rightClickSelRef) so Copy still works.
                      resolveSelection: (ctxSel) => rightClickSelRef.current || ctxSel,
                  })
                : false,
        [copyPaste, copyText, pasteFromClipboard],
    );

    // Apply the chosen copy/paste behaviour to the live xterm — all copy/paste
    // flows through the IPC clipboard (copyText / pasteFromClipboard), never the
    // package's navigator.clipboard. Re-runs when the mode changes (reactive).
    useEffect(() => {
        const handle = handleRef.current;
        const live = handle?.xterm;
        if (!handle || !live) return;
        const disposers: Array<() => void> = [];

        // Keyboard copy chord(s). Ctrl+Shift+C copies the selection in EVERY mode;
        // 'winmac' ALSO maps plain Ctrl/Cmd+C (when something is selected — else it
        // falls through to the shell's ^C interrupt) and Ctrl/Cmd+V to paste. This
        // REPLACES the package's own handler (which copied via navigator.clipboard).
        live.attachCustomKeyEventHandler((e) => {
            if (e.type !== 'keydown') return true;
            const mod = e.ctrlKey || e.metaKey;
            const k = e.key.toLowerCase();
            if (mod && e.shiftKey && !e.altKey && k === 'c' && live.hasSelection()) {
                copyText(live.getSelection());
                return false;
            }
            if (copyPaste === 'winmac' && mod && !e.shiftKey && !e.altKey) {
                if (k === 'c' && live.hasSelection()) {
                    copyText(live.getSelection());
                    return false;
                }
                if (k === 'v') {
                    pasteFromClipboard();
                    return false;
                }
            }
            return true;
        });
        disposers.push(() => live.attachCustomKeyEventHandler(() => true));

        if (copyPaste === 'linux') {
            // Highlight-to-copy.
            const sel = live.onSelectionChange(() => {
                if (live.hasSelection()) copyText(live.getSelection());
            });
            disposers.push(() => sel.dispose());
            // Right-click (and classic middle-click) paste; suppress the menu.
            const el = live.element;
            if (el) {
                const onCtx = (e: MouseEvent) => {
                    e.preventDefault();
                    pasteFromClipboard();
                };
                const onMouse = (e: MouseEvent) => {
                    if (e.button === 1) {
                        e.preventDefault();
                        pasteFromClipboard();
                    }
                };
                el.addEventListener('contextmenu', onCtx);
                el.addEventListener('mousedown', onMouse);
                disposers.push(() => {
                    el.removeEventListener('contextmenu', onCtx);
                    el.removeEventListener('mousedown', onMouse);
                });
            }
        }

        return () => {
            for (const d of disposers) d();
        };
        // xtermReady: re-run once fancy-term has mounted the live xterm, so the
        // keybindings, highlight-to-copy, and (linux) right-click-paste actually
        // attach even when handle.xterm was null on the first run.
    }, [copyPaste, copyText, pasteFromClipboard, xtermReady]);

    useEffect(() => {
        const handle = handleRef.current;
        if (!handle) return;

        const id = providedId ?? ulid();
        ptyIdRef.current = id;
        let alive = true;
        const cleanups: Array<() => void> = [];

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
        // fancy-term mounts the live xterm (handle.xterm) only after it can
        // measure the container, so a late-laid-out / background panel may still
        // have a null handle.xterm right now. Define the xterm-dependent wiring
        // and RETRY until it's mounted — otherwise a terminal that lays out a
        // frame late permanently loses its OSC 52 clipboard handler (Claude Code
        // / tmux "copied" never reaches the system clipboard), its right-click
        // copy snapshot, and (once xtermReady fires) its copy/paste keybindings.
        const wireLive = (live: NonNullable<typeof handle.xterm>) => {
            try {
                const addon = new SerializeAddon();
                live.loadAddon(addon);
                serializeRef.current = addon;
            } catch {
                serializeRef.current = null;
            }

            // Honour OSC 52 — the escape sequence TUIs (Claude Code, tmux, vim…)
            // copy their selection with (`ESC]52;c;<base64>BEL`). xterm DROPS it
            // by default, so the app shows "copied" but nothing reaches the OS
            // clipboard. Route it to the system clipboard via main (the renderer's
            // navigator.clipboard is unreliable here); a read request replies on
            // the pty input. Registered before the pty streams so no copy is missed.
            try {
                const oscSub = live.parser.registerOscHandler(52, (oscData: string) =>
                    handleOsc52(oscData, {
                        write: (text) => {
                            void api().clipboard.write(text).catch(() => {});
                        },
                        read: () => api().clipboard.read().catch(() => ''),
                        respond: (oscBody) => {
                            void api()
                                .terminal.write(id, `\x1b]${oscBody}\x07`)
                                .catch(() => {});
                        },
                    }),
                );
                cleanups.push(() => {
                    try {
                        oscSub.dispose();
                    } catch {
                        /* already disposed */
                    }
                });
            } catch {
                /* registerOscHandler unavailable — OSC 52 copy just isn't honoured */
            }

            // Snapshot the selection at right-mousedown — BEFORE the click can
            // clear it — so the right-click Copy menu still has text to copy even
            // when the live selection was cleared (common over a mouse-reporting
            // TUI). Capture phase so we read it before xterm processes the click.
            const selEl = live.element;
            if (selEl) {
                const onRightDown = (e: MouseEvent) => {
                    if (e.button === 2) rightClickSelRef.current = live.getSelection();
                };
                selEl.addEventListener('mousedown', onRightDown, true);
                cleanups.push(() =>
                    selEl.removeEventListener('mousedown', onRightDown, true),
                );
            }

            // Clickable URLs. We register our OWN xterm link provider rather
            // than @xterm/addon-web-links: that addon hard-validates every
            // candidate with `new URL(uri)` before firing, which throws for
            // scheme-less URLs — so bare `github.com/x` / `www.x.com` can never
            // be linkified through it. Our provider (findUrls) matches http(s)
            // AND scheme-less hosts, prefixing https:// on click. The handler
            // routes through the preload bridge → main shell.openExternal so
            // links open in the user's default browser (NOT in-app); main
            // re-validates the scheme as the final gate. Best-effort — a
            // failure here just leaves links non-clickable, never breaks the
            // session. This is the SAME live xterm every terminal uses (new,
            // restored, and agent/Claude-Code panels all mount this one
            // component), so the provider covers every terminal path.
            try {
                live.registerLinkProvider({
                    provideLinks(lineNo, callback) {
                        const buf = live.buffer.active;
                        // lineNo is 1-based; the buffer API is 0-based.
                        const row = buf.getLine(lineNo - 1);
                        if (!row) {
                            callback(undefined);
                            return;
                        }
                        const text = row.translateToString(true);
                        const found = findUrls(text);
                        if (found.length === 0) {
                            callback(undefined);
                            return;
                        }
                        callback(
                            found.map((u) => ({
                                text: u.text,
                                // xterm ranges are 1-based and inclusive of the
                                // end cell. findUrls gives 0-based half-open
                                // [start, end), so start+1 and end map directly.
                                range: {
                                    start: { x: u.start + 1, y: lineNo },
                                    end: { x: u.end, y: lineNo },
                                },
                                activate: () => {
                                    void api()
                                        .shell.openExternal(u.href)
                                        .catch(() => {});
                                },
                            })),
                        );
                    },
                });
            } catch {
                // non-fatal — terminal works, links just aren't clickable
            }
            // xterm is live — let the copy/paste-mode effect (keybindings,
            // highlight-to-copy, linux right-click-paste) wire now too.
            setXtermReady(true);
        };

        const readyNow = handle.xterm;
        if (readyNow) {
            wireLive(readyNow);
        } else {
            // Poll briefly for the mount (fancy-term opens xterm after it can
            // measure the container). ~2s ceiling, then give up — the terminal
            // still works, only OSC 52 / links / right-click copy would be missing.
            let tries = 0;
            const iv = setInterval(() => {
                const live = handle.xterm;
                if (live) {
                    clearInterval(iv);
                    if (alive) wireLive(live);
                } else if (++tries > 120) {
                    clearInterval(iv);
                }
            }, 16);
            cleanups.push(() => clearInterval(iv));
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
            for (const d of cleanups) d();
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
                // 'contextmenu' mode shows a right-click Copy/Paste menu whose
                // actions go through the IPC clipboard (not navigator.clipboard);
                // 'linux'/'winmac' disable the menu and use the handlers above.
                contextMenu={contextMenuConfig}
                // The terminal should keep focus after a native paste so you can
                // type immediately. (The IPC paste paths refocus themselves.)
                onPaste={() => {
                    handleRef.current?.focus();
                }}
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
