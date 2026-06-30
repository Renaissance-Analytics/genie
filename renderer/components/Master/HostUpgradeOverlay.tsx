import { useState } from 'react';
import { api, type RemoteLinkState } from '../../lib/genie';

/**
 * Full-window overlay for a HOST window whose bridge link is unhealthy:
 *   - mismatch (host behind)   → "Upgrade host" (drives the host's updater),
 *   - mismatch (client behind) → "Update this Genie" guidance,
 *   - reconnecting             → spinner ("Host is upgrading — reconnecting…"),
 *   - lost                     → error + manual "Reconnect".
 *
 * The window is NEVER closed out from under the user — this covers the floor and
 * the session restores underneath once the link recovers.
 */
export default function HostUpgradeOverlay({
    link,
    hostname,
}: {
    link: RemoteLinkState;
    hostname?: string;
}) {
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const host = hostname ?? 'the host';

    const upgrade = async () => {
        setBusy(true);
        setErr(null);
        const res = await api().remote.upgradeHost().catch((e) => ({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
        }));
        if (!res.ok) {
            setErr(res.error ?? 'Upgrade failed.');
            setBusy(false);
        }
        // On success the link goes to 'reconnecting' (the overlay re-renders).
    };

    const reconnect = async () => {
        setBusy(true);
        setErr(null);
        await api().remote.reconnect().catch(() => {});
        setBusy(false);
    };

    let title: string;
    let body: string;
    let action: React.ReactNode = null;
    const spinning = link.phase === 'reconnecting';

    if (link.phase === 'mismatch' && link.direction === 'host-behind') {
        title = 'Host needs an upgrade';
        body = `${host} runs an older, incompatible Genie bridge (v${link.hostVersion} vs your v${link.localVersion}). Upgrade it to drive it safely.`;
        action = (
            <button type="button" className="ov-btn ov-btn-primary" disabled={busy} onClick={() => void upgrade()}>
                {busy ? 'Upgrading…' : 'Upgrade host'}
            </button>
        );
    } else if (link.phase === 'mismatch') {
        title = 'Update this Genie';
        body = `${host} runs a newer Genie bridge (v${link.hostVersion} vs your v${link.localVersion}). Update THIS Genie from your local window, then reconnect.`;
        action = (
            <button type="button" className="ov-btn" disabled={busy} onClick={() => void reconnect()}>
                Retry connection
            </button>
        );
    } else if (link.phase === 'reconnecting') {
        title = link.reason === 'upgrade' ? 'Host is upgrading' : 'Reconnecting to host';
        body =
            link.reason === 'upgrade'
                ? `${host} is downloading and installing the update, then restarting. Reconnecting automatically…`
                : `Lost the connection to ${host}. Reconnecting automatically…`;
    } else {
        // lost
        title = 'Host not responding';
        body = `${host} didn't come back in time. It may still be restarting — try reconnecting, or close this window.`;
        action = (
            <div style={{ display: 'flex', gap: 10 }}>
                <button type="button" className="ov-btn ov-btn-primary" disabled={busy} onClick={() => void reconnect()}>
                    {busy ? 'Reconnecting…' : 'Reconnect'}
                </button>
                <button type="button" className="ov-btn" onClick={() => window.close()}>
                    Close window
                </button>
            </div>
        );
    }

    return (
        <div
            role="status"
            aria-live="polite"
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 10000,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 18,
                background: 'rgba(10, 10, 12, 0.92)',
                backdropFilter: 'blur(6px)',
                color: '#e4e4e7',
                textAlign: 'center',
                padding: 32,
                WebkitAppRegion: 'drag',
            } as React.CSSProperties}
        >
            {spinning && (
                <div
                    aria-hidden
                    style={{
                        width: 36,
                        height: 36,
                        borderRadius: '50%',
                        border: '3px solid rgba(167,139,250,0.25)',
                        borderTopColor: '#a78bfa',
                        animation: 'host-overlay-spin 0.9s linear infinite',
                    }}
                />
            )}
            <div style={{ fontSize: 18, fontWeight: 700 }}>{title}</div>
            <div style={{ maxWidth: 440, fontSize: 13, lineHeight: 1.5, color: '#a1a1aa' }}>{body}</div>
            {err && <div style={{ color: '#f87171', fontSize: 12, maxWidth: 440 }}>{err}</div>}
            <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>{action}</div>
            <style>{`
                @keyframes host-overlay-spin { to { transform: rotate(360deg); } }
                .ov-btn {
                    font: inherit; font-size: 13px; font-weight: 600;
                    padding: 8px 16px; border-radius: 8px; cursor: pointer;
                    color: #e4e4e7; background: #27272a; border: 1px solid #3f3f46;
                }
                .ov-btn:hover { background: #3f3f46; }
                .ov-btn:disabled { opacity: 0.6; cursor: default; }
                .ov-btn-primary { background: #7c3aed; border-color: #7c3aed; color: #fff; }
                .ov-btn-primary:hover { background: #6d28d9; }
            `}</style>
        </div>
    );
}
