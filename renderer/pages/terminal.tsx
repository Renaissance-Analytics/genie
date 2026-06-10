import { useEffect, useState } from 'react';
import XTerm from '../components/Terminal/XTerm';
import { hasGenieBridge } from '../lib/genie';

/**
 * Standalone smoke page for the terminal subsystem. Opens one pty rooted
 * at the user's home dir. Hit it via `/terminal` while Genie is running
 * in dev to verify node-pty + xterm.js + IPC are all healthy before
 * weaving the component into the workspace UI.
 *
 * Not linked from the tray menu — this is the developer's diagnostic
 * surface, not user-facing yet.
 */
export default function TerminalPage() {
    const [ready, setReady] = useState(false);

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

    if (!ready) {
        return (
            <div className="surface flex h-screen items-center justify-center text-xs text-zinc-500">
                Waiting for preload bridge…
            </div>
        );
    }

    const home =
        typeof process !== 'undefined' && process.env?.HOME
            ? process.env.HOME
            : typeof process !== 'undefined' && process.env?.USERPROFILE
              ? process.env.USERPROFILE
              : '.';

    return (
        <div className="surface flex h-screen flex-col">
            <div
                className="flex items-center gap-2 border-b px-3 py-1.5 text-xs"
                style={{ borderColor: 'var(--border-1)', color: 'var(--fg-3)' }}
            >
                <span className="font-semibold">terminal</span>
                <span>· cwd: {home}</span>
            </div>
            <div className="min-h-0 flex-1">
                <XTerm cwd={home} />
            </div>
        </div>
    );
}
