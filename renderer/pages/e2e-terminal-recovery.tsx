import { useCallback, useEffect, useState } from 'react';
import RecoveryBanner from '../components/Master/RecoveryBanner';
import { panelRecoverKey, type RecoveryState } from '../lib/host-loss-recovery';
import { api } from '../lib/genie';

/**
 * E2E harness for host-loss recovery (genie#203, Fix C). NOT product UI: it mounts
 * the REAL RecoveryBanner + the REAL panelRecoverKey remount keying, subscribed to
 * the REAL preload IPC (`api().on.terminalRecoveryStatus` / `terminalRecover`), so a
 * Playwright Electron test drives the FULL main → preload → renderer chain the
 * master window uses — WITHOUT the full master window. Main emits through
 * `__GENIE_E2E_RECOVERY__` (background.ts), which calls the SAME broadcastToWindows
 * + channel constants the watchdog uses; a channel-string drift between emit and
 * listen therefore fails this spec, which typecheck can't see.
 */

const TERMINAL_ID = 't1';

/** A stand-in for a terminal pane, keyed exactly like the real one. Each MOUNT
 *  bumps the parent counter, so a recovery-driven key change is observable as a
 *  remount (what the real panel does to rejoin the respawned host). */
function KeyedPane({ onMount }: { onMount: () => void }) {
    useEffect(() => {
        onMount();
    }, [onMount]);
    return <div data-testid="pane">pane</div>;
}

export default function E2ETerminalRecovery() {
    const [recovery, setRecovery] = useState<RecoveryState | null>(null);
    const [recoverGen, setRecoverGen] = useState(0);
    const [mountCount, setMountCount] = useState(0);

    useEffect(() => {
        return api().on.terminalRecoveryStatus?.(({ state }) => setRecovery(state));
    }, []);
    useEffect(() => {
        return api().on.terminalRecover?.(({ ids }) => {
            if (ids.includes(TERMINAL_ID)) setRecoverGen((g) => g + 1);
        });
    }, []);

    // Stable so KeyedPane's mount effect fires ONCE per mount, not on every parent
    // re-render (e.g. a banner state change must NOT be counted as a remount).
    const bump = useCallback(() => setMountCount((c) => c + 1), []);

    return (
        <div
            data-testid="e2e-root"
            style={{ height: '100vh', background: '#0a0a0c', color: '#e6e6e6' }}
        >
            <div data-testid="mount-count">{mountCount}</div>
            <div key={panelRecoverKey(TERMINAL_ID, recoverGen)}>
                <KeyedPane onMount={bump} />
            </div>
            <RecoveryBanner state={recovery} onDismiss={() => setRecovery(null)} />
        </div>
    );
}
