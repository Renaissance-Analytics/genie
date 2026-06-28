import { useEffect, useState } from 'react';
import { IconX, IconAlert, IconRefresh } from './icons';
import {
    api,
    hasGenieBridge,
    type GithubCapabilities,
    type GithubMissingPermissionGroup,
} from '../../lib/genie';
import {
    CAPABILITY_LABEL,
    PERMISSION_LABEL,
} from '../../lib/githubCapabilities';
import { useGitHubReconnect } from '../GitHubConnect';

/**
 * GitHub permissions resolve flyout. Surfaced two ways:
 *   - automatically once on boot when a required permission is missing (the
 *     dismissible boot prompt), and
 *   - from the persistent header warning icon, any time.
 *
 * It explains which capabilities are unavailable + WHY (the missing GitHub App
 * permissions), then walks the user through the REAL resolution sequence for a
 * GitHub App whose DECLARED permissions a token can't self-widen:
 *
 *   1. App owner adds the missing permission in the APP'S settings. This is the
 *      true first step — if the App doesn't declare the permission, there's
 *      nothing pending for any installation to approve (the dead end the old
 *      "Review on GitHub" link hit). Button → the App permission-settings page.
 *   2. Each affected INSTALLATION approves the resulting permission request.
 *      There's no GitHub "approve for all", so we list the specific installs
 *      missing each permission, each with a deep-link to its own review page —
 *      the user clicks through the listed ones.
 *   3. Reconnect — re-run the device flow to re-mint the token with the
 *      now-wider grant; then re-check and clear the warning if resolved.
 *
 * Reuses the Docs flyout chrome (right-side slide-in) like IssueWatchFlyout.
 */

export default function GithubCapabilitiesFlyout({
    open,
    caps,
    onClose,
}: {
    open: boolean;
    caps: GithubCapabilities;
    onClose: () => void;
}) {
    const [rechecking, setRechecking] = useState(false);
    // Reconnect device flow — the SHARED driver (no install-chooser bounce);
    // on success re-check capabilities so the header warning clears if the
    // fresh grant resolved everything.
    const {
        state: reconnectState,
        start: startReconnect,
        cancel: cancelReconnect,
    } = useGitHubReconnect({
        active: open,
        onSuccess: async () => {
            await api().github.recheckCapabilities().catch(() => {});
        },
    });

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

    // Open any GitHub deep-link in the OS browser (App settings, a specific
    // installation's review page). The URLs are built main-side and ride along
    // in the capabilities payload, so the renderer just opens them.
    const openUrl = (url: string) => {
        if (!url) return;
        void api().tynn.openInBrowser(url).catch(() => {});
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
                                because the Genie GitHub App doesn't grant the
                                permissions they need. These features are disabled
                                until the permissions are added and approved.
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
                                    <strong>1. App owner adds the permission.</strong>{' '}
                                    The missing permission has to be added to the
                                    Genie GitHub App itself first — until the App's
                                    OWNER does that, there's nothing pending for an
                                    installation to approve. Open the App's
                                    permission settings (App owner only):
                                </p>
                                <button
                                    type="button"
                                    className="ghcap-btn ghcap-btn-primary"
                                    onClick={() => openUrl(caps.appPermissionsUrl)}
                                    disabled={!caps.appPermissionsUrl}
                                >
                                    Open App permission settings…
                                </button>

                                <p className="ghcap-step">
                                    <strong>2. Each installation approves.</strong>{' '}
                                    Once the App declares the permission, every
                                    installation gets a pending request to approve.
                                    GitHub has no "approve for all", so open each
                                    listed installation and approve it:
                                </p>
                                <MissingInstallsList
                                    groups={caps.missingByPermission}
                                    onOpen={openUrl}
                                />

                                <p className="ghcap-step">
                                    <strong>3. Reconnect.</strong> After approving,
                                    reconnect so Genie picks up the new
                                    permissions.
                                </p>
                                {reconnectState.kind === 'pending' ? (
                                    <div className="ghcap-device">
                                        <span className="iw-muted">
                                            A browser opened at{' '}
                                            <code>{reconnectState.verificationUri}</code>.
                                            Enter this code:
                                        </span>
                                        <CodeChip code={reconnectState.userCode} />
                                        <button
                                            type="button"
                                            className="ghcap-btn"
                                            onClick={cancelReconnect}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        className="ghcap-btn"
                                        disabled={reconnectState.kind === 'starting'}
                                        onClick={() => void startReconnect()}
                                    >
                                        {reconnectState.kind === 'starting'
                                            ? 'Requesting code…'
                                            : 'Reconnect GitHub…'}
                                    </button>
                                )}
                                {reconnectState.kind === 'error' && (
                                    <span className="ghcap-error">
                                        {reconnectState.message}
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

/**
 * The per-permission, per-installation approval list. For each missing
 * permission it shows which specific installations don't grant it, each linking
 * to ITS own GitHub review page (there's no bulk-approve — the user clicks
 * through the listed ones). Renders nothing until detection has attributed the
 * gap to installs (e.g. before the first check), so the step copy stands alone.
 */
function MissingInstallsList({
    groups,
    onOpen,
}: {
    groups: GithubMissingPermissionGroup[];
    onOpen: (url: string) => void;
}) {
    const withInstalls = groups.filter((g) => g.installations.length > 0);
    if (withInstalls.length === 0) {
        return (
            <div className="iw-muted ghcap-installs-empty">
                The specific installations to approve will appear here once the
                App declares the permission and Genie re-checks.
            </div>
        );
    }
    return (
        <div className="ghcap-installs">
            {withInstalls.map((g) => (
                <div key={g.permission} className="ghcap-install-group">
                    <div className="ghcap-install-perm">
                        {PERMISSION_LABEL[g.permission] ?? g.permission} — missing
                        on {g.installations.length}{' '}
                        {g.installations.length === 1
                            ? 'installation'
                            : 'installations'}
                        :
                    </div>
                    <ul className="ghcap-install-list">
                        {g.installations.map((inst) => (
                            <li
                                key={`${g.permission}:${inst.login}`}
                                className="ghcap-install-row"
                            >
                                <span className="ghcap-install-name">
                                    {inst.login}
                                    <span className="ghcap-install-kind">
                                        {inst.isOrg ? 'org' : 'personal'}
                                    </span>
                                </span>
                                <button
                                    type="button"
                                    className="ghcap-btn ghcap-install-btn"
                                    onClick={() => onOpen(inst.reviewUrl)}
                                >
                                    Review…
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
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
