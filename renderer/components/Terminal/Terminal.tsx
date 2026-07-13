import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Terminal as FancyTerminal,
    type TerminalHandle,
    type ShellProfile,
} from '@particle-academy/fancy-term';
import { SerializeAddon } from '@xterm/addon-serialize';
import { api, isRemoteWindow, ulid } from '../../lib/genie';
import { buildClipboardMenu, handleOsc52 } from '../../lib/terminal-clipboard';
import {
    buildImagePathPaste,
    parseImageDataUrl,
    PASTE_TRIGGER_CTRL_V,
    PASTE_TRIGGER_ALT_V,
} from '../../lib/terminal-image-paste';
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
    /** The terminal's workspace id. On a relay REMOTE session it's tagged onto
     *  the term `open` frame so the host scopes the terminal to the grant's
     *  workspaces; ignored for a local pty spawn. */
    workspaceId?: string;
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
    workspaceId,
    onExit,
    className,
    shells,
    activeShell,
    onShellChange,
}: TerminalProps) {
    const handleRef = useRef<TerminalHandle>(null);
    // The host element wrapping fancy-term's <Terminal>. We observe THIS for
    // size changes and re-fit — see the ResizeObserver effect below.
    const hostElRef = useRef<HTMLDivElement>(null);
    const ptyIdRef = useRef<string | null>(null);
    const createFailedRef = useRef(false);
    const serializeRef = useRef<SerializeAddon | null>(null);
    // Latest fitted grid from onResize. fancy-term fits on mount, which
    // fires onResize before our create effect runs in the same commit?
    // No — effects run after; the initial fit's resize may land before
    // OR after create. Track it either way: create uses the latest
    // known size, and any later resize is forwarded to the pty.
    const sizeRef = useRef<{ cols: number; rows: number }>({ cols: 80, rows: 24 });
    // The xterm selection captured at the instant of a right-click mousedown /
    // contextmenu — BEFORE the click can clear it — so the right-click "Copy" still
    // has text to copy even when the live selection was cleared (common over a
    // mouse-reporting TUI). Overwritten on every right-mousedown, so it never goes
    // stale.
    const rightClickSelRef = useRef('');
    // The last NON-EMPTY xterm selection, tracked live via onSelectionChange. This
    // is the robust fallback for the right-click Copy: over a mouse-reporting TUI
    // (Claude Code, tmux…) a right-click is forwarded to the app, whose redraw
    // ASYNCHRONOUSLY clears xterm's selection a beat AFTER the menu opens — so a
    // single mousedown snapshot can still read empty. Recording the selection at
    // the exact moment xterm computes it (no event-phase-ordering dependence, and
    // immune to the later async clear) means Copy always has the real text. Reset
    // when a fresh left-click starts a new interaction, so it never copies stale
    // text after the user has deselected.
    const lastSelectionRef = useRef('');

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

    // Re-fit on ANY container size change. fancy-term already fits its own
    // surface via an internal ResizeObserver, but that fires SYNCHRONOUSLY
    // inside the observer callback and can measure a transiently-stale width
    // when an ANCESTOR reflows the panel — most visibly when the workspace
    // sidebar is pinned/unpinned: pinning it narrows the Floor (the sidebar is
    // in-flow, not an overlay), yet the terminal kept its old wider `cols`, so
    // TUIs (Claude Code, etc.) wrapped at a column past the visible edge.
    // Observing our own host element and re-fitting on the NEXT animation frame
    // (after layout has settled) reports the true visible cols/rows through
    // fancy-term's onResize below, which forwards them to the pty. This covers
    // every layout change generally — sidebar pin, gutter drag, window resize,
    // panel show/hide. (fancy-term 0.3.0's own observer should ideally suffice;
    // this is the robust Genie-side safeguard — tracked for a fancy-term issue.)
    useEffect(() => {
        const el = hostElRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        let raf = 0;
        const ro = new ResizeObserver(() => {
            // Coalesce bursts (e.g. a live gutter drag) into one fit per frame,
            // and measure after the browser has finished laying out.
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => handleRef.current?.fit());
        });
        ro.observe(el);
        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
        };
    }, []);

    // Copy/paste go through Electron's MAIN clipboard via IPC — the renderer's
    // navigator.clipboard (what fancy-term uses) fails SILENTLY in a sandboxed
    // window, so terminal copy never reached the OS clipboard. These are the ONLY
    // copy/paste paths wired below (the package's own clipboard is overridden).
    const copyText = useCallback((text: string) => {
        if (text) void api().clipboard.write(text).catch(() => {});
    }, []);

    // Whether this terminal runs on a REMOTE host (a host window over the bridge).
    // Constant per window; drives the extra Ctrl+V image interception below.
    const remote = isRemoteWindow();

    // Image-first paste. A copied IMAGE can't ride the stdin/keystroke path (that's
    // text-only), so if the LOCAL clipboard holds one we sync it to the clipboard of
    // the machine THIS terminal runs on — locally that's this machine; in a host
    // window `clipboard.writeImage` is re-pointed to the HOST clipboard over the
    // authed bridge — then deliver the paste trigger to the pty so Claude Code reads
    // it exactly like a native local paste (inline [Image] chip). Ordering matters:
    // we AWAIT the (host) clipboard write before the trigger so the image is in place
    // when the CLI reads it. `trigger` is the byte(s) sent AFTER the write lands
    // (default: the Ctrl+V byte); pass '' to sync the image but send NOTHING, so the
    // caller can forward its own gesture bytes (e.g. Alt+V) once the image is in
    // place. Returns true when an image was handled (caller must NOT also paste
    // text/forward the raw key as a paste); false ⇒ no image, fall through.
    const tryPasteImage = useCallback(
        async (trigger: string = PASTE_TRIGGER_CTRL_V): Promise<boolean> => {
            const id = ptyIdRef.current;
            if (!id) return false;
            let image: ReturnType<typeof parseImageDataUrl>;
            try {
                image = parseImageDataUrl(await api().clipboard.readImage());
            } catch {
                return false; // clipboard-image read failed — let the caller fall back
            }
            if (!image) return false; // no image → the caller handles it as text/raw
            try {
                const res = await api().clipboard.writeImage(image.base64);
                if (res.path) {
                    // Linux/headless host: the PNG was written to a temp FILE there
                    // (the OS image clipboard is unreliable for Claude Code on Linux).
                    // Deliver the host FILE PATH to the pty as a bracketed paste so
                    // the CLI attaches the image from the path (drag-drop semantics) —
                    // no clipboard trigger, which would find an empty clipboard.
                    await api().terminal.write(id, buildImagePathPaste(res.path));
                } else if (res.supported && res.ok && trigger) {
                    // Windows/macOS host: the image is on the OS clipboard — send the
                    // trigger so the CLI reads it exactly like a native local paste.
                    await api().terminal.write(id, trigger);
                }
                // supported:false ⇒ the target can't accept an image (a legacy
                // unwired host): no-op gracefully — never send a trigger for an empty
                // clipboard, never break text paste. Still "handled" (returns true) so
                // the caller doesn't fall through and paste stale text.
            } catch {
                /* host write / trigger failed — swallow; the image was still handled */
            }
            return true;
        },
        [],
    );

    // Explicit paste gesture (winmac Ctrl/Cmd+V, the context-menu Paste item, and
    // linux right/middle-click): image first, else the EXISTING text paste unchanged.
    const pasteFromClipboard = useCallback(() => {
        const handle = handleRef.current;
        if (!handle) return;
        void (async () => {
            const handledImage = await tryPasteImage();
            if (!handledImage) {
                try {
                    const text = await api().clipboard.read();
                    if (text) handle.paste(text);
                } catch {
                    /* clipboard unavailable — nothing to paste */
                }
            }
            handle.focus();
        })();
    }, [tryPasteImage]);

    // A raw Ctrl+V on a REMOTE host in contextmenu/linux mode: normally Ctrl+V is a
    // raw ^V byte to the pty (not a paste), but a copied image can't reach the HOST
    // that way — its clipboard is empty. So intercept, sync any image to the host
    // FIRST, else forward the raw byte so the mode's normal behavior is preserved.
    // Only wired for remote windows; a LOCAL Ctrl+V already reads the local clipboard.
    const pasteCtrlVRaw = useCallback(() => {
        const id = ptyIdRef.current;
        if (!id) return;
        void (async () => {
            const handledImage = await tryPasteImage();
            if (!handledImage) {
                await api().terminal.write(id, PASTE_TRIGGER_CTRL_V).catch(() => {});
            }
        })();
    }, [tryPasteImage]);

    // Alt/Meta+V on a REMOTE host — the owner's image-paste gesture. Sync any LOCAL
    // clipboard image to the host FIRST, then let tryPasteImage deliver it: on a
    // Linux host it pastes the temp-file PATH (the durable Claude-Code delivery); on
    // a Windows/macOS host it forwards the Alt+V bytes so the CLI's own Meta+V handler
    // reads the now-populated host clipboard. Either way the CLI sees exactly one
    // delivery, after the image is in place. No image ⇒ tryPasteImage returns false
    // and we forward the raw Alt+V bytes, preserving the gesture's native behaviour.
    // Remote-only: a LOCAL window's Alt+V already reads the local clipboard natively.
    const pasteAltV = useCallback(() => {
        const id = ptyIdRef.current;
        if (!id) return;
        void (async () => {
            const handledImage = await tryPasteImage(PASTE_TRIGGER_ALT_V);
            if (!handledImage) {
                await api().terminal.write(id, PASTE_TRIGGER_ALT_V).catch(() => {});
            }
        })();
    }, [tryPasteImage]);

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
                      // menu reads it. Prefer the live ctx selection when present
                      // (correct for a plain shell, where xterm keeps it), then the
                      // selection snapshotted at right-mousedown/contextmenu, then
                      // the last non-empty selection tracked via onSelectionChange
                      // (the only survivor when a mouse-reporting TUI async-clears
                      // the selection just after the menu opens). So Copy still works.
                      resolveSelection: (ctxSel) =>
                          ctxSel || rightClickSelRef.current || lastSelectionRef.current,
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
            // Remote host + contextmenu/linux mode: Ctrl/Cmd+V is normally a raw ^V
            // to the pty, but a copied image can't reach the HOST that way — its
            // clipboard is empty. Intercept to sync the image to the host first, else
            // forward the raw byte (pasteCtrlVRaw). winmac already handled Ctrl+V
            // above; a LOCAL window keeps its native raw Ctrl+V (the pty is here, so
            // the CLI reads the local clipboard with no help needed).
            if (remote && copyPaste !== 'winmac' && mod && !e.shiftKey && !e.altKey && k === 'v') {
                pasteCtrlVRaw();
                return false;
            }
            // Remote host: Alt/Meta+V is the owner's image-paste gesture (Claude Code
            // reads the HOST clipboard on Meta+V). Intercept in EVERY mode — sync the
            // image to the host, THEN forward the Alt+V bytes so the CLI reads the
            // populated clipboard (pasteAltV). Preventing xterm's own Alt+V here is
            // what enforces the ordering (sync before the CLI reads). No ctrl/meta on
            // this chord, so it never collides with the Ctrl/Cmd handlers above.
            if (remote && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && k === 'v') {
                pasteAltV();
                return false;
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
    }, [copyPaste, copyText, pasteFromClipboard, pasteCtrlVRaw, pasteAltV, remote, xtermReady]);

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
            // Guard against a TUI that POLLS the clipboard via OSC 52 read (Claude
            // Code does): over a REMOTE terminal each read is an async clipboard
            // round-trip answered by a write BACK into the pty, so an unthrottled
            // poll FLOODS the pty stdin with repeated ~34-byte responses and drowns
            // the user's keystrokes — the agent terminal becomes undrivable. Answer
            // only when the clipboard actually CHANGED, and never faster than ~5×/sec.
            let lastOsc52Body = '';
            let lastOsc52At = 0;
            try {
                const oscSub = live.parser.registerOscHandler(52, (oscData: string) =>
                    handleOsc52(oscData, {
                        write: (text) => {
                            void api().clipboard.write(text).catch(() => {});
                        },
                        read: () => api().clipboard.read().catch(() => ''),
                        respond: (oscBody) => {
                            const now = Date.now();
                            // Unchanged since the last answer → a polling TUI; skip
                            // (the value it already has is still current).
                            if (oscBody === lastOsc52Body) return;
                            // Rate backstop so even genuinely-changing content can't
                            // flood the pty faster than the terminal can drain it.
                            if (now - lastOsc52At < 200) return;
                            lastOsc52Body = oscBody;
                            lastOsc52At = now;
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

            // Keep the right-click Copy menu supplied with the real selection even
            // when xterm's live selection is cleared before/just-after the menu
            // reads it (common over a mouse-reporting TUI: the right-click is
            // forwarded to the app, whose redraw async-clears the selection a beat
            // after the menu opens). Three complementary captures, cheap and
            // belt-and-suspenders:
            //  1. onSelectionChange → remember the last NON-EMPTY selection at the
            //     instant xterm computes it (no event-phase dependence; survives the
            //     later async clear). This is the robust fallback.
            //  2. right-mousedown (capture) → snapshot the selection at the click
            //     instant, before anything can clear it.
            //  3. contextmenu (capture) → one last snapshot right before fancy-term
            //     opens the menu (redundant with 2 in the normal case; catches any
            //     path where the mousedown was consumed elsewhere).
            // A left-mousedown starts a fresh interaction, so drop the remembered
            // selection then — Copy must never resurrect stale text after a deselect.
            const selChange = live.onSelectionChange(() => {
                const s = live.getSelection();
                if (s) lastSelectionRef.current = s;
            });
            cleanups.push(() => selChange.dispose());
            const selEl = live.element;
            if (selEl) {
                const onDown = (e: MouseEvent) => {
                    if (e.button === 0) {
                        lastSelectionRef.current = '';
                        rightClickSelRef.current = '';
                    } else if (e.button === 2) {
                        rightClickSelRef.current = live.getSelection();
                    }
                };
                const onCtx = () => {
                    const s = live.getSelection();
                    if (s) rightClickSelRef.current = s;
                };
                selEl.addEventListener('mousedown', onDown, true);
                selEl.addEventListener('contextmenu', onCtx, true);
                cleanups.push(() => {
                    selEl.removeEventListener('mousedown', onDown, true);
                    selEl.removeEventListener('contextmenu', onCtx, true);
                });
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
                workspaceId,
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
        <div ref={hostElRef} className={className ?? 'h-full w-full'}>
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
                // Genie owns OSC 52 itself (registerOscHandler(52,…) in wireLive,
                // routed to the Electron-main clipboard over IPC), so disable
                // fancy-term 0.4.0's own OSC 52 handling — otherwise it registers a
                // second, navigator.clipboard-backed handler (its default is
                // "copy") that no-ops in this sandboxed window and only muddies the
                // handler chain. One handler, one clipboard path.
                osc52={false}
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
