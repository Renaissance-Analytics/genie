import { useState } from 'react';
import { api } from '../../lib/genie';

/**
 * Soft, NON-blocking banner for a HOST window whose host runs an older RELEASE
 * build than this client but is still WIRE-COMPATIBLE (same bridge protocol —
 * see main/remote/link-state.ts). Unlike {@link HostUpgradeOverlay} (which covers
 * the whole window on a hard protocol mismatch), this never blocks the dashboard:
 * it's a dismissible toast that offers a one-click host update. Dismissal is keyed
 * to the host version, so a later host build re-surfaces the nudge.
 */
export default function HostBuildNudge({
    build,
    hostname,
}: {
    build: { hostVersion: string | null; localVersion: string };
    hostname?: string;
}) {
    const [dismissed, setDismissed] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    // Dismissal is keyed to the host build; a `null` (unknown) version keys to
    // the sentinel '∅' so it stays dismissed until the host reports a version.
    const key = build.hostVersion ?? '∅';
    if (dismissed === key) return null;
    const host = hostname ?? 'This host';

    const upgrade = async () => {
        setBusy(true);
        setErr(null);
        const res = await api()
            .remote.upgradeHost()
            .catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        if (!res.ok) {
            setErr(res.error ?? 'Update failed.');
            setBusy(false);
        }
        // On success the host restarts → the link goes 'reconnecting' and the hard
        // overlay takes over; this banner unmounts as hostBuildBehind clears.
    };

    return (
        <div
            role="status"
            aria-live="polite"
            style={{
                position: 'fixed',
                bottom: 16,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 9000,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                maxWidth: 'calc(100vw - 32px)',
                padding: '10px 14px',
                borderRadius: 10,
                background: 'rgba(24, 24, 27, 0.97)',
                border: '1px solid #3f3f46',
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                color: '#e4e4e7',
                fontSize: 13,
                WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
        >
            <span aria-hidden style={{ fontSize: 15 }}>⬆️</span>
            <span style={{ lineHeight: 1.4 }}>
                {build.hostVersion ? (
                    <>
                        {host} is on an older build (<b>v{build.hostVersion}</b>) — you're on{' '}
                        <b>v{build.localVersion}</b>.
                    </>
                ) : (
                    <>
                        {host} is on an older build — you're on <b>v{build.localVersion}</b>.
                    </>
                )}
                {err && <span style={{ color: '#f87171', marginLeft: 8 }}>{err}</span>}
            </span>
            <button
                type="button"
                className="nudge-btn nudge-btn-primary"
                disabled={busy}
                onClick={() => void upgrade()}
            >
                {busy ? 'Updating…' : 'Update host'}
            </button>
            <button
                type="button"
                className="nudge-btn"
                onClick={() => setDismissed(build.hostVersion)}
            >
                Dismiss
            </button>
            <style>{`
                .nudge-btn {
                    font: inherit; font-size: 12px; font-weight: 600;
                    padding: 6px 12px; border-radius: 7px; cursor: pointer;
                    color: #e4e4e7; background: #27272a; border: 1px solid #3f3f46;
                    white-space: nowrap;
                }
                .nudge-btn:hover { background: #3f3f46; }
                .nudge-btn:disabled { opacity: 0.6; cursor: default; }
                .nudge-btn-primary { background: #7c3aed; border-color: #7c3aed; color: #fff; }
                .nudge-btn-primary:hover { background: #6d28d9; }
            `}</style>
        </div>
    );
}
