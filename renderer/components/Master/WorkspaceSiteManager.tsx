import { useCallback, useEffect, useState } from 'react';
import {
    Action,
    Heading,
    Icon,
    Input,
    Modal,
    Select,
    Switch,
    Text,
} from '@particle-academy/react-fancy';
import { pickPath } from '../FilePickerModal';
import { api, type HostedSiteCandidate, type HostedSiteRow, type WorkspaceRow } from '../../lib/genie';
import {
    canOpenInBrowser,
    relativeDocroot,
    siteManagerRows,
    siteStatusLabel,
    siteStatusTone,
    type SiteManagerRow,
} from '../../lib/hosting';

/**
 * The WORKSPACE SITE MANAGER (Tynn #232) — the per-workspace hosting control
 * panel, deliberately SEPARATE from Workspace settings (owner decision,
 * 2026-08-01).
 *
 * Workspace settings is where a workspace's identity and agent policy live and
 * is opened rarely; hosting is an operational surface you come back to while
 * working — is my site up, what is its URL, why did it stop. Putting it in the
 * settings modal would bury it under nine other sections.
 *
 * What it does:
 *   - lists what Genie could serve here (`hosting.candidates`) alongside what it
 *     is already configured to serve (`hosting.list`), so enabling a site is one
 *     click and nobody types a document root by hand;
 *   - lets each site be enabled/disabled, switched between PHP and static, and
 *     pointed at a different docroot;
 *   - shows the live state — the stable URL when it is running, the REASON when
 *     it is not — and starts/stops it;
 *   - opens a running site in the Genie Browser.
 *
 * SERVICES (databases, cache, queues, object storage) are the next chunk; the
 * tab is here, clearly labelled, rather than absent — the panel's shape is part
 * of the decision the owner already made.
 *
 * All the decisions this renders from are pure functions in `lib/hosting.ts`
 * (the renderer test env has no DOM); this file is the wiring.
 */

type Tab = 'sites' | 'services';

const KIND_OPTIONS = [
    { value: 'php', label: 'PHP — a Laravel/front-controller app (needs FrankenPHP)' },
    { value: 'static', label: 'Static — a built frontend (no PHP runtime needed)' },
];

export default function WorkspaceSiteManager({
    workspace,
    onClose,
}: {
    workspace: WorkspaceRow;
    onClose: () => void;
}) {
    const [tab, setTab] = useState<Tab>('sites');
    const [configured, setConfigured] = useState<HostedSiteRow[] | null>(null);
    const [candidates, setCandidates] = useState<HostedSiteCandidate[]>([]);
    /** The row (by key) with an action in flight — disables just that row. */
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** Local edits to a row's fields, committed on blur / change. */
    const [draft, setDraft] = useState<Record<string, Partial<SiteManagerRow>>>({});
    const [adding, setAdding] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const [rows, found] = await Promise.all([
                api().hosting.list(workspace.id),
                api().hosting.candidates(workspace.id).catch(() => []),
            ]);
            setConfigured(rows);
            setCandidates(found);
        } catch {
            setConfigured([]);
            setCandidates([]);
        }
    }, [workspace.id]);

    useEffect(() => {
        void refresh();
        // PUSH, not a poll: a site can take a build (or the first 277 MB runtime
        // download) to come up, so main tells us when anything moved.
        return api().on.hostingChanged(() => void refresh());
    }, [refresh]);

    const rows = siteManagerRows(configured ?? [], candidates);

    /** Persist one site, then re-read. Every write goes through here so the
     *  panel always reflects what the RUNTIME did, not what we asked for. */
    const save = async (key: string, patch: Record<string, unknown>) => {
        setBusy(key);
        setError(null);
        try {
            const res = await api().hosting.set(workspace.id, patch);
            if (!res.ok) setError(res.error ?? 'Could not save that site.');
            setDraft((d) => {
                const next = { ...d };
                delete next[key];
                return next;
            });
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(null);
        }
    };

    /** Turn hosting on/off for a row. A candidate is CREATED by its first
     *  enable, carrying the kind + docroot Genie detected. */
    const setEnabled = (row: SiteManagerRow, enabled: boolean) =>
        save(row.key, {
            ...(row.siteId ? { siteId: row.siteId } : {}),
            hostname: row.hostname,
            kind: row.kind,
            docroot: row.docroot,
            enabled,
        });

    const startStop = async (row: SiteManagerRow, start: boolean) => {
        setBusy(row.key);
        setError(null);
        try {
            if (start) {
                const res = await api().hosting.start(workspace.id, row.hostname);
                // A start that didn't take reports WHY here; the row's own
                // status carries the runtime's reason after the refresh.
                if (!res.ok && res.error) setError(res.error);
            } else {
                await api().hosting.stop(row.siteId ?? '');
            }
            await refresh();
        } finally {
            setBusy(null);
        }
    };

    const remove = async (row: SiteManagerRow) => {
        if (!row.siteId) return;
        setBusy(row.key);
        try {
            await api().hosting.remove(workspace.id, row.siteId);
            await refresh();
        } finally {
            setBusy(null);
        }
    };

    const open = async (row: SiteManagerRow) => {
        const res = await api().sites.open(row.genName);
        if (!res.ok && res.error) setError(res.error);
    };

    /** Pick a docroot with the in-app browser, seeded inside this workspace. A
     *  directory outside it is refused HERE, with the reason, rather than by a
     *  save that silently does nothing. */
    const pickDocroot = async (row: SiteManagerRow) => {
        const picked = await pickPath({
            mode: 'directory',
            title: `Document root for ${row.hostname}`,
            initialPath: workspace.path,
        });
        if (!picked) return;
        const rel = relativeDocroot(workspace.path, picked);
        if (rel === null) {
            setError(
                'A document root has to be inside the workspace — Genie will not serve a directory from outside it.',
            );
            return;
        }
        if (row.configured) await save(row.key, { siteId: row.siteId, docroot: rel });
        else setDraft((d) => ({ ...d, [row.key]: { ...d[row.key], docroot: rel } }));
    };

    return (
        <Modal open onClose={onClose} size="xl">
            <div className="ws-settings site-manager">
                <div className="ws-settings-head">
                    <Heading as="h2" size="sm">
                        Site Manager — {workspace.project_name}
                    </Heading>
                    <Text size="xs" className="text-zinc-500">
                        Sites Genie serves itself from this workspace: a real server, a
                        built app, one stable URL. Nothing is served until you enable it.
                    </Text>
                </div>

                <div className="set-seg site-tabs" role="tablist">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === 'sites'}
                        className={tab === 'sites' ? 'active' : ''}
                        onClick={() => setTab('sites')}
                    >
                        Sites{rows.length ? ` (${rows.length})` : ''}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === 'services'}
                        className={tab === 'services' ? 'active' : ''}
                        onClick={() => setTab('services')}
                    >
                        Services
                    </button>
                </div>

                {error && <div className="set-note bad">{error}</div>}

                {tab === 'sites' ? (
                    <>
                        <section className="set-section">
                            <div className="set-section-head">
                                <h2>Sites</h2>
                                <span className="set-section-desc">
                                    Detected from this workspace&apos;s repos — a Laravel{' '}
                                    <code>public/</code>, a built <code>dist/</code>, or a
                                    frontend Genie can build.
                                </span>
                                <span style={{ marginLeft: 'auto' }}>
                                    <Action
                                        size="sm"
                                        variant="ghost"
                                        icon="refresh-cw"
                                        onClick={() => void refresh()}
                                    >
                                        Rescan
                                    </Action>
                                </span>
                            </div>

                            {configured === null ? (
                                <Text size="xs" className="text-zinc-500">
                                    Looking for sites in this workspace…
                                </Text>
                            ) : rows.length === 0 ? (
                                <div className="set-note">
                                    Genie found nothing hostable here yet. A site is a
                                    Laravel app (<code>public/index.php</code>) or a
                                    frontend that builds to a folder with an{' '}
                                    <code>index.html</code>. Add one by hand below if
                                    yours lives somewhere else.
                                </div>
                            ) : (
                                <div className="site-list">
                                    {rows.map((row) => {
                                        // EVERY handler works from the drafted
                                        // row, not the fetched one: a user who
                                        // renames a proposal (or repoints its
                                        // docroot) and then flips it on must get
                                        // the site they just described, not the
                                        // one Genie originally guessed.
                                        const live = { ...row, ...draft[row.key] };
                                        return (
                                            <SiteCard
                                                key={row.key}
                                                row={live}
                                                busy={busy === row.key}
                                                onToggle={(on) => void setEnabled(live, on)}
                                                onPatch={(patch) =>
                                                    setDraft((d) => ({
                                                        ...d,
                                                        [row.key]: { ...d[row.key], ...patch },
                                                    }))
                                                }
                                                onCommit={(patch) => {
                                                    // A proposal has nothing to
                                                    // write to yet — its edits
                                                    // live in the draft until the
                                                    // enable creates it.
                                                    if (!live.configured) return;
                                                    // Blur fires whether or not
                                                    // anything changed, and every
                                                    // save reconciles the whole
                                                    // runtime — so only write a
                                                    // real edit.
                                                    const changed = Object.entries(patch).some(
                                                        ([k, v]) =>
                                                            v !== row[k as keyof SiteManagerRow],
                                                    );
                                                    if (!changed) return;
                                                    void save(live.key, {
                                                        siteId: live.siteId,
                                                        ...patch,
                                                    });
                                                }}
                                                onPickDocroot={() => void pickDocroot(live)}
                                                onStart={() => void startStop(live, true)}
                                                onStop={() => void startStop(live, false)}
                                                onOpen={() => void open(live)}
                                                onRemove={() => void remove(live)}
                                            />
                                        );
                                    })}
                                </div>
                            )}

                            <div className="set-actions">
                                <Action
                                    size="sm"
                                    variant="ghost"
                                    icon="plus"
                                    onClick={() => setAdding((v) => !v)}
                                >
                                    {adding ? 'Cancel' : 'Add a site by hand…'}
                                </Action>
                            </div>

                            {adding && (
                                <AddSiteForm
                                    workspacePath={workspace.path}
                                    onCancel={() => setAdding(false)}
                                    onAdd={async (patch) => {
                                        await save('new', { ...patch, enabled: true });
                                        setAdding(false);
                                    }}
                                    onError={setError}
                                />
                            )}
                        </section>

                        <section className="set-section">
                            <div className="set-section-head">
                                <h2>How a site is served</h2>
                            </div>
                            <div className="set-note">
                                A <strong>PHP</strong> site is served by FrankenPHP, which
                                Genie downloads once, the first time one starts. A{' '}
                                <strong>static</strong> site needs no download — Genie runs
                                the project&apos;s build if the docroot has no{' '}
                                <code>index.html</code> yet, then serves it. Either way the
                                site gets ONE stable, same-origin URL, which is what makes
                                it work in the Genie Browser and over a remote connection.
                            </div>
                        </section>
                    </>
                ) : (
                    <section className="set-section">
                        <div className="set-section-head">
                            <h2>Services</h2>
                            <span className="set-section-desc">
                                Per-workspace backing services
                            </span>
                        </div>
                        <div className="set-note warn">
                            <strong>Not built yet.</strong> Databases (MySQL / PostgreSQL),
                            cache + queues (Redis), object storage (S3-compatible) and mail
                            capture will be started, stopped and monitored per workspace
                            from here — the same panel as the sites they back. Until then,
                            point a site at whatever you already run.
                        </div>
                    </section>
                )}
            </div>
        </Modal>
    );
}

/** One site: what it is, where it comes from, whether it is on, and what the
 *  runtime says about it. */
function SiteCard({
    row,
    busy,
    onToggle,
    onPatch,
    onCommit,
    onPickDocroot,
    onStart,
    onStop,
    onOpen,
    onRemove,
}: {
    row: SiteManagerRow;
    busy: boolean;
    onToggle: (on: boolean) => void;
    onPatch: (patch: Partial<SiteManagerRow>) => void;
    onCommit: (patch: Record<string, unknown>) => void;
    onPickDocroot: () => void;
    onStart: () => void;
    onStop: () => void;
    onOpen: () => void;
    onRemove: () => void;
}) {
    const tone = siteStatusTone(row);
    return (
        <div className={`site-card${row.configured ? '' : ' is-candidate'}`}>
            <div className="site-card-head">
                <span className={`site-dot site-${tone}`} aria-hidden="true" />
                <div className="site-card-name">
                    <Text size="sm" style={{ fontWeight: 600 }}>
                        {row.name}
                    </Text>
                    <Text size="xs" className="text-zinc-500">
                        {row.hostname}
                        {row.reason ? ` · ${row.reason}` : ''}
                    </Text>
                </div>
                <Switch
                    checked={row.enabled}
                    disabled={busy}
                    onCheckedChange={onToggle}
                    aria-label={`Host ${row.hostname}`}
                />
            </div>

            <div className={`site-card-status site-${tone}`}>{siteStatusLabel(row)}</div>

            {/* Editable for a PROPOSAL too: those edits sit in the draft until
                the enable creates the site with them. Forcing a user to accept
                Genie's guess, host it, then correct it would start a server on
                the wrong directory in between. */}
            <div className="site-card-fields">
                <label className="site-field">
                    <span>Hostname</span>
                    <Input
                        value={row.hostname}
                        disabled={busy}
                        onValueChange={(v: string) => onPatch({ hostname: v })}
                        onBlur={() => onCommit({ hostname: row.hostname })}
                        placeholder="app.test"
                        aria-label={`Hostname for ${row.name}`}
                    />
                </label>
                <label className="site-field">
                    <span>Serve as</span>
                    <Select
                        value={row.kind}
                        disabled={busy}
                        onValueChange={(v) => {
                            onPatch({ kind: v as SiteManagerRow['kind'] });
                            onCommit({ kind: v });
                        }}
                        list={KIND_OPTIONS}
                    />
                </label>
                <label className="site-field site-field-wide">
                    <span>Document root</span>
                    <div className="site-docroot">
                        <Input
                            value={row.docroot}
                            disabled={busy}
                            onValueChange={(v: string) => onPatch({ docroot: v })}
                            onBlur={() => onCommit({ docroot: row.docroot })}
                            placeholder="repos/app/public"
                            aria-label={`Document root for ${row.name}`}
                        />
                        <Action
                            size="sm"
                            variant="ghost"
                            icon="folder"
                            disabled={busy}
                            onClick={onPickDocroot}
                        >
                            Browse
                        </Action>
                    </div>
                </label>
            </div>

            {row.needsBuild && (
                <Text size="xs" className="text-zinc-500">
                    <Icon name="hammer" size="xs" /> Not built yet — enabling this runs the
                    project&apos;s build first.
                </Text>
            )}

            <div className="set-actions">
                <Action
                    size="sm"
                    color="blue"
                    icon="external-link"
                    disabled={busy || !canOpenInBrowser(row)}
                    onClick={onOpen}
                >
                    Open in Genie Browser
                </Action>
                {row.state === 'running' ? (
                    <Action size="sm" variant="ghost" icon="square" disabled={busy} onClick={onStop}>
                        Stop
                    </Action>
                ) : (
                    <Action
                        size="sm"
                        variant="ghost"
                        icon="play"
                        disabled={busy || !row.configured || !row.enabled}
                        onClick={onStart}
                    >
                        {row.state === 'failed' ? 'Retry' : 'Start'}
                    </Action>
                )}
                {row.configured && (
                    <Action size="sm" variant="ghost" icon="trash-2" disabled={busy} onClick={onRemove}>
                        Remove
                    </Action>
                )}
            </div>
        </div>
    );
}

/** Add a site Genie did not detect — the escape hatch, so an unusual layout is
 *  never a dead end. */
function AddSiteForm({
    workspacePath,
    onAdd,
    onCancel,
    onError,
}: {
    workspacePath: string;
    onAdd: (patch: Record<string, unknown>) => Promise<void>;
    onCancel: () => void;
    onError: (message: string) => void;
}) {
    const [hostname, setHostname] = useState('');
    const [kind, setKind] = useState('static');
    const [docroot, setDocroot] = useState('');
    const [saving, setSaving] = useState(false);

    const browse = async () => {
        const picked = await pickPath({
            mode: 'directory',
            title: 'Document root for the new site',
            initialPath: workspacePath,
        });
        if (!picked) return;
        const rel = relativeDocroot(workspacePath, picked);
        if (rel === null) {
            onError(
                'A document root has to be inside the workspace — Genie will not serve a directory from outside it.',
            );
            return;
        }
        setDocroot(rel);
    };

    return (
        <div className="site-card">
            <div className="site-card-fields">
                <label className="site-field">
                    <span>Hostname</span>
                    <Input
                        value={hostname}
                        onValueChange={setHostname}
                        placeholder="app.test"
                        aria-label="Hostname for the new site"
                    />
                </label>
                <label className="site-field">
                    <span>Serve as</span>
                    <Select value={kind} onValueChange={setKind} list={KIND_OPTIONS} />
                </label>
                <label className="site-field site-field-wide">
                    <span>Document root</span>
                    <div className="site-docroot">
                        <Input
                            value={docroot}
                            onValueChange={setDocroot}
                            placeholder="repos/app/public"
                            aria-label="Document root for the new site"
                        />
                        <Action size="sm" variant="ghost" icon="folder" onClick={() => void browse()}>
                            Browse
                        </Action>
                    </div>
                </label>
            </div>
            <div className="set-actions">
                <Action
                    size="sm"
                    color="blue"
                    icon="check"
                    disabled={saving || !hostname.trim()}
                    onClick={async () => {
                        setSaving(true);
                        try {
                            await onAdd({ hostname: hostname.trim(), kind, docroot });
                        } finally {
                            setSaving(false);
                        }
                    }}
                >
                    {saving ? 'Adding…' : 'Add & host'}
                </Action>
                <Action size="sm" variant="ghost" onClick={onCancel}>
                    Cancel
                </Action>
            </div>
        </div>
    );
}
