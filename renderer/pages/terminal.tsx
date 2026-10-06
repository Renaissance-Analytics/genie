import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import Terminal from '../components/Terminal/Terminal';
import { hasGenieBridge } from '../lib/genie';
import { parseTerminalWindowRoute } from '../lib/terminal-window-route';

/**
 * The standalone terminal window — Tynn #447.
 *
 * Owner direction: every workspace can open a terminal, or start an agent in TUI mode, and
 * it opens as its own window so TheFloor stays clean under the Genie 2 UX.
 *
 * Two shapes, decided in `lib/terminal-window-route.ts` (tested; this file has no DOM
 * harness so a decision made here is a decision nobody checks):
 *
 * - **`?spec=<id>`** — ATTACH to that `terminal_specs` row by passing its id as the
 *   Terminal's stable `id`, so main binds to the EXISTING pty instead of spawning one.
 *   That is what lets this window host a real agent: the spec carries the identity
 *   (`GENIE_TERMINAL_ID`, the per-terminal MCP token, AgentInbox, roster, revival).
 * - **no query** — the tray's scratch terminal, a bare pty at home. Unchanged.
 *
 * This page used to be only the second of those, and said so: *"the developer's diagnostic
 * surface, not user-facing yet."* It is user-facing now.
 */
export default function TerminalPage() {
    const [ready, setReady] = useState(false);
    const router = useRouter();

    useEffect(() => {
        if (hasGenieBridge()) {
            setReady(true);
            return;
        }
        const t = setInterval(() => {
            if (hasGenieBridge()) {
                setReady(true);
                clearInterval(t);
            }
        }, 100);
        return () => clearInterval(t);
    }, []);

    const home =
        typeof process !== 'undefined' && process.env?.HOME
            ? process.env.HOME
            : typeof process !== 'undefined' && process.env?.USERPROFILE
              ? process.env.USERPROFILE
              : '.';

    // `router.isReady` matters: before it, query is empty and we would briefly decide
    // "scratch" and spawn a pty the window never wanted.
    const view = useMemo(
        () => (router.isReady ? parseTerminalWindowRoute(router.query) : null),
        [router.isReady, router.query],
    );

    if (!ready || !view) {
        return (
            <div className="surface flex h-screen items-center justify-center text-xs text-zinc-500">
                {ready ? 'Opening…' : 'Waiting for preload bridge…'}
            </div>
        );
    }

    const cwd = view.kind === 'spec' ? (view.cwd ?? home) : home;
    const label = view.kind === 'spec' ? 'attached' : 'scratch';

    return (
        <div className="surface flex h-screen flex-col">
            <div
                className="flex items-center gap-2 border-b px-3 py-1.5 text-xs"
                style={{ borderColor: 'var(--border-1)', color: 'var(--fg-3)' }}
            >
                <span className="font-semibold">terminal</span>
                <span>· {label}</span>
                <span>· cwd: {cwd}</span>
            </div>
            <div className="min-h-0 flex-1">
                <Terminal
                    // THE attach. A spec id here makes main bind to the existing pty; a
                    // fresh ulid would spawn a second one and leave the agent in the
                    // terminal nobody is looking at.
                    {...(view.kind === 'spec' ? { id: view.specId } : {})}
                    {...(view.kind === 'spec' && view.workspaceId ? { workspaceId: view.workspaceId } : {})}
                    cwd={cwd}
                />
            </div>
        </div>
    );
}
