import { useCallback, useEffect, useState } from 'react';
import {
    Action,
    Badge,
    Callout,
    Card,
    CodeView,
    Heading,
    Icon,
    Input,
    Modal,
    Select,
    Tabs,
    Text,
} from '@particle-academy/react-fancy';
import {
    api,
    isRemoteWindow,
    type DevRuntimeInfo,
    type DevServiceCatalogEntry,
    type DevServiceInfo,
    type DevSiteInfo,
    type DevSiteRunOption,
    type WorkspaceRow,
} from '../../lib/genie';
import {
    canOpenInBrowser,
    devServerGuidance,
    holdersNote,
    isolationNote,
    optionCaveat,
    optionLabel,
    runtimeSummary,
    serviceStatusLabel,
    serviceStatusTone,
    serviceTitle,
    siteReach,
    siteStatusLabel,
    siteStatusTone,
    type DevAvailability,
} from '../../lib/dev-server';

/**
 * The WORKSPACE SITE MANAGER — the human view over the Hosting Manager, and
 * deliberately the SECONDARY one.
 *
 * The discovery decided agents administer this through the `manageSite` /
 * `manageService` MCP tools and a human UX exists beside them. So this panel is
 * not a second implementation of those verbs: every button here calls
 * `api().devServer.site` / `.service`, which main routes into the SAME
 * `runManageSite` / `runManageService` an agent reaches. A behaviour can be
 * added once and appear in both, and neither can drift from the other.
 *
 * It is also deliberately separate from Workspace settings (owner decision,
 * 2026-08-01): settings is identity and policy, opened rarely; this is
 * operational — is my site up, what is its URL, why did it stop.
 *
 * ## What each tab is
 *
 *   - **SITES** — what this workspace HOSTS. Each one is BUILT and then served
 *     the way it runs in production, so status shows `ready` apart from
 *     `running`, and the log carries the BUILD as well as the server. Both
 *     origins, start/stop/restart, open in the Genie Browser, and the layered
 *     recipe picker that turns "this repo" into a build, a production server
 *     and a port.
 *   - **SERVICES** — what those sites CONNECT TO. The engine and version, how
 *     many workspaces hold it, what isolation this workspace actually has, the
 *     connection surface from both sides of the boundary, the injected env, the
 *     dedicated opt-out, and the engine log.
 *
 * ## Host-awareness is a first-class state, not an error
 *
 * Most machines have no Docker the first time this is opened, and a remote
 * window drives a different machine entirely. Neither is a failure: the panel
 * leads with what to do, exactly as the MCP's `devServerAvailable` gate does for
 * an agent, instead of rendering controls that cannot work.
 *
 * All the judgements this renders from are pure functions in `lib/dev-server.ts`
 * (the renderer test env has no DOM); this file is the wiring.
 */

type Tab = 'sites' | 'services';

export default function WorkspaceSiteManager({
    workspace,
    onClose,
}: {
    workspace: WorkspaceRow;
    onClose: () => void;
}) {
    const [tab, setTab] = useState<Tab>('sites');
    const [sites, setSites] = useState<DevSiteInfo[] | null>(null);
    const [services, setServices] = useState<DevServiceInfo[] | null>(null);
    const [catalog, setCatalog] = useState<DevServiceCatalogEntry[]>([]);
    const [runtime, setRuntime] = useState<DevRuntimeInfo | null>(null);
    /** The row (by id) with an action in flight — disables just that row. */
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** The one row whose log is open, and its tail. */
    const [logs, setLogs] = useState<{ id: string; text: string } | null>(null);
    /** The connection env of the services tab, when asked for. */
    const [connEnv, setConnEnv] = useState<Record<string, string> | null>(null);
    const [adding, setAdding] = useState(false);
    /** What the last create did about the framework's Host allowlist. Kept
     *  visible after the form closes, because a `documented` outcome is
     *  something the user still has to act on in the repo. */
    const [hostNote, setHostNote] = useState<{ status: string; note: string } | null>(null);

    /**
     * Whether the Dev Server can be driven from HERE at all.
     *
     * A remote window is the case that matters: it drives another machine, and
     * a container started on the CLIENT would mount the client's filesystem
     * while the surface around it lists the HOST's workspaces.
     * `remote-bridge.ts` makes the calls inert; this is what says so out loud
     * instead of showing controls that do nothing.
     */
    const availability: DevAvailability = isRemoteWindow() ? 'remote' : 'ready';
    const remoteNote = devServerGuidance(availability);
    const runtimeInfo = runtimeSummary(runtime);
    const hasRuntime = runtimeInfo.tone === 'running';

    const refresh = useCallback(async () => {
        if (availability === 'remote') {
            setSites([]);
            setServices([]);
            return;
        }
        try {
            setRuntime(await api().devServer.runtimeStatus());
        } catch {
            setRuntime({ kind: 'none' });
        }
        try {
            const res = await api().devServer.site(workspace.id, { action: 'list' });
            setSites(res.sites ?? []);
        } catch {
            setSites([]);
        }
        try {
            // `catalog` returns the engines AND this workspace's services in one
            // call, so the picker can offer what is missing without a second
            // round trip.
            const res = await api().devServer.service(workspace.id, { action: 'catalog' });
            setServices(res.services ?? []);
            setCatalog(res.catalog ?? []);
        } catch {
            setServices([]);
        }
    }, [workspace.id, availability]);

    useEffect(() => {
        void refresh();
        // PUSH, not a poll: a site can take an image pull or a Dockerfile build
        // to come up, so main tells us when anything moved.
        return api().on.devServerChanged(() => void refresh());
    }, [refresh]);

    /** Every site action goes through here, so the panel always reflects what
     *  the RUNTIME did rather than what we asked for. */
    const site = async (id: string | null, req: Record<string, unknown>) => {
        setBusy(id);
        setError(null);
        try {
            const res = await api().devServer.site(workspace.id, req as never);
            if (!res.ok && res.error) setError(res.error);
            setSites(res.sites ?? []);
            if (res.logs !== undefined && res.affectedId) {
                setLogs({ id: res.affectedId, text: res.logs });
            }
            if (res.hostAllowlist && res.hostAllowlist.status !== 'not-needed') {
                setHostNote(res.hostAllowlist);
            }
            return res;
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            return null;
        } finally {
            setBusy(null);
        }
    };

    const service = async (id: string | null, req: Record<string, unknown>) => {
        setBusy(id);
        setError(null);
        try {
            const res = await api().devServer.service(workspace.id, req as never);
            if (!res.ok && res.error) setError(res.error);
            setServices(res.services ?? []);
            if (res.catalog) setCatalog(res.catalog);
            if (res.logs !== undefined && res.affectedId) {
                setLogs({ id: res.affectedId, text: res.logs });
            }
            if (res.env) setConnEnv(res.env);
            return res;
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            return null;
        } finally {
            setBusy(null);
        }
    };

    const toggleLog = async (id: string, kind: 'site' | 'service') => {
        if (logs?.id === id) {
            setLogs(null);
            return;
        }
        if (kind === 'site') await site(id, { action: 'logs', id, tail: 200 });
        else await service(id, { action: 'logs', id, tail: 200 });
    };

    const siteRows = sites ?? [];
    const serviceRows = services ?? [];
    const runningSites = siteRows.filter((s) => s.state === 'running').length;

    return (
        <Modal open onClose={onClose} size="xl">
            <div className="ws-settings site-manager">
                <div className="ws-settings-head">
                    <Heading as="h2" size="sm">
                        Hosting — {workspace.project_name}
                    </Heading>
                    <Text size="xs" className="text-zinc-500">
                        The sites this workspace hosts and the services behind them, each in a
                        container sandboxed to this workspace. Every site is built and then
                        served the way it runs in production. Nothing runs until you start it.
                    </Text>
                </div>

                {remoteNote ? (
                    <Callout color="amber" icon={<Icon name="info" size="sm" />}>
                        {remoteNote}
                    </Callout>
                ) : (
                    <>
                        <RuntimeBanner summary={runtimeInfo} />
                        {error && <div className="set-note bad">{error}</div>}

                        <Tabs activeTab={tab} onTabChange={(t) => setTab(t as Tab)}>
                            <Tabs.List>
                                <Tabs.Tab value="sites">
                                    Sites{siteRows.length ? ` (${runningSites}/${siteRows.length})` : ''}
                                </Tabs.Tab>
                                <Tabs.Tab value="services">
                                    Services{serviceRows.length ? ` (${serviceRows.length})` : ''}
                                </Tabs.Tab>
                            </Tabs.List>
                            <Tabs.Panels>
                                <Tabs.Panel value="sites">
                                    <SitesTab
                                        workspace={workspace}
                                        sites={sites}
                                        busy={busy}
                                        logs={logs}
                                        hasRuntime={hasRuntime}
                                        adding={adding}
                                        onAddingChange={setAdding}
                                        hostNote={hostNote}
                                        onAction={site}
                                        onToggleLog={(id) => void toggleLog(id, 'site')}
                                        onRefresh={() => void refresh()}
                                    />
                                </Tabs.Panel>
                                <Tabs.Panel value="services">
                                    <ServicesTab
                                        services={services}
                                        catalog={catalog}
                                        busy={busy}
                                        logs={logs}
                                        connEnv={connEnv}
                                        hasRuntime={hasRuntime}
                                        onAction={service}
                                        onToggleLog={(id) => void toggleLog(id, 'service')}
                                    />
                                </Tabs.Panel>
                            </Tabs.Panels>
                        </Tabs>
                    </>
                )}
            </div>
        </Modal>
    );
}

/** Which runtime is driving — or, on most first runs, what to install. Shown at
 *  the top of both tabs because every action below depends on it. */
function RuntimeBanner({ summary }: { summary: ReturnType<typeof runtimeSummary> }) {
    if (!summary.guidance) {
        return (
            <Text size="xs" className="text-zinc-500">
                <span className="site-dot site-running" aria-hidden="true" /> Running containers
                with {summary.label}.
            </Text>
        );
    }
    return (
        <Callout color="blue" icon={<Icon name="info" size="sm" />}>
            <strong>{summary.label}.</strong> {summary.guidance} Genie detects Docker or Podman
            whenever you act — there is no need to restart it once one is installed.
        </Callout>
    );
}

// --- sites ------------------------------------------------------------------

function SitesTab({
    workspace,
    sites,
    busy,
    logs,
    hasRuntime,
    adding,
    onAddingChange,
    hostNote,
    onAction,
    onToggleLog,
    onRefresh,
}: {
    workspace: WorkspaceRow;
    sites: DevSiteInfo[] | null;
    busy: string | null;
    logs: { id: string; text: string } | null;
    hasRuntime: boolean;
    adding: boolean;
    onAddingChange: (v: boolean) => void;
    hostNote: { status: string; note: string } | null;
    onAction: (id: string | null, req: Record<string, unknown>) => Promise<unknown>;
    onToggleLog: (id: string) => void;
    onRefresh: () => void;
}) {
    return (
        <section className="set-section">
            <div className="set-section-head">
                <h2>Sites</h2>
                <span className="set-section-desc">
                    A repo, BUILT and then served the way it runs in production — FrankenPHP,
                    gunicorn, a compiled binary, nginx over a built front end — in this
                    workspace&apos;s container sandbox, reachable at a stable <code>.gen</code>{' '}
                    address from here and from a connected remote. Its database and cache are
                    reached inside the sandbox and are never exposed to the browser.
                </span>
                <span style={{ marginLeft: 'auto' }}>
                    <Action size="sm" variant="ghost" icon="refresh-cw" onClick={onRefresh}>
                        Refresh
                    </Action>
                </span>
            </div>

            {sites === null ? (
                <Text size="xs" className="text-zinc-500">
                    Reading this workspace&apos;s sites…
                </Text>
            ) : sites.length === 0 ? (
                <div className="set-note">
                    Nothing hosted here yet. Add a site below — Genie reads the repo, offers how
                    it should be built and served (a Dockerfile it ships, or the production
                    recipe for the stack it detects), builds it, and serves it.
                </div>
            ) : (
                <div className="site-list">
                    {sites.map((row) => (
                        <SiteCard
                            key={row.id}
                            row={row}
                            busy={busy === row.id}
                            hasRuntime={hasRuntime}
                            log={logs?.id === row.id ? logs.text : null}
                            onAction={(req) => void onAction(row.id, { ...req, id: row.id })}
                            onToggleLog={() => onToggleLog(row.id)}
                        />
                    ))}
                </div>
            )}

            <div className="set-actions">
                <Action
                    size="sm"
                    variant="ghost"
                    icon="plus"
                    onClick={() => onAddingChange(!adding)}
                >
                    {adding ? 'Cancel' : 'Add a site…'}
                </Action>
            </div>

            {/* A framework that checks the Host header answers a "Blocked
                request" page from a container that is up, bound and probed
                healthy — so nothing about the site's own status would ever say
                why. `solved` is Genie's doing; `documented` is the user's. */}
            {hostNote && (
                <Callout
                    color={hostNote.status === 'solved' ? 'emerald' : 'amber'}
                    icon={<Icon name={hostNote.status === 'solved' ? 'check' : 'info'} size="sm" />}
                >
                    {hostNote.note}
                </Callout>
            )}

            {adding && (
                <AddSiteForm
                    workspace={workspace}
                    onCancel={() => onAddingChange(false)}
                    onCreate={async (req) => {
                        await onAction(null, { action: 'create', ...req });
                        onAddingChange(false);
                    }}
                />
            )}
        </section>
    );
}

/** One hosted site: what it serves, whether it is answering, where to reach it. */
function SiteCard({
    row,
    busy,
    hasRuntime,
    log,
    onAction,
    onToggleLog,
}: {
    row: DevSiteInfo;
    busy: boolean;
    hasRuntime: boolean;
    log: string | null;
    onAction: (req: Record<string, unknown>) => void;
    onToggleLog: () => void;
}) {
    const tone = siteStatusTone(row);
    const reach = siteReach(row);
    return (
        <Card variant="outlined" padding="md" className="site-card">
            <div className="site-card-head">
                <span className={`site-dot site-${tone}`} aria-hidden="true" />
                <div className="site-card-name">
                    <Text size="sm" style={{ fontWeight: 600 }}>
                        {row.name}{' '}
                        <Badge size="sm" variant="soft" color="zinc">
                            {row.runMode}
                        </Badge>
                        {row.kind === 'tcp' && (
                            <>
                                {' '}
                                <Badge size="sm" variant="soft" color="amber">
                                    tcp
                                </Badge>
                            </>
                        )}
                    </Text>
                    <Text size="xs" className="text-zinc-500">
                        {row.repo ? `repos/${row.repo}` : 'the workspace root'}
                        {row.port ? ` · listens on :${row.port}` : ''}
                    </Text>
                </div>
            </div>

            <div className={`site-card-status site-${tone}`}>{siteStatusLabel(row)}</div>

            {/* BOTH reaches. The `.gen` one works from a connected remote too;
                the loopback one is what curl, a local browser or another program
                on this machine dials. Showing one is how people paste the wrong
                one at an agent. */}
            {(reach.browser || reach.local) && (
                <div className="site-card-fields">
                    {reach.browser && (
                        <label className="site-field">
                            <span>In the Genie Browser</span>
                            <Input value={reach.browser} readOnly disabled />
                        </label>
                    )}
                    {reach.local && (
                        <label className="site-field">
                            <span>On this machine</span>
                            <Input value={reach.local} readOnly disabled />
                        </label>
                    )}
                </div>
            )}

            {row.command && row.command.length > 0 && (
                <Text size="xs" className="text-zinc-500">
                    <Icon name="terminal" size="xs" /> <code>{row.command.join(' ')}</code>
                </Text>
            )}

            {log !== null && (
                <div className="svc-env">
                    <span className="svc-env-label">Container log</span>
                    <CodeView
                        value={log || 'Nothing logged yet.'}
                        readOnly
                        minHeight={0}
                        maxHeight={240}
                    />
                </div>
            )}

            <div className="set-actions">
                <Action
                    size="sm"
                    color="blue"
                    icon="external-link"
                    disabled={busy || !canOpenInBrowser(row)}
                    onClick={() => onAction({ action: 'open' })}
                >
                    Open in Genie Browser
                </Action>
                {row.state === 'running' ? (
                    <>
                        <Action
                            size="sm"
                            variant="ghost"
                            icon="rotate-cw"
                            disabled={busy}
                            onClick={() => onAction({ action: 'restart' })}
                        >
                            Restart
                        </Action>
                        <Action
                            size="sm"
                            variant="ghost"
                            icon="square"
                            disabled={busy}
                            onClick={() => onAction({ action: 'stop' })}
                        >
                            Stop
                        </Action>
                    </>
                ) : (
                    <Action
                        size="sm"
                        variant="ghost"
                        icon="play"
                        disabled={busy || !hasRuntime}
                        onClick={() => onAction({ action: 'start' })}
                    >
                        {row.state === 'failed' ? 'Retry' : 'Start'}
                    </Action>
                )}
                <Action size="sm" variant="ghost" icon="file-text" disabled={busy} onClick={onToggleLog}>
                    {log !== null ? 'Hide log' : 'Log'}
                </Action>
                <Action
                    size="sm"
                    variant="ghost"
                    icon="trash-2"
                    disabled={busy}
                    onClick={() => onAction({ action: 'remove' })}
                    title="Stops the container and forgets the definition. Your files are untouched."
                >
                    Remove
                </Action>
            </div>
        </Card>
    );
}

/**
 * Add a site — the LAYERED run-option picker, as a form.
 *
 * Detect first, then let the user take an offer. The offers are ranked by what
 * would actually start now, and each one that is a GUESS says what it guessed:
 * an option whose port was defaulted rather than read will publish 8080, get a
 * connection refused, and look like a working site.
 */
function AddSiteForm({
    workspace,
    onCreate,
    onCancel,
}: {
    workspace: WorkspaceRow;
    onCreate: (req: Record<string, unknown>) => Promise<void>;
    onCancel: () => void;
}) {
    const [name, setName] = useState('');
    const [repo, setRepo] = useState('');
    const [repos, setRepos] = useState<string[]>([]);
    const [options, setOptions] = useState<DevSiteRunOption[] | null>(null);
    const [chosen, setChosen] = useState<number>(0);
    const [port, setPort] = useState('');
    const [detecting, setDetecting] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        void api()
            .devServer.repos(workspace.id)
            .then(setRepos)
            .catch(() => setRepos([]));
    }, [workspace.id]);

    const detect = async () => {
        setDetecting(true);
        try {
            const res = await api().devServer.site(workspace.id, {
                action: 'detect',
                ...(repo ? { repo } : {}),
            });
            setOptions(res.options ?? []);
            setChosen(0);
            const first = res.options?.[0];
            if (first?.port) setPort(String(first.port));
        } finally {
            setDetecting(false);
        }
    };

    const option = options?.[chosen];

    return (
        <Card variant="outlined" padding="md" className="site-card">
            <div className="site-card-fields">
                <label className="site-field">
                    <span>Name</span>
                    <Input
                        value={name}
                        onValueChange={setName}
                        placeholder="web"
                        aria-label="Name for the new site"
                    />
                </label>
                <label className="site-field">
                    <span>Repo</span>
                    <Select
                        value={repo}
                        onValueChange={setRepo}
                        list={[
                            { value: '', label: 'The workspace root' },
                            ...repos.map((r) => ({ value: r, label: `repos/${r}` })),
                        ]}
                    />
                </label>
                <label className="site-field">
                    <span>Port inside the container</span>
                    <Input
                        value={port}
                        onValueChange={setPort}
                        placeholder="5173"
                        aria-label="The port the server listens on inside the container"
                    />
                </label>
            </div>

            <div className="set-actions">
                <Action
                    size="sm"
                    variant="ghost"
                    icon="search"
                    disabled={detecting}
                    onClick={() => void detect()}
                >
                    {detecting ? 'Reading the repo…' : 'See how this repo could run'}
                </Action>
            </div>

            {options !== null && (
                <div className="site-card-fields">
                    <label className="site-field site-field-wide">
                        <span>Run it as</span>
                        <Select
                            value={String(chosen)}
                            onValueChange={(v) => {
                                const i = Number(v);
                                setChosen(i);
                                const picked = options[i];
                                if (picked?.port) setPort(String(picked.port));
                            }}
                            list={options.map((o, i) => ({
                                value: String(i),
                                label: optionLabel(o),
                            }))}
                        />
                    </label>
                </div>
            )}

            {option && (
                <>
                    <Text size="xs" className="text-zinc-500">
                        {option.reason}
                    </Text>
                    {option.command && (
                        <Text size="xs" className="text-zinc-500">
                            <Icon name="terminal" size="xs" /> <code>{option.command.join(' ')}</code>
                        </Text>
                    )}
                    {optionCaveat(option) && (
                        <Callout color="amber" icon={<Icon name="alert-triangle" size="sm" />}>
                            Check this before starting: {optionCaveat(option)}.
                        </Callout>
                    )}
                </>
            )}

            <div className="set-actions">
                <Action
                    size="sm"
                    color="blue"
                    icon="check"
                    disabled={saving || !name.trim()}
                    onClick={async () => {
                        setSaving(true);
                        try {
                            await onCreate({
                                name: name.trim(),
                                ...(repo ? { repo } : {}),
                                ...(option?.runMode ? { runMode: option.runMode } : {}),
                                ...(option?.command ? { command: option.command } : {}),
                                ...(port ? { port: Number(port) } : {}),
                            });
                        } finally {
                            setSaving(false);
                        }
                    }}
                >
                    {saving ? 'Starting…' : 'Add & start'}
                </Action>
                <Action size="sm" variant="ghost" onClick={onCancel}>
                    Cancel
                </Action>
            </div>
        </Card>
    );
}

// --- services ---------------------------------------------------------------

function ServicesTab({
    services,
    catalog,
    busy,
    logs,
    connEnv,
    hasRuntime,
    onAction,
    onToggleLog,
}: {
    services: DevServiceInfo[] | null;
    catalog: DevServiceCatalogEntry[];
    busy: string | null;
    logs: { id: string; text: string } | null;
    connEnv: Record<string, string> | null;
    hasRuntime: boolean;
    onAction: (id: string | null, req: Record<string, unknown>) => Promise<unknown>;
    onToggleLog: (id: string) => void;
}) {
    const byEngine = new Map(catalog.map((c) => [c.engine, c]));
    const configured = new Set((services ?? []).map((s) => s.engine));
    const available = catalog.filter((c) => !configured.has(c.engine) && c.engine !== 'custom');

    return (
        <>
            <section className="set-section">
                <div className="set-section-head">
                    <h2>Services</h2>
                    <span className="set-section-desc">
                        What this workspace&apos;s apps connect TO. One engine per version is
                        SHARED across every workspace that wants it — this workspace gets its own
                        slice of it, not its own copy.
                    </span>
                </div>

                {services === null ? (
                    <Text size="xs" className="text-zinc-500">
                        Reading this workspace&apos;s services…
                    </Text>
                ) : services.length === 0 ? (
                    <div className="set-note">
                        No services here yet. Add one below and Genie starts (or adopts) the
                        shared engine, creates this workspace&apos;s database and role on it, and
                        injects the credentials into this workspace&apos;s sites.
                    </div>
                ) : (
                    <div className="site-list">
                        {services.map((row) => (
                            <ServiceCard
                                key={row.id}
                                row={row}
                                entry={byEngine.get(row.engine) ?? null}
                                busy={busy === row.id}
                                hasRuntime={hasRuntime}
                                log={logs?.id === row.id ? logs.text : null}
                                onAction={(req) => void onAction(row.id, { ...req, id: row.id })}
                                onToggleLog={() => onToggleLog(row.id)}
                            />
                        ))}
                    </div>
                )}

                {available.length > 0 && (
                    <div className="set-actions">
                        {available.map((entry) => (
                            <Action
                                key={entry.engine}
                                size="sm"
                                variant="ghost"
                                icon="plus"
                                disabled={busy !== null || !hasRuntime}
                                title={entry.summary}
                                onClick={() =>
                                    void onAction(null, { action: 'add', engine: entry.engine })
                                }
                            >
                                {entry.label}
                            </Action>
                        ))}
                    </div>
                )}
            </section>

            {connEnv && Object.keys(connEnv).length > 0 && (
                <section className="set-section">
                    <div className="set-section-head">
                        <h2>What your app is given</h2>
                    </div>
                    <div className="set-note">
                        These are injected into this workspace&apos;s site containers at start.
                        They address each engine by its CONTAINER NAME on the workspace network —
                        not the loopback port above, which only this machine can reach. A site&apos;s
                        own <code>env</code> always wins over these.
                    </div>
                    <div className="svc-env">
                        <CodeView
                            value={Object.entries(connEnv)
                                .map(([k, v]) => `${k}=${v}`)
                                .join('\n')}
                            readOnly
                            minHeight={0}
                            maxHeight={200}
                        />
                    </div>
                </section>
            )}
        </>
    );
}

/** One service: which engine, who else holds it, what isolation this workspace
 *  really has, and how to reach it from either side of the boundary. */
function ServiceCard({
    row,
    entry,
    busy,
    hasRuntime,
    log,
    onAction,
    onToggleLog,
}: {
    row: DevServiceInfo;
    entry: DevServiceCatalogEntry | null;
    busy: boolean;
    hasRuntime: boolean;
    log: string | null;
    onAction: (req: Record<string, unknown>) => void;
    onToggleLog: () => void;
}) {
    const tone = serviceStatusTone(row);
    const holders = holdersNote(row);
    const isolation = isolationNote(row.dedicated ? 'dedicated' : entry?.provision ?? '');

    return (
        <Card variant="outlined" padding="md" className="site-card">
            <div className="site-card-head">
                <span className={`site-dot site-${tone}`} aria-hidden="true" />
                <div className="site-card-name">
                    <Text size="sm" style={{ fontWeight: 600 }}>
                        {serviceTitle(row)}{' '}
                        <Badge size="sm" variant="soft" color={row.dedicated ? 'amber' : 'zinc'}>
                            {row.dedicated ? 'dedicated' : 'shared'}
                        </Badge>
                    </Text>
                    {entry && (
                        <Text size="xs" className="text-zinc-500">
                            {entry.summary}
                        </Text>
                    )}
                </div>
            </div>

            <div className={`site-card-status site-${tone}`}>{serviceStatusLabel(row)}</div>

            {holders && (
                <Text size="xs" className="text-zinc-500">
                    <Icon name="users" size="xs" /> {holders}
                </Text>
            )}
            <Text size="xs" className="text-zinc-500">
                <Icon name="shield" size="xs" /> {isolation}
            </Text>

            {/* BOTH sides of the boundary. `host:port` is how a container on the
                workspace network dials the engine; the local address is how psql
                or an agent on this machine does. A connection string built from
                the second and handed to a container fails every time. */}
            {row.endpoints && row.endpoints.length > 0 && (
                <div className="site-card-fields">
                    {row.endpoints.map((e) => (
                        <label className="site-field" key={e.name}>
                            <span>{e.name}</span>
                            <Input
                                value={`${e.host}:${e.port}${e.localAddress ? `  ·  ${e.localAddress}` : ''}`}
                                readOnly
                                disabled
                            />
                        </label>
                    ))}
                </div>
            )}

            {row.envKeys && row.envKeys.length > 0 && (
                <Text size="xs" className="text-zinc-500">
                    <Icon name="key" size="xs" /> Injects {row.envKeys.join(', ')}
                </Text>
            )}

            {log !== null && (
                <div className="svc-env">
                    <span className="svc-env-label">Engine log</span>
                    <CodeView
                        value={log || 'Nothing logged yet.'}
                        readOnly
                        minHeight={0}
                        maxHeight={240}
                    />
                </div>
            )}

            <div className="set-actions">
                {row.state === 'running' ? (
                    <Action
                        size="sm"
                        variant="ghost"
                        icon="square"
                        disabled={busy}
                        onClick={() => onAction({ action: 'stop' })}
                        title="Releases this workspace's hold. The engine stops only if nobody else is using it."
                    >
                        Release
                    </Action>
                ) : (
                    <Action
                        size="sm"
                        variant="ghost"
                        icon="play"
                        disabled={busy || !hasRuntime}
                        onClick={() => onAction({ action: 'start' })}
                    >
                        {row.state === 'failed' ? 'Retry' : 'Start'}
                    </Action>
                )}
                <Action
                    size="sm"
                    variant="ghost"
                    icon="plug"
                    disabled={busy}
                    onClick={() => onAction({ action: 'connection' })}
                >
                    Connection
                </Action>
                {entry?.shared && (
                    <Action
                        size="sm"
                        variant="ghost"
                        icon={row.dedicated ? 'users' : 'user'}
                        disabled={busy}
                        onClick={() => onAction({ action: 'dedicated', dedicated: !row.dedicated })}
                        title={
                            row.dedicated
                                ? 'Move back to the shared engine. Shared and dedicated engines have SEPARATE volumes, so this workspace gets a freshly provisioned, EMPTY database.'
                                : 'Run a container just for this workspace. Shared and dedicated engines have SEPARATE volumes, so this starts from an EMPTY database.'
                        }
                    >
                        {row.dedicated ? 'Use the shared engine' : 'Give it a dedicated one'}
                    </Action>
                )}
                <Action size="sm" variant="ghost" icon="file-text" disabled={busy} onClick={onToggleLog}>
                    {log !== null ? 'Hide log' : 'Log'}
                </Action>
                <Action
                    size="sm"
                    variant="ghost"
                    icon="trash-2"
                    disabled={busy}
                    onClick={() => onAction({ action: 'remove' })}
                    title="Releases this workspace's hold and forgets the definition. The engine's data is left alone."
                >
                    Remove
                </Action>
            </div>
        </Card>
    );
}
