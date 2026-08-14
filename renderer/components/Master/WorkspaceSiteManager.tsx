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
    Switch,
    Tabs,
    Text,
    Textarea,
} from '@particle-academy/react-fancy';
import {
    api,
    type DevRuntimeInfo,
    type DevServiceCatalogEntry,
    type DevServiceInfo,
    type DevSiteInfo,
    type DevSitePhase,
    type DevSiteRunOption,
    type WorkspaceRow,
} from '../../lib/genie';
import {
    buildHostServe,
    canOpenInBrowser,
    holdersNote,
    hostServePatch,
    isolationNote,
    optionCaveat,
    optionLabel,
    runtimeSummary,
    serveConfigIncomplete,
    serveModeOf,
    type ServeMode,
    serviceStatusLabel,
    serviceStatusTone,
    serviceTitle,
    serviceVersionChoice,
    siteIsStarting,
    sitePhaseBadge,
    siteReach,
    siteRunLine,
    siteStatusLabel,
    siteStatusTone,
} from '../../lib/dev-server';

/** The live start progress the card overlays onto its row (Gap 2): the transient
 *  phase plus the streaming build/pull log. Keyed by siteId in the panel. */
type SiteProgress = { phase: DevSitePhase; log?: string; error?: string };

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
     * Live START progress per site (Gap 2). Pushed from main as a site comes up
     * (`pulling → building → starting`), so the card shows a spinner + the
     * streaming build log the instant Start is clicked instead of a dead disabled
     * button. A `ready` tick clears the entry (the row then shows the settled,
     * serving state); a `failed` tick is kept so the reason stays IN the card.
     */
    const [progress, setProgress] = useState<Record<string, SiteProgress>>({});

    // The Site Manager drives whatever machine THIS window represents: in a remote
    // window `api().devServer` routes to the HOST over the bridge (the same
    // `runManageSite` / `runManageService` an agent reaches), so the panel manages
    // the HOST's sites + services and the runtime banner reflects the HOST's
    // container runtime — there is no local/remote fork here. A host that predates
    // the `/api/desktop/dev-server/*` endpoints simply reads back no runtime + no
    // sites (the catch arms below), the same graceful-empty a machine without Docker
    // shows, rather than a broken panel.
    const runtimeInfo = runtimeSummary(runtime);
    const hasRuntime = runtimeInfo.tone === 'running';

    const refresh = useCallback(async () => {
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
    }, [workspace.id]);

    useEffect(() => {
        void refresh();
        // PUSH, not a poll: a site can take an image pull or a Dockerfile build
        // to come up, so main tells us when anything moved.
        return api().on.devServerChanged(() => void refresh());
    }, [refresh]);

    // Live START progress (Gap 2), streamed as a site comes up. Distinct from
    // the coarse `devServerChanged` above: this carries the phase + build-log
    // tail so the card animates through the build without a round trip.
    useEffect(() => {
        return api().on.devSiteProgress((p) => {
            if (p.workspaceId !== workspace.id) return;
            setProgress((cur) => {
                if (p.phase === 'ready') {
                    // Settled: drop the transient entry and let the row (now
                    // refreshed via devServerChanged) show the serving state.
                    const { [p.siteId]: _done, ...rest } = cur;
                    return rest;
                }
                return {
                    ...cur,
                    [p.siteId]: {
                        phase: p.phase,
                        ...(p.log !== undefined ? { log: p.log } : {}),
                        ...(p.error !== undefined ? { error: p.error } : {}),
                    },
                };
            });
        });
    }, [workspace.id]);

    /** Every site action goes through here, so the panel always reflects what
     *  the RUNTIME did rather than what we asked for. */
    const site = async (id: string | null, req: Record<string, unknown>) => {
        setBusy(id);
        setError(null);
        // The instant Start/Retry is clicked, show a spinner (Gap 2): the push
        // stream takes over within a tick, but the button must never read as a
        // dead, silent disable while the build spins up.
        if (id && (req.action === 'start' || req.action === 'restart')) {
            setProgress((cur) => ({ ...cur, [id]: { phase: 'pulling' } }));
        }
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
            <Modal.Header>
                <Heading as="h2" size="sm">
                    Hosting — {workspace.project_name}
                </Heading>
            </Modal.Header>
            <div className="ws-settings site-manager">
                <div className="ws-settings-head">
                    <Text size="xs" className="text-zinc-500">
                        Each site is your repo&apos;s dev server, running on the host at{' '}
                        <code>&lt;name&gt;.gen</code>. Docker runs the services behind it (Postgres,
                        Redis, …).
                    </Text>
                </div>

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
                                progress={progress}
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
                <span className="site-dot site-running" aria-hidden="true" /> Sites run on the
                host; {summary.label} runs the services behind them.
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
    progress,
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
    progress: Record<string, SiteProgress>;
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
                    Your repo&apos;s dev server, on the host at a stable <code>.gen</code> address.
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
                    Nothing hosted here yet. Add a site — Genie runs the repo&apos;s dev server on
                    the host at <code>.gen</code>.
                </div>
            ) : (
                <div className="site-list">
                    {sites.map((row) => (
                        <SiteCard
                            key={row.id}
                            workspace={workspace}
                            row={row}
                            busy={busy === row.id}
                            progress={progress[row.id] ?? null}
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
    workspace,
    row,
    busy,
    progress,
    hasRuntime,
    log,
    onAction,
    onToggleLog,
}: {
    workspace: WorkspaceRow;
    row: DevSiteInfo;
    busy: boolean;
    progress: SiteProgress | null;
    hasRuntime: boolean;
    log: string | null;
    onAction: (req: Record<string, unknown>) => void;
    onToggleLog: () => void;
}) {
    const [editing, setEditing] = useState(false);

    // Overlay the live start progress (Gap 2) onto the row — but never over a
    // site the list already reports RUNNING, so a stale tick can't hide a serving
    // site. This is what makes the card animate through pulling → building →
    // starting and show a failed build's reason in place.
    const view: DevSiteInfo =
        progress && row.state !== 'running'
            ? {
                  ...row,
                  phase: progress.phase,
                  ...(progress.log !== undefined ? { buildLog: progress.log } : {}),
                  ...(progress.error !== undefined ? { error: progress.error } : {}),
              }
            : row;

    const tone = siteStatusTone(view);
    const reach = siteReach(view);
    const starting = siteIsStarting(view);
    // What the site actually RUNS. A Genie-SERVED site (hostServe) has no stored
    // argv that means anything — Genie generates its Caddy at start — so this
    // describes the serving instead of printing a stale command (genie#206).
    const runLine = siteRunLine(view);
    // The streaming build/pull log while a site comes up, and the last build's
    // log on a failure — the single most common reason a site does not start.
    const buildLog = (starting || view.state === 'failed') && view.buildLog ? view.buildLog : null;

    return (
        <Card variant="outlined" padding="md" className="site-card">
            <div className="site-card-head">
                <span className={`site-dot site-${tone}`} aria-hidden="true" />
                <div className="site-card-name">
                    <Text size="sm" style={{ fontWeight: 600 }}>
                        {view.name}{' '}
                        <Badge size="sm" variant="soft" color="zinc">
                            {view.runMode}
                        </Badge>
                        {view.kind === 'tcp' && (
                            <>
                                {' '}
                                <Badge size="sm" variant="soft" color="amber">
                                    tcp
                                </Badge>
                            </>
                        )}
                        {starting && view.phase && (
                            <>
                                {' '}
                                <Badge size="sm" variant="soft" color="amber">
                                    {sitePhaseBadge(view.phase)}
                                </Badge>
                            </>
                        )}
                    </Text>
                    <Text size="xs" className="text-zinc-500">
                        {view.repo ? `repos/${view.repo}` : 'the workspace root'}
                        {view.port ? ` · listens on :${view.port}` : ''}
                    </Text>
                </div>
            </div>

            <div className={`site-card-status site-${tone}`}>{siteStatusLabel(view)}</div>

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

            {runLine && (
                <Text size="xs" className="text-zinc-500">
                    <Icon name="terminal" size="xs" /> <code>{runLine}</code>
                </Text>
            )}

            {/* The build/pull log, streaming live while the site comes up (Gap 2)
                and shown on a failed build too — so a start is never a silent
                disabled button. Separate from the toggled container log below. */}
            {buildLog !== null && (
                <div className="svc-env site-build-log">
                    <span className="svc-env-label">
                        {starting ? <span className="site-dot site-starting" aria-hidden="true" /> : null}
                        {view.state === 'failed' ? 'Build log' : 'Building…'}
                    </span>
                    <CodeView value={buildLog} readOnly minHeight={0} maxHeight={240} />
                </div>
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
                    disabled={busy || !canOpenInBrowser(view)}
                    onClick={() => onAction({ action: 'open' })}
                >
                    Open in Genie Browser
                </Action>
                {view.state === 'running' ? (
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
                        {starting
                            ? `${view.phase ? sitePhaseBadge(view.phase) : 'Starting'}…`
                            : view.state === 'failed'
                              ? 'Retry'
                              : 'Start'}
                    </Action>
                )}
                <Action
                    size="sm"
                    variant="ghost"
                    icon="pencil"
                    disabled={busy}
                    onClick={() => setEditing(true)}
                    title="Change this site's name, URL, port, environment, build or serve, and more."
                >
                    Edit
                </Action>
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

            {editing && (
                <EditSiteForm
                    workspace={workspace}
                    row={row}
                    onCancel={() => setEditing(false)}
                    onSave={async (patch) => {
                        await onAction({ action: 'update', ...patch });
                        setEditing(false);
                    }}
                />
            )}
        </Card>
    );
}

/**
 * Edit a site AFTER create (Gap 1) — the fields a running site is defined by, in
 * a modal of Fancy form components. Only the fields the user actually changed are
 * sent, so a `manageSite update` leaves everything else exactly as stored and a
 * RUNNING site is rebuilt/restarted only when a container fact moved.
 *
 * `serve` and each `build` step are argv, shown space-separated; a first pass
 * splits them on whitespace (an argument with a space is best set from an agent
 * via the MCP tool, which takes real argv). `env` is KEY=value lines.
 */
function EditSiteForm({
    workspace,
    row,
    onSave,
    onCancel,
}: {
    workspace: WorkspaceRow;
    row: DevSiteInfo;
    onSave: (patch: Record<string, unknown>) => Promise<void>;
    onCancel: () => void;
}) {
    const [name, setName] = useState(row.name);
    const [genName, setGenName] = useState(row.genName);
    const [repo, setRepo] = useState(row.repo ?? '');
    const [repos, setRepos] = useState<string[]>([]);
    const [port, setPort] = useState(row.port ? String(row.port) : '');
    const [runMode, setRunMode] = useState(row.runMode);
    const [image, setImage] = useState(row.image ?? '');
    const [upstreamHost, setUpstreamHost] = useState(row.upstreamHost ?? '');
    const [browserExposed, setBrowserExposed] = useState(row.browserExposed ?? false);
    // The external-browser toggle only means anything for a host-native site (one
    // Genie fronts on the host Caddy, not the sandbox one) — don't show a control
    // that would silently do nothing for a container site.
    const isHostNative = runMode === 'host' || Boolean(row.hostPort);
    // Serve mode (genie #167/#171), prefilled from the stored config: proxy runs
    // the repo's dev server, static/php hand serving to Genie.
    const [serveMode, setServeMode] = useState<ServeMode>(serveModeOf(row));
    const [serveRoot, setServeRoot] = useState(row.hostServe?.root ?? '');
    const [serveSpa, setServeSpa] = useState(
        row.hostServe?.mode === 'static' ? Boolean(row.hostServe.spa) : true,
    );
    // The USER-CONTROLLED startup argv — the canonical way to start a site.
    const [command, setCommand] = useState((row.command ?? []).join(' '));
    const [env, setEnv] = useState(
        Object.entries(row.env ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join('\n'),
    );
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void api()
            .devServer.repos(workspace.id)
            .then(setRepos)
            .catch(() => setRepos([]));
    }, [workspace.id]);

    // Only the changed fields ride the update — an unchanged value is a no-op and
    // never triggers a restart (main compares before/after).
    const buildPatch = (): Record<string, unknown> => {
        const patch: Record<string, unknown> = {};
        if (name.trim() && name.trim() !== row.name) patch.name = name.trim();
        if (genName.trim() && genName.trim() !== row.genName) patch.genName = genName.trim();
        if (repo !== (row.repo ?? '')) patch.repo = repo;
        if (runMode !== row.runMode) patch.runMode = runMode;
        if (image.trim() !== (row.image ?? '')) patch.image = image.trim();
        if (upstreamHost.trim() !== (row.upstreamHost ?? '')) patch.upstreamHost = upstreamHost.trim();
        if (browserExposed !== (row.browserExposed ?? false)) patch.browserExposed = browserExposed;

        // Serve mode: only for a host-native site (Genie can't serve a container's
        // folder). `undefined` ⇒ unchanged (omit); a config sets it; `null` clears it
        // back to the repo's own dev server. main sets runMode:'host' on a set.
        if (isHostNative) {
            const servePatch = hostServePatch(
                row.hostServe,
                buildHostServe(serveMode, serveRoot, serveSpa),
            );
            if (servePatch !== undefined) patch.hostServe = servePatch;
        }

        // A host-native site's port is HOST-owned (allocated at start), so it is not
        // an editable field; only a container/recipe site carries a user port.
        const portNum = port.trim() ? Number(port.trim()) : undefined;
        if (!isHostNative && portNum && portNum !== row.port) patch.port = portNum;

        const commandArgv = command.trim() ? command.trim().split(/\s+/) : [];
        if (commandArgv.join(' ') !== (row.command ?? []).join(' ')) patch.command = commandArgv;

        const envObj: Record<string, string> = {};
        for (const line of env.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq <= 0) continue;
            envObj[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
        }
        const envSig = Object.entries(envObj)
            .map(([k, v]) => `${k}=${v}`)
            .sort()
            .join('\n');
        const rowEnvSig = Object.entries(row.env ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .sort()
            .join('\n');
        if (envSig !== rowEnvSig) patch.env = envObj;

        return patch;
    };

    const RUN_MODES = [
        { value: 'host', label: 'Dev server on the host' },
        { value: 'recipe', label: 'Production build (container)' },
        { value: 'dockerfile', label: "The repo's Dockerfile" },
    ];

    // A static/php serve mode needs a directory, or buildHostServe yields nothing
    // and the change is silently dropped on save — the exact bug where switching a
    // site to "run PHP app" appeared to do nothing (genie #198). The Add form
    // already guarded this; the Edit form did not.
    const serveIncomplete = isHostNative && serveConfigIncomplete(serveMode, serveRoot, serveSpa);

    return (
        <Modal open onClose={onCancel} size="lg">
            <Modal.Header>
                <Heading as="h3" size="xs">
                    Edit {row.name}
                </Heading>
            </Modal.Header>
            <div className="ws-settings site-manager">
                {error && <div className="set-note bad">{error}</div>}
                <div className="site-card-fields">
                    <label className="site-field">
                        <span>Name</span>
                        <Input value={name} onValueChange={setName} placeholder="web" />
                    </label>
                    <label className="site-field">
                        <span>Public address (.gen)</span>
                        <Input value={genName} onValueChange={setGenName} placeholder="web.acme.gen" />
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
                        <span>How it runs</span>
                        <Select
                            value={runMode}
                            onValueChange={setRunMode}
                            list={RUN_MODES}
                        />
                    </label>
                    {/* Serve mode is a host-native concept — Genie serves the folder
                        itself. A container site is served by its own image, not Caddy. */}
                    {isHostNative && (
                        <ServeModeFields
                            mode={serveMode}
                            root={serveRoot}
                            spa={serveSpa}
                            onMode={setServeMode}
                            onRoot={setServeRoot}
                            onSpa={setServeSpa}
                        />
                    )}
                    {/* A host-native site's port is host-owned (allocated at start),
                        and it needs no container image — those fields are only for a
                        container/production-build site. */}
                    {!isHostNative && (
                        <>
                            <label className="site-field">
                                <span>Port the server listens on</span>
                                <Input value={port} onValueChange={setPort} placeholder="8000" />
                            </label>
                            <label className="site-field">
                                <span>Server image (optional)</span>
                                <Input value={image} onValueChange={setImage} placeholder="nginx:1.27" />
                            </label>
                        </>
                    )}
                    <label className="site-field">
                        <span>Upstream Host (optional)</span>
                        <Input
                            value={upstreamHost}
                            onValueChange={setUpstreamHost}
                            placeholder="localhost"
                        />
                    </label>
                    {isHostNative && (
                        <label className="site-field site-field-wide">
                            <span>Open in a real browser (Chrome/Edge)</span>
                            <Switch
                                checked={browserExposed}
                                onCheckedChange={(on: boolean) => setBrowserExposed(on)}
                            />
                            <small className="site-field-hint">
                                Off by default — the in-app Testing Browser already serves this site with
                                no setup. Turn on to reach <code>{genName || row.genName}</code> from a real
                                browser: the first time, Genie installs its local certificate, adds a hosts
                                entry, and runs a small local proxy — a one-time admin prompt.
                            </small>
                        </label>
                    )}
                    {/* A Genie-served (static/php) site has no startup command — Genie
                        runs its own web server. Only a proxied dev server takes argv. */}
                    {serveMode === 'proxy' && (
                        <label className="site-field site-field-wide">
                            <span>Startup command</span>
                            <Input
                                value={command}
                                onValueChange={setCommand}
                                placeholder="npm run dev"
                            />
                            <small className="site-field-hint">
                                The exact argv Genie runs on the host against your live source — no
                                forced dev server, no build. Genie assigns the port and fronts it at
                                your <code>.gen</code> address over https. Leave blank to use the
                                repo&apos;s detected dev server.
                            </small>
                        </label>
                    )}
                    <label className="site-field site-field-wide">
                        <span>Environment — KEY=value, one per line</span>
                        <Textarea
                            value={env}
                            onValueChange={setEnv}
                            rows={3}
                            spellCheck={false}
                            placeholder={'APP_ENV=production\nLOG_LEVEL=info'}
                        />
                    </label>
                </div>
                <Text size="xs" className="text-zinc-500">
                    A running site is restarted only when a change needs it — its command, env, or
                    address. Cosmetic edits leave it serving.
                </Text>
                {serveIncomplete && (
                    <div className="set-note bad">
                        Enter the directory Genie should serve (e.g. <code>public</code> for a PHP app)
                        to switch to this serve mode.
                    </div>
                )}
                <div className="set-actions">
                    <Action
                        size="sm"
                        color="blue"
                        icon="check"
                        disabled={saving || !name.trim() || !genName.trim() || serveIncomplete}
                        onClick={async () => {
                            const patch = buildPatch();
                            if (Object.keys(patch).length === 0) {
                                onCancel();
                                return;
                            }
                            setSaving(true);
                            setError(null);
                            try {
                                await onSave(patch);
                            } catch (e) {
                                setError(e instanceof Error ? e.message : String(e));
                            } finally {
                                setSaving(false);
                            }
                        }}
                    >
                        {saving ? 'Applying…' : 'Save changes'}
                    </Action>
                    <Action size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
                        Cancel
                    </Action>
                </div>
            </div>
        </Modal>
    );
}

/**
 * The serve modes, as the picker offers them (genie #167/#171).
 *
 * GENIE-SERVES FIRST (owner, 2026-08-14). Letting Genie serve the app is the
 * preferred shape — you point a site at a repo and a root, and Genie owns the
 * web server, the port and the `.gen` address. Running the repo's own dev server
 * is the FALLBACK, for a stack Genie cannot serve yet or when someone wants HMR
 * against live source. Listing it first (and calling it "recommended" nowhere)
 * is why both agents and humans kept reaching for it by default.
 */
const SERVE_MODES: { value: ServeMode; label: string }[] = [
    { value: 'php', label: 'Genie serves a PHP app (point at public/) — recommended' },
    { value: 'static', label: 'Genie serves a built folder (static / SPA) — recommended' },
    { value: 'proxy', label: "Run the repo's own dev server (Genie proxies it)" },
];

/**
 * The serve-mode picker's fields, shared by the Add and Edit forms so a human
 * declares a MODE exactly as an agent does via `hostServe` — and Genie writes the
 * web-server config, instead of anyone hand-rolling an nginx/Caddy block. `proxy`
 * (the default) runs the repo's own dev server; `static`/`php` hand serving to
 * Genie's bundled Caddy against a repo-relative `root`.
 */
function ServeModeFields({
    mode,
    root,
    spa,
    onMode,
    onRoot,
    onSpa,
}: {
    mode: ServeMode;
    root: string;
    spa: boolean;
    onMode: (mode: ServeMode) => void;
    onRoot: (root: string) => void;
    onSpa: (spa: boolean) => void;
}) {
    return (
        <>
            <label className="site-field">
                <span>How Genie serves it</span>
                <Select
                    value={mode}
                    onValueChange={(v) => onMode(v as ServeMode)}
                    list={SERVE_MODES}
                    aria-label="How Genie serves this site"
                />
            </label>
            {mode !== 'proxy' && (
                <label className="site-field">
                    <span>Directory to serve</span>
                    <Input
                        value={root}
                        onValueChange={onRoot}
                        placeholder={mode === 'php' ? 'public' : 'dist'}
                        aria-label="Directory Genie serves"
                    />
                    <small className="site-field-hint">
                        {mode === 'php'
                            ? "Repo-relative app root — Genie serves its public/ over a FastCGI PHP worker (the nginx/Valet model). No command, no hand-written web-server config."
                            : 'Repo-relative built folder — Genie serves it with its own file server. No dev command, no hand-written web-server config.'}
                    </small>
                </label>
            )}
            {mode === 'static' && (
                <label className="site-field site-field-wide">
                    <span>Single-page app fallback</span>
                    <Switch checked={spa} onCheckedChange={onSpa} />
                    <small className="site-field-hint">
                        On for client-routed apps (React/Vue routers): unmatched paths fall back to{' '}
                        <code>index.html</code> so deep links and refresh resolve. Off for a plain
                        static folder.
                    </small>
                </label>
            )}
        </>
    );
}

/**
 * Add a site — the LAYERED run-option picker, as a form.
 *
 * Detect first, then let the user take an offer. The offers are ranked by what
 * would actually start now, and each one that is a GUESS says what it guessed:
 * an option whose port was defaulted rather than read will publish 8080, get a
 * connection refused, and look like a working site.
 *
 * The serve-mode picker sits above the recipe path: `static`/`php` hand serving
 * to Genie (no dev command, no port), so when either is chosen the recipe/port
 * controls are hidden — there is nothing to detect.
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
    // Serve mode (genie #167/#171): proxy runs the repo's dev server, static/php
    // hand serving to Genie. SPA defaults ON — a built folder is nearly always a
    // client-routed bundle. `serveMode !== 'proxy'` bypasses the recipe/port path.
    const [serveMode, setServeMode] = useState<ServeMode>('proxy');
    const [serveRoot, setServeRoot] = useState('');
    const [serveSpa, setServeSpa] = useState(true);
    const hostServe = buildHostServe(serveMode, serveRoot, serveSpa);
    // A chosen static/php mode with no directory yet is not startable — Genie has
    // nothing to serve. Guard submit rather than ship an empty root (the same
    // predicate the Edit form uses — genie #198).
    const serveIncomplete = serveConfigIncomplete(serveMode, serveRoot, serveSpa);

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
                <ServeModeFields
                    mode={serveMode}
                    root={serveRoot}
                    spa={serveSpa}
                    onMode={setServeMode}
                    onRoot={setServeRoot}
                    onSpa={setServeSpa}
                />
                {/* proxy only: Genie owns the port for a static/php site it serves. */}
                {serveMode === 'proxy' && (
                    <label className="site-field">
                        <span>Port (optional)</span>
                        <Input
                            value={port}
                            onValueChange={setPort}
                            placeholder="5173"
                            aria-label="The port the dev server listens on"
                        />
                    </label>
                )}
            </div>

            {/* The recipe/run-picker only applies to a proxied dev server — a
                static/php site has nothing to detect (Genie serves the folder). */}
            {serveMode === 'proxy' && (
                <>
                    <div className="set-actions">
                        <Action
                            size="sm"
                            variant="ghost"
                            icon="search"
                            disabled={detecting}
                            onClick={() => void detect()}
                        >
                            {detecting ? 'Reading the repo…' : 'Advanced — pick how it runs'}
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
                                    <Icon name="terminal" size="xs" />{' '}
                                    <code>{option.command.join(' ')}</code>
                                </Text>
                            )}
                            {optionCaveat(option) && (
                                <Callout color="amber" icon={<Icon name="alert-triangle" size="sm" />}>
                                    Check this before starting: {optionCaveat(option)}.
                                </Callout>
                            )}
                        </>
                    )}
                </>
            )}

            <div className="set-actions">
                <Action
                    size="sm"
                    color="blue"
                    icon="check"
                    disabled={saving || !name.trim() || serveIncomplete}
                    onClick={async () => {
                        setSaving(true);
                        try {
                            await onCreate({
                                name: name.trim(),
                                ...(repo ? { repo } : {}),
                                // static/php: Genie serves it — send ONLY the mode.
                                // No recipe runMode/command/port (create sets host).
                                ...(hostServe
                                    ? { hostServe }
                                    : {
                                          ...(option?.runMode ? { runMode: option.runMode } : {}),
                                          ...(option?.command ? { command: option.command } : {}),
                                          ...(port ? { port: Number(port) } : {}),
                                      }),
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
                                allServices={services}
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
                        These are injected into this workspace&apos;s site at start, so it reaches the
                        managed engines with no <code>.env</code> edit. A host-native site reaches
                        them on <code>127.0.0.1:&lt;port&gt;</code>; a container site addresses each
                        engine by its CONTAINER NAME on the workspace network. A site&apos;s own{' '}
                        <code>env</code> always wins over these.
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
    allServices,
    entry,
    busy,
    hasRuntime,
    log,
    onAction,
    onToggleLog,
}: {
    row: DevServiceInfo;
    /** Every service this workspace holds — needed to know whether ANOTHER major
     *  of this engine is present, which is the only time versions are a choice. */
    allServices: DevServiceInfo[];
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
    // Only speaks up when this workspace holds two majors of the same engine.
    const choice = serviceVersionChoice(row, allServices);

    return (
        <Card variant="outlined" padding="md" className="site-card">
            <div className="site-card-head">
                <span className={`site-dot site-${tone}`} aria-hidden="true" />
                <div className="site-card-name">
                    <Text size="sm" style={{ fontWeight: 600 }}>
                        {serviceTitle(row)}{' '}
                        <Badge size="sm" variant="soft" color={row.dedicated ? 'amber' : 'zinc'}>
                            {row.dedicated ? 'dedicated' : 'shared'}
                        </Badge>{' '}
                        {/* Two majors of one engine are two DIFFERENT databases;
                            this says which one the apps actually reach. */}
                        {choice.contested && choice.isActive && (
                            <Badge size="sm" variant="soft" color="emerald">
                                in use
                            </Badge>
                        )}
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
                {/* Only when the workspace holds TWO majors of this engine: then
                    DATABASE_URL can point at just one of them, and which one has
                    to be visible AND changeable. Absent for the ordinary
                    one-version workspace, which has no choice to make. */}
                {choice.contested && !choice.isActive && (
                    <Action
                        size="sm"
                        variant="ghost"
                        icon="check"
                        disabled={busy}
                        onClick={() => onAction({ action: 'active' })}
                        title={
                            `Point this workspace's apps at ${row.engine} ${row.version}. Each ` +
                            'version keeps its OWN data, so the one you switch to starts EMPTY — ' +
                            'nothing is copied across, and nothing in the other one is deleted.'
                        }
                    >
                        Use this version
                    </Action>
                )}
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
