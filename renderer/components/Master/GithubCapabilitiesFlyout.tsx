import { useEffect, useState } from 'react';
import { IconX, IconAlert, IconRefresh } from './icons';
import { api, hasGenieBridge, type GithubCapabilities } from '../../lib/genie';
import {
    CAPABILITY_LABEL,
    PERMISSION_LABEL,
} from '../../lib/githubCapabilities';

/**
 * GitHub permissions resolve flyout. Surfaced two ways:
 *   - automatically once on boot when a required permission is missing (the
 *     dismissible boot prompt), and
 *   - from the persistent header warning icon, any time.
 *
 * It explains which capabilities are unavailable + WHY (the missing GitHub App
 * permissions), then offers the only two real resolutions for a GitHub App
 * whose declared permissions a token can't self-widen:
 *
 *   (a) Review on GitHub — deep-link to the App installation's permission page
 *       so the installation OWNER can approve the pending permission update.
 *   (b) Reconnect GitHub — re-run the device flow to re-mint the token with the
 *       currently-granted permissions; then re-check and clear the warning if
 *       resolved.
 *
 * Reuses the Docs flyout chrome (right-side slide-in) like IssueWatchFlyout.
 */

type ReconnectState =
    | { kind: 'idle' }
    | { kind: 'starting' }
    | { kind: 'pending'; userCode: string; verificationUri: string }
    | { kind: 'error'; message: string };

export default function GithubCapabilitiesFlyout({
    open,
    caps,
    onClose,
}: {
    open: boolean;
    caps: GithubCapabilities;
    onClose: () => void;
}) {
    const [reconnect, setReconnect] = useState<ReconnectState>({ kind: 'idle' });
    const [rechecking, setRechecking] = useState(false);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    // Cancel any in-flight device flow when the flyout closes, so a half-started
    // reconnect doesn't keep polling in the background.
    useEffect(() => {
        if (open) return;
        if (reconnect.kind === 'pending' || reconnect.kind === 'starting') {
            api().github.cancelDevice().catch(() => {});
            setReconnect({ kind: 'idle' });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // While a reconnect device flow is pending, poll github:status until the
    // token lands, then re-check capabilities (which broadcasts the fresh
    // status — the header warning clears if the new grant resolved everything).
    useEffect(() => {
        if (reconnect.kind !== 'pending') return;
        const t = setInterval(async () => {
            const st = await api().github.status().catch(() => null);
            if (!st) return;
            // Key off the DEVICE FLOW's outcome, not st.connected: a stale/dead
            // token still reads connected=true, which would complete on the
            // first tick and clear the user code prematurely. flow.kind reaches
            // 'success' only when a FRESH token lands.
            if (st.flow.kind === 'success' || st.flow.kind === 'error') {
                clearInterval(t);
                if (st.flow.kind === 'success') {
                    setReconnect({ kind: 'idle' });
                    await api().github.recheckCapabilities().catch(() => {});
                } else {
                    setReconnect({ kind: 'error', message: st.flow.message });
                }
            }
        }, 1500);
        return () => clearInterval(t);
    }, [reconnect.kind]);

    const reviewOnGitHub = () => {
        // The App's install/permission page — where the installation owner
        // approves the pending permission update. No targetId: the chooser /
        // installation settings list every account the user can act on.
        void (async () => {
            const url = await api().github.installUrl().catch(() => null);
            if (url) await api().tynn.openInBrowser(url).catch(() => {});
        })();
    };

    const startReconnect = async () => {
        try {
            setReconnect({ kind: 'starting' });
            const code = await api().github.startDevice();
            setReconnect({
                kind: 'pending',
                userCode: code.user_code,
                verificationUri: code.verification_uri,
            });
            api().tynn.openInBrowser(code.verification_uri).catch(() => {});
        } catch (e) {
            setReconnect({
                kind: 'error',
                message: e instanceof Error ? e.message : String(e),
            });
        }
    };

    const recheckNow = async () => {
        setRechecking(true);
        try {
            await api().github.recheckCapabilities().catch(() => {});
        } finally {
            setRechecking(false);
        }
    };

    return (
        <div className={`docs-flyout-root${open ? ' open' : ''}`} aria-hidden={!open}>
            <div className="docs-scrim" onClick={onClose} />
            <aside
                className="docs-flyout iw-flyout"
                role="dialog"
                aria-label="GitHub permissions"
                aria-modal="false"
            >
                <div className="docs-head">
                    <span className="docs-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <IconAlert size={15} />
                        GitHub permissions
                    </span>
                    <span className="grow" />
                    <button
                        type="button"
                        className="gicon"
                        onClick={onClose}
                        title="Close"
                        aria-label="Close"
                    >
                        <IconX />
                    </button>
                </div>

                <div className="iw-body">
                    {!hasGenieBridge() ? (
                        <div className="iw-muted">This runs inside Genie.</div>
                    ) : !caps.connected ? (
                        <div className="iw-muted">
                            Connect GitHub in Settings → Connections to enable
                            issue watching, repo provisioning, and forks.
                        </div>
                    ) : caps.missing.length === 0 ? (
                        <div className="iw-muted">
                            All GitHub-powered features are available — Genie has
                            every permission it needs.
                        </div>
                    ) : (
                        <>
                            <div className="ghcap-intro">
                                Some GitHub-powered features are unavailable
                                because the Genie GitHub App is missing
                                permissions on your installation. These features
                                are disabled until the permissions are granted.
                            </div>

                            <div className="iw-section-head">Unavailable features</div>
                            <ul className="ghcap-list">
                                {caps.missing.map((key) => (
                                    <li key={key} className="ghcap-row">
                                        <IconAlert size={13} className="ghcap-row-icon" />
                                        <span className="ghcap-row-name">
                                            {CAPABILITY_LABEL[key] ?? key}
                                        </span>
                                    </li>
                                ))}
                            </ul>

                            <div className="iw-section-head">Missing permissions</div>
                            <div className="ghcap-perms">
                                {caps.missingPermissions.map((p) => (
                                    <span key={p} className="ghcap-perm">
                                        {PERMISSION_LABEL[p] ?? p}
                                    </span>
                                ))}
                            </div>

                            <div className="iw-section-head">Resolve</div>
                            <div className="ghcap-resolve">
                                <p className="ghcap-step">
                                    <strong>1. Review on GitHub.</strong> Open the
                                    Genie App's installation settings and approve
                                    the pending permission request. (Only the
                                    account/org owner can approve.)
                                </p>
                                <button
                                    type="button"
                                    className="ghcap-btn ghcap-btn-primary"
                                    onClick={reviewOnGitHub}
                                >
                                    Review on GitHub…
                                </button>

                                <p className="ghcap-step">
                                    <strong>2. Reconnect.</strong> After approving,
                                    reconnect so Genie picks up the new
                                    permissions.
                                </p>
                                {reconnect.kind === 'pending' ? (
                                    <div className="ghcap-device">
                                        <span className="iw-muted">
                                            A browser opened at{' '}
                                            <code>{reconnect.verificationUri}</code>.
                                            Enter this code:
                                        </span>
                                        <CodeChip code={reconnect.userCode} />
                                        <button
                                            type="button"
                                            className="ghcap-btn"
                                            onClick={() =>
                                                api()
                                                    .github.cancelDevice()
                                                    .catch(() => {})
                                                    .finally(() =>
                                                        setReconnect({ kind: 'idle' }),
                                                    )
                                            }
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        className="ghcap-btn"
                                        disabled={reconnect.kind === 'starting'}
                                        onClick={() => void startReconnect()}
                                    >
                                        {reconnect.kind === 'starting'
                                            ? 'Requesting code…'
                                            : 'Reconnect GitHub…'}
                                    </button>
                                )}
                                {reconnect.kind === 'error' && (
                                    <span className="ghcap-error">
                                        {reconnect.message}
                                    </span>
                                )}

                                <p className="ghcap-step">
                                    <strong>Already approved?</strong> Re-check
                                    without reconnecting.
                                </p>
                                <button
                                    type="button"
                                    className="ghcap-btn"
                                    disabled={rechecking}
                                    onClick={() => void recheckNow()}
                                >
                                    <IconRefresh size={12} />
                                    {rechecking ? ' Checking…' : ' Re-check now'}
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </aside>
        </div>
    );
}

/** Click-to-copy device code (mirrors GitHubConnect's CodeChip). */
function CodeChip({ code }: { code: string }) {
    const [copied, setCopied] = useState(false);
    const copy = () => {
        navigator.clipboard.writeText(code).then(
            () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
            },
            () => {},
        );
    };
    return (
        <button type="button" className="gh-code" onClick={copy} title="Click to copy">
            {code}
            <span className="gh-code-hint">{copied ? '✓ Copied' : 'Click to copy'}</span>
        </button>
    );
}
