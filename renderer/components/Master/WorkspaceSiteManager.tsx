import { useCallback, useEffect, useState } from 'react';
import {
    Action,
    Badge,
    Callout,
    CodeView,
    Heading,
    Icon,
    Input,
    Modal,
    Select,
    Switch,
    Text,
} from '@particle-academy/react-fancy';
import { pickPath } from '../FilePickerModal';
import {
    api,
    isRemoteWindow,
    type HostedSiteCandidate,
    type HostedSiteRow,
    type ServiceEnvWrite,
    type ServiceRow,
    type WorkspaceRow,
} from '../../lib/genie';
import {
    canOpenInBrowser,
    relativeDocroot,
    siteManagerRows,
    siteStatusLabel,
    siteStatusTone,
    type SiteManagerRow,
} from '../../lib/hosting';
import {
    enabledServiceCount,
    envWriteNote,
    serviceEngineNote,
    serviceEnvPreview,
    serviceManagerRows,
    serviceStatusLabel,
    serviceStatusTone,
    servicesUnavailableNote,
    type ServiceManagerRow,
    type ServicesAvailability,
} from '../../lib/services';

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
 * The SERVICES tab is the other half of "hosted": the database and cache those
 * sites connect to, per workspace, each on its own port with its own data and
 * credential. Same card, same status rule, plus the two things a backing service
 * has that a web root does not — the `.env` block Genie writes into the user's
 * repository, and a server log to read when it will not start.
 *
 * All the decisions this renders from are pure functions in `lib/hosting.ts` and
 * `lib/services.ts` (the renderer test env has no DOM); this file is the wiring.
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
    const [services, setServices] = useState<ServiceRow[] | null>(null);
    /**
     * Whether services can be driven from HERE at all.
     *
     * A remote window is the case that matters: it drives another machine, and a
     * database is state — initialising a cluster on the client and writing its
     * credentials into a `.env` that lives on the host would point the app at a
     * server it cannot reach. `remote-bridge.ts` makes the calls inert; this is
     * what says so out loud instead of showing two switches that do nothing.
     */
    const [availability, setAvailability] = useState<ServicesAvailability>(
        isRemoteWindow() ? 'remote' : 'ready',
    );
    /** The one service whose log is open, and its tail. */
    const [logs, setLogs] = useState<{ key: string; text: string } | null>(null);
    /** What the last `.env` write did — including which of the user's own keys it
     *  supersedes, which is the whole reason main reports them. */
    const [envNote, setEnvNote] = useState<string | null>(null);

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
        try {
            setServices(await api().services.list(workspace.id));
        } catch {
            // The channel isn't there at all (a host with no service manager).
            // An empty list would read as "no services yet" — a state the user
            // could act on — so record that this host simply cannot.
            setServices([]);
            setAvailability((a) => (a === 'remote' ? a : 'unsupported'));
        }
    }, [workspace.id]);

    useEffect(() => {
        void refresh();
        // PUSH, not a poll: a site can take a build (or the first 277 MB runtime
        // download) to come up, so main tells us when anything moved. Services
        // ride the same signal — main's boot reconcile starts them BEFORE the
        // sites that depend on them and fires this once both have settled.
        return api().on.hostingChanged(() => void refresh());
    }, [refresh]);

    const rows = siteManagerRows(configured ?? [], candidates);
    const serviceRows = serviceManagerRows(services ?? []);
    const servicesOn = enabledServiceCount(serviceRows);
    const unavailableNote = servicesUnavailableNote(availability);

    /** Every service write reports what it did to the workspace's `.env`. */
    const noteEnv = (result: ServiceEnvWrite | null | undefined) =>
        setEnvNote(envWriteNote(result));

    /** Turn a service on/off. Enabling is what CREATES it — main mints the
     *  credential, converges the runtime and rewrites the `.env` in one call. */
    const setServiceEnabled = async (row: ServiceManagerRow, enabled: boolean) => {
        setBusy(row.key);
        setError(null);
        try {
            const res = await api().services.set(workspace.id, row.kind, { enabled });
            if (!res.ok) setError(res.error ?? 'Could not change that service.');
            noteEnv(res.env);
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(null);
        }
    };

    /** Rename the app's database. Postgres only, and only once the service
     *  exists — there is nothing to rename before that. */
    const setServiceDatabase = async (row: ServiceManagerRow, database: string) => {
        if (!row.configured || database === (row.database ?? '')) return;
        setBusy(row.key);
        setError(null);
        try {
            const res = await api().services.set(workspace.id, row.kind, { database });
            if (!res.ok) setError(res.error ?? 'Could not rename that database.');
            noteEnv(res.env);
            await refresh();
        } finally {
            setBusy(null);
        }
    };

    const startStopService = async (row: ServiceManagerRow, start: boolean) => {
        setBusy(row.key);
        setError(null);
        try {
            if (start) {
                // The first start of a kind DOWNLOADS its engine, so this can be
                // a long call; the row's own status carries the reason after.
                const res = await api().services.start(workspace.id, row.kind);
                if (!res.ok && res.error) setError(res.error);
            } else {
                await api().services.stop(workspace.id, row.kind);
            }
            await refresh();
        } finally {
            setBusy(null);
        }
    };

    /** Forget the service. Main leaves its data directory alone, and the button
     *  says so — a click here must never be how someone loses a database. */
    const removeService = async (row: ServiceManagerRow) => {
        if (!row.configured) return;
        setBusy(row.key);
        try {
            const res = await api().services.remove(workspace.id, row.kind);
            noteEnv(res.env);
            if (logs?.key === row.key) setLogs(null);
            await refresh();
        } finally {
            setBusy(null);
        }
    };

    const toggleServiceLogs = async (row: ServiceManagerRow) => {
        if (logs?.key === row.key) {
            setLogs(null);
            return;
        }
        setBusy(row.key);
        try {
            setLogs({ key: row.key, text: await api().services.logs(workspace.id, row.kind) });
        } finally {
            setBusy(null);
        }
    };

    /** Re-write the managed block by hand — for after the user has edited their
     *  `.env`, or created one Genie previously found missing. */
    const rewriteEnv = async () => {
        setBusy('env');
        setError(null);
        try {
            const result = await api().services.writeEnv(workspace.id);
            setEnvNote(
                envWriteNote(result) ??
                    (result.changed
                        ? 'Updated the managed block in this workspace’s .env.'
                        : 'This workspace’s .env is already up to date.'),
            );
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(null);
        }
    };

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
                        Services{servicesOn ? ` (${servicesOn})` : ''}
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
                    <>
                        <section className="set-section">
                            <div className="set-section-head">
                                <h2>Services</h2>
                                <span className="set-section-desc">
                                    What this workspace&apos;s app connects TO — its own
                                    database and cache, on their own ports, sharing nothing
                                    with another workspace&apos;s.
                                </span>
                            </div>

                            {unavailableNote ? (
                                <Callout color="amber" icon={<Icon name="info" size="sm" />}>
                                    {unavailableNote}
                                </Callout>
                            ) : services === null ? (
                                <Text size="xs" className="text-zinc-500">
                                    Reading this workspace&apos;s services…
                                </Text>
                            ) : (
                                <div className="site-list">
                                    {serviceRows.map((row) => (
                                        <ServiceCard
                                            key={row.key}
                                            row={row}
                                            busy={busy === row.key}
                                            logs={logs?.key === row.key ? logs.text : null}
                                            onToggle={(on) => void setServiceEnabled(row, on)}
                                            onRenameDatabase={(name) =>
                                                void setServiceDatabase(row, name)
                                            }
                                            onStart={() => void startStopService(row, true)}
                                            onStop={() => void startStopService(row, false)}
                                            onToggleLogs={() => void toggleServiceLogs(row)}
                                            onRemove={() => void removeService(row)}
                                        />
                                    ))}
                                </div>
                            )}
                        </section>

                        {!unavailableNote && (
                            <section className="set-section">
                                <div className="set-section-head">
                                    <h2>How your app gets these</h2>
                                    <span style={{ marginLeft: 'auto' }}>
                                        <Action
                                            size="sm"
                                            variant="ghost"
                                            icon="refresh-cw"
                                            disabled={busy === 'env'}
                                            onClick={() => void rewriteEnv()}
                                        >
                                            Rewrite .env block
                                        </Action>
                                    </span>
                                </div>
                                <div className="set-note">
                                    The hosted site is started WITH these settings, so it
                                    picks them up without any file. Genie also writes them
                                    into a delimited block at the end of the app&apos;s{' '}
                                    <code>.env</code> — that is what makes{' '}
                                    <code>artisan migrate</code> and{' '}
                                    <code>tinker</code> reach the same database. Everything
                                    outside those markers is yours and is never touched.
                                </div>
                                {envNote && <div className="set-note warn">{envNote}</div>}
                            </section>
                        )}
                    </>
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

/** One backing service: what it is, whether it is on, where it listens, and the
 *  `.env` lines it puts in the user's repository. */
function ServiceCard({
    row,
    busy,
    logs,
    onToggle,
    onRenameDatabase,
    onStart,
    onStop,
    onToggleLogs,
    onRemove,
}: {
    row: ServiceManagerRow;
    busy: boolean;
    /** The open log tail, or null when this row's log is closed. */
    logs: string | null;
    onToggle: (on: boolean) => void;
    onRenameDatabase: (name: string) => void;
    onStart: () => void;
    onStop: () => void;
    onToggleLogs: () => void;
    onRemove: () => void;
}) {
    const tone = serviceStatusTone(row);
    const engineNote = serviceEngineNote(row);
    const env = serviceEnvPreview(row);
    // Edited locally and committed on blur, exactly like a site's fields: every
    // write reconciles the runtime, so a save per keystroke would restart a
    // database while it is being named.
    const [database, setDatabase] = useState(row.database ?? '');
    useEffect(() => setDatabase(row.database ?? ''), [row.database]);

    return (
        <div className={`site-card${row.configured ? '' : ' is-candidate'}`}>
            <div className="site-card-head">
                <span className={`site-dot site-${tone}`} aria-hidden="true" />
                <div className="site-card-name">
                    <Text size="sm" style={{ fontWeight: 600 }}>
                        <Icon name={row.icon} size="xs" /> {row.name}
                        {row.engine !== row.kind && (
                            <>
                                {' '}
                                <Badge size="sm" variant="soft" color="zinc">
                                    {row.engine}
                                </Badge>
                            </>
                        )}
                    </Text>
                    <Text size="xs" className="text-zinc-500">
                        {row.blurb}
                    </Text>
                </div>
                <Switch
                    checked={row.enabled}
                    disabled={busy}
                    onCheckedChange={onToggle}
                    aria-label={`Run ${row.name} for this workspace`}
                />
            </div>

            <div className={`site-card-status site-${tone}`}>{serviceStatusLabel(row)}</div>

            {engineNote && (
                <Text size="xs" className="text-zinc-500">
                    <Icon name="info" size="xs" /> {engineNote}
                </Text>
            )}

            {row.kind === 'postgres' && row.configured && (
                <div className="site-card-fields">
                    <label className="site-field">
                        <span>Database</span>
                        <Input
                            value={database}
                            disabled={busy}
                            onValueChange={setDatabase}
                            onBlur={() => onRenameDatabase(database)}
                            placeholder="genie"
                            aria-label={`Database name for ${row.name}`}
                        />
                    </label>
                    <label className="site-field">
                        <span>Connects as</span>
                        <Input value={row.user ?? 'genie'} disabled readOnly />
                    </label>
                </div>
            )}

            {/* The block Genie writes, shown as the text it actually is. The
                password is a placeholder on purpose — main never sends it, and
                the app's own `.env` is the only place it belongs. */}
            {env.length > 0 && (
                <div className="svc-env">
                    <span className="svc-env-label">In your .env</span>
                    <CodeView
                        value={env.map((line) => `${line.key}=${line.value}`).join('\n')}
                        readOnly
                        minHeight={0}
                        maxHeight={160}
                    />
                </div>
            )}

            {logs !== null && (
                <div className="svc-env">
                    <span className="svc-env-label">Server log</span>
                    <CodeView
                        value={logs || 'Nothing logged yet — this service has not run.'}
                        readOnly
                        minHeight={0}
                        maxHeight={220}
                    />
                </div>
            )}

            <div className="set-actions">
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
                    <Action
                        size="sm"
                        variant="ghost"
                        icon="file-text"
                        disabled={busy}
                        onClick={onToggleLogs}
                    >
                        {logs !== null ? 'Hide log' : 'Log'}
                    </Action>
                )}
                {row.configured && (
                    <Action
                        size="sm"
                        variant="ghost"
                        icon="trash-2"
                        disabled={busy}
                        onClick={onRemove}
                        title="Stops it and forgets the configuration. The data directory is left on disk."
                    >
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
