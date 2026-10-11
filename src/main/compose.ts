import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readFile as readFileP, writeFile as writeFileP } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { deckItemsFrom } from '../core/deck-sources.js';
import type { DeckItem, SignalState } from '../core/deck.js';
import type { GenRoute } from '../core/gen-router.js';
import { frontDoorCaddyfile, hostsFilePath, trustPlan } from '../core/front-door-caddy.js';
import { hostsFileBlock } from '../core/gen-router.js';
import { HUMAN, type Resolution } from '../core/inbox.js';
import { ReminderBook } from '../core/inbox-reminders.js';
import { configSync, githubAppStatus, tynnGate, type AnnotatedRow, type GithubAppStatus, type SyncResult } from '../core/integrations.js';
import { configSyncTargets } from './config-sync-targets.js';
import { PluginHost } from './plugin-host.js';
import { PUBLISHER_KEYS } from '../core/plugin-keys.js';
import { Baton, PairingPins, ShareLinks } from '../core/remote.js';
import type { ServerTransport } from '../core/remote-protocol.js';
import { ApprovalQueue } from './approval-queue.js';
import { AttentionStore } from './attention-store.js';
import { realHostsIo, runElevated as runElevatedViaOs, type Step } from './elevate.js';
import { FeedbackStore } from './feedback-store.js';
import { FlowScheduler } from './flow-scheduler.js';
import { FlowStore } from './flow-store.js';
import { GenRouterServer } from './gen-router-server.js';
import { syncHostsFile, type HostsIo, type HostsSyncResult } from './hosts-file.js';
import { InboxStore } from './inbox-store.js';
import { KnowledgeStore } from './knowledge-store.js';
import { runtimeDir } from './paths.js';
import { ProcessSupervisor } from './process-supervisor.js';
import { DeviceStore } from './remote-devices.js';
import { RemoteHost, type HostApi } from './remote-host.js';
import { ServiceDriver, type DockerRunner } from './service-driver.js';
import { ServiceRegistry } from './service-registry.js';
import { SettingsStore } from './settings-store.js';
import { SiteManager } from './site-manager.js';
import type { PtyPort } from './terminal-host.js';
import { execFileRunner } from './toolchain-runner.js';

/**
 * THE COMPOSITION ROOT. Every store, the scheduler, the supervisor, the site manager and the front
 * door, wired once at boot and torn down once at quit. `main.ts` calls this and hands the result to
 * the IPC layer; nothing else constructs these.
 *
 * Boot order matters in two places: the settings carry-over runs before anything reads a setting,
 * and the front door starts after the site manager exists so its route function is live. Shutdown
 * is the reverse and idempotent: stop every supervised process (a pty we own is a pty we close),
 * close the front door's connections, wait for an in-flight flow run, close the knowledge database.
 */

export interface ComposeInput {
    readonly userData: string;
    readonly pty: PtyPort;
    /** Reads v1's settings table, or `null` when there is no v1 database. Called once, on first run only. */
    readonly v1Settings: () => Readonly<Record<string, string>> | null;
    readonly caddyBin: string | null;
    /** 0 picks a free loopback port. */
    readonly frontDoorPort?: number;
    readonly allocatePort?: () => number;
    readonly now?: () => number;
    /** Runs `docker <args>`; execFile in production. A missing Docker answers a non-zero exit, never a throw. */
    readonly docker?: DockerRunner;
    /** The OS hosts file; the real one by default. */
    readonly hostsIo?: HostsIo;
    /** Runs one step through the OS's elevation prompt; rejects when declined. The real prompt by default. */
    readonly runElevated?: (step: Step) => Promise<void>;
    /** This machine's name as remote devices see it; the OS hostname by default. */
    readonly hostName?: string;
    /** Where remote connections come from (fancy-ws on a socket); none by default — nothing listens. */
    readonly remoteTransport?: ServerTransport;
    /** What a remote connection may perform here; main.ts wires the real one. Refuses everything by default. */
    readonly remoteApi?: HostApi;
    /** Genie's own MCP endpoint for agents, once the server listens; `null` until then (config sync refuses). */
    readonly mcpEndpoint?: () => { url: string; token: string } | null;
}

/** The external front door, beyond "Caddy runs": the hosts block, and whether the local root is trusted. */
export type FrontDoorStatus =
    | { running: true; caddyfile: string; hostsPath: string; hosts: HostsSyncResult | null; trusted: boolean }
    | { running: false; reason: string };

export interface ComposedServices {
    readonly inbox: InboxStore;
    readonly attention: AttentionStore;
    readonly knowledge: KnowledgeStore;
    readonly flows: FlowStore;
    readonly flowScheduler: FlowScheduler;
    readonly settings: SettingsStore;
    readonly supervisor: ProcessSupervisor;
    readonly sites: SiteManager;
    /** Service engines per workspace (and the shared ones), on the Docker driver. */
    readonly engines: ServiceRegistry;
    readonly frontDoor: GenRouterServer;
    /** The gate behind approval-gated tools; its pending requests are Deck items. */
    readonly approvals: ApprovalQueue;
    /** Remote access (§6.8): paired devices, share links, the baton, the lock, the connections. */
    readonly remote: RemoteHost;
    /** Feedback about Genie itself (§6.3 submitFeedback), kept here until Tynn is connected. */
    readonly feedback: FeedbackStore;
    /** The Deck's signal strip, MEASURED from the stores (§4.5). */
    signals(context: { osAgentWorking: boolean }): SignalState;
    /** §6.4: the reminders due now for registered agents with unread mail that are idle. Decides; never sends. */
    inboxReminders(input: { now: number; idle: (agentId: string) => boolean }): Array<{ agentId: string; text: string }>;
    /** §6.9: Tynn (optional identity), the GitHub App's two steps, Tynn-gated rows annotated. */
    integrations(): { tynnSignedIn: boolean; github: GithubAppStatus; gated: AnnotatedRow[] };
    /** Config sync (§6.9): Genie's MCP endpoint into a workspace's four targets, each reported on its own. */
    syncConfig(workspacePath: string): Promise<SyncResult[]>;
    /** §6.7: the plugin host over `<userData>/plugins`; re-read when developer mode changes. */
    readonly plugins: PluginHost;
    readonly pluginsDir: string;
    /** Re-read the plugins folder (after developer mode flips, or a plugin was dropped in). */
    pluginsRefresh(): Promise<void>;
    readonly frontDoorPort: number;
    /** Genie's own Caddy on 443 for EXTERNAL browsers (https://<name>.gen), or why it is off. */
    readonly externalFrontDoor: FrontDoorStatus;
    /** Fires when the front door state changes (a hosts sync landed, the root got trusted). */
    onFrontDoorChange(listener: () => void): () => void;
    /** Sync the hosts block now — the person's "try again" after a declined prompt. */
    syncHosts(): Promise<HostsSyncResult>;
    /** `caddy trust` through the OS prompt, once; remembered by a marker. */
    trustCertificate(): Promise<{ ok: true } | { ok: false; reason: string }>;
    /** `<name>.gen → 127.0.0.1:<port>` for every site that is up — what the front door reads. */
    routes(): GenRoute[];
    /** The Deck's items from the stores, now. */
    deckItems(): DeckItem[];
    /** Who an agent id is, for the Deck and the inbox listings. */
    registerAgentName(agentId: string, who: { name: string; workspaceId: string }): void;
    /** An inbox address (`{provider}:{name}` or `{workspace}:{provider}:{name}`) for an agent id. */
    registerAgentAddress(address: string, agentId: string): void;
    /** Every registered address with the agent's name — the human's peer list. */
    agentAddresses(): Array<{ address: string; agentId: string; name: string }>;
    /** Resolve an address the way the inbox does: one / ambiguous (both forms named) / none / human. */
    resolveAddress(text: string): Resolution;
    shutdown(): Promise<void>;
}

/**
 * The EXTERNAL front door: Genie's bundled Caddy serving https://<name>.gen on 443 with its internal
 * CA, as ONE supervised process started with --watch, so the routes change by rewriting the Caddyfile
 * and never by spawning a second Caddy. Without a bundled binary nothing starts, and the reason is
 * recorded for the Hosting surface — the in-app browser does not need this path.
 */
interface FrontDoorController {
    status(): FrontDoorStatus;
    onChange(listener: () => void): () => void;
    syncHosts(): Promise<HostsSyncResult>;
    trust(): Promise<{ ok: true } | { ok: false; reason: string }>;
}

const NO_CADDY = 'this install has no bundled Caddy; https://<name>.gen in external browsers is off, the in-app browser still works';

function startExternalFrontDoor(input: {
    caddyBin: string | null;
    caddyDir: string;
    sites: SiteManager;
    supervisor: ProcessSupervisor;
    hostsIo: HostsIo;
    hostsPath: string;
    runElevated: (step: Step) => Promise<void>;
}): FrontDoorController {
    const listeners = new Set<() => void>();
    const onChange = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
    const notify = () => { for (const l of listeners) l(); };
    const { caddyBin, caddyDir, sites, supervisor } = input;
    if (caddyBin === null) {
        return {
            status: () => ({ running: false, reason: NO_CADDY }),
            onChange,
            syncHosts: async () => { throw new Error(NO_CADDY); },
            trust: async () => ({ ok: false, reason: NO_CADDY }),
        };
    }
    const caddyfile = join(caddyDir, 'Caddyfile');
    const marker = join(caddyDir, 'trusted');
    let hosts: HostsSyncResult | null = null;
    let trusted = existsSync(marker);
    const render = () => {
        mkdirSync(caddyDir, { recursive: true });
        writeFileSync(caddyfile, frontDoorCaddyfile(sites.routes()), 'utf8');
    };
    // The hosts block follows the routes; the OS prompt appears only when a plain write is refused
    // AND the block actually changed. A declined prompt is a recorded fact with the block to paste.
    const syncHosts = async (): Promise<HostsSyncResult> => {
        const routes = sites.routes();
        try {
            hosts = await syncHostsFile(routes, input.hostsIo);
        } catch (error) {
            hosts = { changed: false, elevated: false, error: error instanceof Error ? error.message : String(error), manualBlock: hostsFileBlock(routes) };
        }
        notify();
        return hosts;
    };
    render();
    sites.onChange(() => { render(); void syncHosts(); });
    supervisor.onChange(render);
    supervisor.start({
        id: 'genie-front-door',
        workspaceId: '_genie',
        name: 'Genie front door (Caddy)',
        command: `${caddyBin} run --config ${caddyfile} --adapter caddyfile --watch`,
        cwd: caddyDir,
        env: { XDG_DATA_HOME: join(caddyDir, 'data'), XDG_CONFIG_HOME: join(caddyDir, 'config') },
        restart: 'always',
    });
    void syncHosts();
    return {
        status: () => ({ running: true, caddyfile, hostsPath: input.hostsPath, hosts, trusted }),
        onChange,
        syncHosts,
        trust: async () => {
            if (trusted) return { ok: true };
            const plan = trustPlan(caddyBin, caddyDir);
            try {
                await input.runElevated({ command: plan.command, args: plan.args, env: plan.env });
            } catch (error) {
                return { ok: false, reason: error instanceof Error ? error.message : String(error) };
            }
            writeFileSync(marker, new Date().toISOString(), 'utf8');
            trusted = true;
            notify();
            return { ok: true };
        },
    };
}

export async function composeServices(input: ComposeInput): Promise<ComposedServices> {
    const now = input.now ?? Date.now;
    const iso = () => new Date(now()).toISOString();
    await mkdir(runtimeDir(input.userData), { recursive: true });

    const settings = await SettingsStore.open(input.userData, iso);
    await settings.carryOverFromV1(input.v1Settings());

    const inbox = await InboxStore.open(input.userData, iso);
    const attention = await AttentionStore.open(input.userData, inbox, iso);
    const knowledge = KnowledgeStore.open(input.userData, iso);
    const flows = await FlowStore.open(input.userData, now);
    const flowScheduler = new FlowScheduler({
        store: flows,
        now,
        schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
        // Executors arrive with the Flows canvas work; until then a fired flow is recorded as run with
        // nothing executed, which the store's lastRun shows honestly.
        run: async () => {},
    });
    flowScheduler.plan();

    const supervisor = new ProcessSupervisor(input.pty, { now, schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } });
    let nextPort = 4100;
    // ONE loopback allocator for sites and engines: two things never share a port.
    const allocatePort = input.allocatePort ?? (() => ++nextPort);
    const docker: DockerRunner = input.docker ?? ((args) => execFileRunner('docker', args).catch((e: unknown) => ({ stdout: e instanceof Error ? e.message : String(e), exitCode: 127 })));
    const engines = await ServiceRegistry.open(input.userData, new ServiceDriver(docker), { allocatePort, randomPassword: () => randomBytes(18).toString('base64url') });
    const sites = new SiteManager({
        supervisor,
        allocatePort,
        caddyBin: input.caddyBin,
        configDir: join(runtimeDir(input.userData), 'sites'),
        writeConfig: (path, content) => {
            // Synchronous on purpose: the Caddy process is started right after and must find its file.
            mkdirSync(join(path, '..'), { recursive: true });
            writeFileSync(path, content, 'utf8');
        },
    });
    const routes = () => sites.routes();
    const frontDoor = new GenRouterServer(routes);
    const frontDoorPort = await frontDoor.listen(input.frontDoorPort ?? 0);

    const approvals = new ApprovalQueue({ now });
    const feedback = await FeedbackStore.open(input.userData, now);

    const hostName = input.hostName ?? hostname();
    // §6.7: plugins live beside the rest of Genie's state; signed by default, unsigned only under developer mode.
    const pluginsDir = join(input.userData, 'plugins');
    const openPlugins = () => PluginHost.open({ dir: pluginsDir, keys: PUBLISHER_KEYS, developerMode: settings.snapshot().developer_mode === true });
    let plugins = await openPlugins();
    const remoteDevices = await DeviceStore.open(input.userData, { now, random: () => randomBytes(24).toString('base64url') });
    const remote = new RemoteHost({
        api: input.remoteApi ?? { invoke: async () => { throw new Error(`${hostName} has no remote host API wired in this build`); }, onEvent: () => () => {}, workspaceOfAgent: () => null },
        hostName,
        baton: new Baton(),
        pins: new PairingPins({ now, random: Math.random }),
        shares: new ShareLinks({ host: hostName, now, random: () => randomBytes(18).toString('base64url') }),
        devices: remoteDevices,
        transport: input.remoteTransport ?? { onConnection: () => () => {} },
        now,
    });
    const elevationRun = (plan: { command: string; args: readonly string[] }) => execFileRunner(plan.command, plan.args, { timeoutMs: 300_000 });
    const frontDoorCtl = startExternalFrontDoor({
        caddyBin: input.caddyBin,
        caddyDir: join(runtimeDir(input.userData), 'caddy'),
        sites,
        supervisor,
        hostsIo: input.hostsIo ?? realHostsIo({ platform: process.platform, tmpDir: runtimeDir(input.userData), run: elevationRun }),
        hostsPath: hostsFilePath(process.platform),
        runElevated: input.runElevated ?? ((step) => runElevatedViaOs(process.platform, step, elevationRun)),
    });
    const agents = new Map<string, { name: string; workspaceId: string }>();
    const reminders = new ReminderBook();
    const addresses = new Map<string, string>();
    let down: Promise<void> | null = null;

    return {
        inbox,
        attention,
        knowledge,
        flows,
        flowScheduler,
        settings,
        supervisor,
        sites,
        engines,
        frontDoor,
        approvals,
        remote,
        feedback,
        frontDoorPort,
        get externalFrontDoor() { return frontDoorCtl.status(); },
        onFrontDoorChange: frontDoorCtl.onChange,
        syncHosts: frontDoorCtl.syncHosts,
        trustCertificate: frontDoorCtl.trust,
        routes,
        deckItems: () => [
            ...approvals.deckItems(),
            ...deckItemsFrom({
                questions: attention.pending(),
                userList: attention.allUserItems(),
                unreadDms: inbox.unread(HUMAN),
                finished: attention.finished(),
                agents: Object.fromEntries(agents),
            }),
        ],
        inboxReminders: ({ now, idle }) =>
            [...agents.keys()].flatMap((id) => {
                const text = reminders.due({ agentId: id, unread: inbox.unread(id as never).length, idle: idle(id), now });
                return text ? [{ agentId: id, text }] : [];
            }),
        signals: ({ osAgentWorking }) => ({
            flowsRunning: flowScheduler.inFlightCount(),
            // Mail agents have not collected: unread for every registered agent, the human excluded.
            uncollectedMail: [...agents.keys()].reduce((n, id) => n + inbox.unread(id as never).length, 0),
            githubBlocked: githubAppStatus({ authorized: settings.snapshot().github_authorized === true, installedRepos: settings.snapshot().github_installed === true ? ['this workstation'] : [], neededRepos: ['this workstation'] }).blocking,
            osAgentWorking,
        }),
        integrations: () => {
            const values = settings.snapshot();
            return {
                tynnSignedIn: typeof values.tynn_token === 'string' && values.tynn_token.length > 0,
                github: githubAppStatus({ authorized: values.github_authorized === true, installedRepos: values.github_installed === true ? ['this workstation'] : [], neededRepos: ['this workstation'] }),
                gated: tynnGate([{ id: 'tynn-sync', label: 'Sync work items with Tynn', tynn: true }], { signedIn: typeof values.tynn_token === 'string' && values.tynn_token.length > 0 }),
            };
        },
        get plugins() { return plugins; },
        pluginsDir,
        pluginsRefresh: async () => { plugins = await openPlugins(); },
        syncConfig: async (workspacePath) => {
            const endpoint = input.mcpEndpoint?.() ?? null;
            if (!endpoint) throw new Error('Genie has no MCP endpoint yet (the server is not listening); nothing to write into the workspace');
            const values = settings.snapshot();
            const flag = (k: string) => values[k] !== false;
            const targets = configSyncTargets({
                workspacePath,
                fs: {
                    read: async (p) => { try { return await readFileP(p, 'utf8'); } catch { return null; } },
                    write: async (p, text) => { await mkdir(dirname(p), { recursive: true }); await writeFileP(p, text, 'utf8'); },
                },
                flags: { mcp_sync_claude: flag('mcp_sync_claude'), mcp_sync_cursor: flag('mcp_sync_cursor'), mcp_sync_codex: flag('mcp_sync_codex'), mcp_sync_hooks: flag('mcp_sync_hooks') },
            });
            return configSync(targets, { GENIE_MCP_URL: endpoint.url, GENIE_MCP_TOKEN: endpoint.token });
        },
        registerAgentName: (agentId, who) => { agents.set(agentId, who); },
        registerAgentAddress: (address, agentId) => { addresses.set(address, agentId); },
        agentAddresses: () => [...addresses].map(([address, agentId]) => ({ address, agentId, name: agents.get(agentId)?.name ?? agentId })),
        resolveAddress: (text) => {
            if (text === HUMAN || text === 'you') return { kind: 'human' };
            const exact = addresses.get(text);
            if (exact !== undefined) return { kind: 'one', id: exact as never };
            // A short form that several full forms end with is ambiguous; name both.
            const matches = [...addresses.keys()].filter((a) => a.endsWith(`:${text}`) && a.split(':').length === 3);
            if (matches.length === 1) return { kind: 'one', id: addresses.get(matches[0]!)! as never };
            if (matches.length > 1) return { kind: 'ambiguous', forms: matches };
            return { kind: 'none' };
        },
        shutdown: () => {
            down ??= (async () => {
                approvals.cancelAll('Genie is shutting down');
                for (const p of supervisor.list()) supervisor.stop(p.id);
                await new Promise<void>((r) => frontDoor.close(r));
                await flowScheduler.settled();
                await remoteDevices.flushed();
                await feedback.flushed();
                knowledge.close();
            })();
            return down;
        },
    };
}
