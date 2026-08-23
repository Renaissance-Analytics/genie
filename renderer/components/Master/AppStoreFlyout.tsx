import { useCallback, useEffect, useState } from 'react';
import { Action, Badge, Input, Switch, Text } from '@particle-academy/react-fancy';
import { IconX } from './icons';
import {
    api,
    hasGenieBridge,
    type AppPreviewView,
    type AppUpdateState,
    type GithubInstallReview,
    type InstalledAppView,
} from '../../lib/genie';
import { appSummaryLine, permissionSummary, provenanceLine, updateNote } from '../../lib/apps-view';

/**
 * The GApp Store (Tynn #250, App Tray pivot).
 *
 * Opens from the App Tray's icon in the header. Everything about having apps lives
 * here — installing, updating, turning off, uninstalling — because the tray itself
 * is a launcher and a launcher that also managed things would be two jobs in one
 * row of icons.
 *
 * Installing from GitHub is deliberately NOT one click. It is a REVIEW the person
 * reads, then typing the app's own name, then the OS consent modal: three
 * deliberate acts, none of which an agent can click through. The review leads with
 * the COMMANDS the app will run, because an argv is code execution on this machine
 * and no permission in the model covers it.
 */
export default function AppStoreFlyout({
    open,
    onClose,
}: {
    open: boolean;
    onClose: () => void;
}) {
    const [apps, setApps] = useState<InstalledAppView[]>([]);
    const [previews, setPreviews] = useState<AppPreviewView[]>([]);
    const [updates, setUpdates] = useState<Record<string, AppUpdateState>>({});
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
    const [repoUrl, setRepoUrl] = useState('');
    const [review, setReview] = useState<GithubInstallReview | null>(null);
    const [typed, setTyped] = useState('');

    const refresh = useCallback(() => {
        if (!hasGenieBridge()) return;
        api()
            .apps.list()
            .then(setApps)
            .catch(() => {});
        // Previews are not apps and never appear in that list — that is the point
        // of them — so they are read separately, from the live registry in main.
        api()
            .apps.previews()
            .then(setPreviews)
            .catch(() => {});
    }, []);

    useEffect(() => {
        if (!open) return;
        refresh();
        // Opening the drawer is the moment "is there a newer version?" matters, so
        // that is when it is asked — never on a timer.
        api()
            .apps.checkUpdates()
            .then(setUpdates)
            .catch(() => setUpdates({}));
    }, [open, refresh]);

    const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => {
        setBusy(true);
        setMsg(null);
        try {
            const r = await fn();
            setMsg(r.ok ? { kind: 'ok', text: okText } : { kind: 'err', text: r.error ?? 'Failed.' });
        } catch (e) {
            setMsg({ kind: 'err', text: (e as Error).message });
        } finally {
            setBusy(false);
            refresh();
        }
    };

    const installFolder = async (devMode: boolean) => {
        setBusy(true);
        setMsg(null);
        try {
            const r = await api().apps.installFolder(undefined, devMode);
            if (r.ok) {
                // A warning means it INSTALLED and something did not come up.
                // Reporting that as plain success would hide a dead backend.
                setMsg(
                    r.warnings?.length
                        ? { kind: 'err', text: `Installed, but: ${r.warnings.join(' ')}` }
                        : { kind: 'ok', text: 'Installed.' },
                );
            } else if (r.errors?.length) {
                setMsg({ kind: 'err', text: r.errors.join(' ') });
            }
        } catch (e) {
            setMsg({ kind: 'err', text: (e as Error).message });
        } finally {
            setBusy(false);
            refresh();
        }
    };

    /**
     * Open a folder in a real GApp window without installing it.
     *
     * Read the same way an install's result is: `errors` mean it did not open and
     * nothing was created; `warnings` mean it DID open and something in it did not
     * come up. Collapsing the two would either hide a dead site or report a
     * perfectly good preview as a failure.
     */
    const previewFolder = async () => {
        setBusy(true);
        setMsg(null);
        try {
            const r = await api().apps.previewFolder();
            if (r.ok) {
                setMsg(
                    r.warnings?.length
                        ? { kind: 'err', text: `Previewing, but: ${r.warnings.join(' ')}` }
                        : { kind: 'ok', text: 'Previewing. Close the window to end it.' },
                );
            } else if (r.errors?.length) {
                setMsg({ kind: 'err', text: r.errors.join(' ') });
            }
        } catch (e) {
            setMsg({ kind: 'err', text: (e as Error).message });
        } finally {
            setBusy(false);
            refresh();
        }
    };

    const fetchReview = async () => {
        setBusy(true);
        setMsg(null);
        setReview(null);
        setTyped('');
        try {
            const r = await api().apps.reviewGithub(repoUrl.trim());
            if (r.ok) setReview(r.review);
            else setMsg({ kind: 'err', text: r.error });
        } catch (e) {
            setMsg({ kind: 'err', text: (e as Error).message });
        } finally {
            setBusy(false);
        }
    };

    const confirmGithub = async () => {
        if (!review) return;
        setBusy(true);
        try {
            const r = await api().apps.installGithub(review.commit, typed);
            setMsg(
                r.ok
                    ? { kind: 'ok', text: `Installed ${review.name}.` }
                    : { kind: 'err', text: r.errors?.join(' ') ?? 'Could not install it.' },
            );
            if (r.ok) {
                setReview(null);
                setRepoUrl('');
                setTyped('');
            }
        } catch (e) {
            setMsg({ kind: 'err', text: (e as Error).message });
        } finally {
            setBusy(false);
            refresh();
        }
    };

    if (!open) return null;

    return (
        <div
            onClick={onClose}
            style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.35)',
                zIndex: 60,
                display: 'flex',
                justifyContent: 'flex-end',
            }}
        >
            <aside
                onClick={(e) => e.stopPropagation()}
                style={{
                    width: 'min(620px, 96vw)',
                    height: '100%',
                    background: 'var(--bg-1, #16161a)',
                    borderLeft: '1px solid var(--bg-3, rgba(120,120,120,0.25))',
                    display: 'flex',
                    flexDirection: 'column',
                    boxShadow: '-8px 0 32px rgba(0,0,0,0.35)',
                }}
            >
                <header
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '12px 14px',
                        borderBottom: '1px solid var(--bg-3, rgba(120,120,120,0.25))',
                    }}
                >
                    <strong style={{ flex: 1 }}>Genie Apps</strong>
                    <button type="button" className="gicon" aria-label="Close" onClick={onClose}>
                        <IconX size={16} />
                    </button>
                </header>

                <div style={{ overflowY: 'auto', padding: 14, display: 'grid', gap: 14 }}>
                    {msg && (
                        <div className={`set-note${msg.kind === 'err' ? ' warn' : ''}`}>{msg.text}</div>
                    )}

                    <section style={{ display: 'grid', gap: 8 }}>
                        <Text size="sm">
                            <strong>Install from GitHub</strong>
                        </Text>
                        <div className="set-actions">
                            <Input
                                value={repoUrl}
                                onValueChange={setRepoUrl}
                                placeholder="https://github.com/owner/some-genie-app"
                            />
                            <Action icon="download" disabled={busy || !repoUrl.trim()} onClick={fetchReview}>
                                Fetch and review
                            </Action>
                        </div>

                        {review && (
                            <div className="set-note warn" data-testid="gapp-github-review">
                                <strong>
                                    {review.name} v{review.version}
                                </strong>
                                <div style={{ marginTop: 4 }}>
                                    from <code>{review.origin}</code> at commit{' '}
                                    <code>{review.shortCommit}</code>
                                </div>

                                {review.commands.length > 0 && (
                                    // FIRST, on its own. An argv is code that will
                                    // execute here, and no permission covers it — a
                                    // review that buried it would hide the most
                                    // dangerous line in the manifest.
                                    <>
                                        <div style={{ marginTop: 10 }}>
                                            <strong>It will run these commands on your machine:</strong>
                                        </div>
                                        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                                            {review.commands.map((c) => (
                                                <li key={c}>
                                                    <code>{c}</code>
                                                </li>
                                            ))}
                                        </ul>
                                    </>
                                )}

                                {review.highRisk.length > 0 && (
                                    <>
                                        <div style={{ marginTop: 10 }}>
                                            <strong>High-risk permissions:</strong>
                                        </div>
                                        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                                            {review.highRisk.map((c) => (
                                                <li key={c.key}>
                                                    {c.label} — {c.grantDescription}
                                                </li>
                                            ))}
                                        </ul>
                                    </>
                                )}

                                {review.escalations.map((e) => (
                                    <div key={e} style={{ marginTop: 6 }}>
                                        {e}
                                    </div>
                                ))}

                                <div style={{ marginTop: 12 }}>
                                    You will still be asked which permissions to grant. To go on, type{' '}
                                    <strong>{review.confirmPhrase}</strong>:
                                </div>
                                <div className="set-actions" style={{ marginTop: 6 }}>
                                    <Input
                                        value={typed}
                                        onValueChange={setTyped}
                                        placeholder={review.confirmPhrase}
                                    />
                                    <Action
                                        color="red"
                                        icon="download"
                                        // Typing is the deliberate act; a button
                                        // alone is a thing that gets clicked past.
                                        // Main re-checks this regardless.
                                        disabled={busy || typed.trim().toLowerCase() !== review.confirmPhrase}
                                        onClick={confirmGithub}
                                    >
                                        Install {review.name}
                                    </Action>
                                    <Action variant="ghost" disabled={busy} onClick={() => setReview(null)}>
                                        Cancel
                                    </Action>
                                </div>
                            </div>
                        )}
                    </section>

                    <section style={{ display: 'grid', gap: 8 }}>
                        <Text size="sm">
                            <strong>From a folder</strong>
                        </Text>
                        <div className="set-actions">
                            {/* Preview comes FIRST, because it is the one that
                                changes nothing. A developer reaching for this row
                                usually wants to look at their app, not to put it
                                on the machine, and the reversible action being
                                first is what makes that the easy choice. */}
                            <Action variant="ghost" icon="eye" disabled={busy} onClick={() => void previewFolder()}>
                                Preview an app…
                            </Action>
                            <Action variant="ghost" icon="folder" disabled={busy} onClick={() => void installFolder(false)}>
                                Install an app…
                            </Action>
                            <Action variant="ghost" icon="hammer" disabled={busy} onClick={() => void installFolder(true)}>
                                Install for development…
                            </Action>
                        </div>
                        <Text size="xs" className="text-zinc-500">
                            A preview opens the real app window — the real tab strip, the real Agent tab
                            with the panels its manifest declares — from a folder that is not installed.
                            Closing the window is the whole cleanup.
                        </Text>
                    </section>

                    {previews.length > 0 && (
                        <section style={{ display: 'grid', gap: 8 }}>
                            <Text size="sm">
                                <strong>Previewing now</strong>
                            </Text>
                            {/* Listed here because a preview leaves nothing behind
                                to find it by — no tray pill, no entry in Installed
                                — so without this the only way to end one is to go
                                and find its window. */}
                            {previews.map((live) => (
                                <div
                                    key={live.appId}
                                    className="plugin-card"
                                    style={{ padding: '10px 12px' }}
                                >
                                    <div className="plugin-card-head">
                                        <span className="set-row-main">
                                            <span className="set-row-label">
                                                {live.name}{' '}
                                                <Badge color="indigo" size="sm">
                                                    preview
                                                </Badge>
                                            </span>
                                            <span className="set-row-desc">{live.folder}</span>
                                        </span>
                                        <Action
                                            variant="ghost"
                                            disabled={busy}
                                            onClick={() =>
                                                void run(
                                                    () => api().apps.closePreview(live.appId),
                                                    'Preview closed.',
                                                )
                                            }
                                        >
                                            Close
                                        </Action>
                                    </div>
                                    {live.warnings.map((w) => (
                                        <Text key={w} size="xs" className="text-amber-400">
                                            {w}
                                        </Text>
                                    ))}
                                </div>
                            ))}
                        </section>
                    )}

                    <section style={{ display: 'grid', gap: 8 }}>
                        <Text size="sm">
                            <strong>Installed</strong>
                        </Text>
                        {apps.length === 0 ? (
                            <Text size="xs" className="text-zinc-500">
                                No apps yet. A Genie App brings its own front end, its own services and its
                                own workspace.
                            </Text>
                        ) : (
                            apps.map((app) => {
                                const note = updateNote(updates[app.id] ?? 'not-tracked', app);
                                return (
                                    <div key={app.id} className="plugin-card" style={{ padding: '10px 12px' }}>
                                        <div className="plugin-card-head">
                                            <span className="set-row-main">
                                                <span className="set-row-label">
                                                    {app.name}{' '}
                                                    <span className="text-zinc-500">{appSummaryLine(app)}</span>{' '}
                                                    {app.devMode && (
                                                        <Badge color="amber" size="sm">
                                                            development
                                                        </Badge>
                                                    )}
                                                </span>
                                                <span className="set-row-desc">{permissionSummary(app)}</span>
                                                <span className="set-row-desc">{provenanceLine(app)}</span>
                                            </span>
                                            <div className="set-actions">
                                                <Switch
                                                    checked={!app.revoked}
                                                    disabled={busy}
                                                    onCheckedChange={(on) =>
                                                        run(
                                                            () => api().apps.setRevoked(app.id, !on),
                                                            on
                                                                ? `${app.name} is on.`
                                                                : `${app.name} is turned off.`,
                                                        )
                                                    }
                                                />
                                                <Action
                                                    variant="ghost"
                                                    icon="external-link"
                                                    disabled={busy || app.revoked}
                                                    onClick={() =>
                                                        run(() => api().apps.open(app.id), `Opened ${app.name}.`)
                                                    }
                                                >
                                                    Open
                                                </Action>
                                                <Action
                                                    variant="ghost"
                                                    color="red"
                                                    icon="trash-2"
                                                    disabled={busy}
                                                    onClick={() =>
                                                        run(
                                                            () => api().apps.uninstall(app.id),
                                                            `Uninstalled ${app.name}.`,
                                                        )
                                                    }
                                                >
                                                    Uninstall
                                                </Action>
                                            </div>
                                        </div>
                                        {note && <div className="set-note">{note}</div>}
                                    </div>
                                );
                            })
                        )}
                    </section>
                </div>
            </aside>
        </div>
    );
}
