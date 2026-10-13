import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, readdir as readdirP, readFile as readFileP, rmdir, unlink as unlinkP, writeFile as writeFileP } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { deckItemsFrom } from '../core/deck-sources.js';
import type { DeckItem, SignalState } from '../core/deck.js';
import type { GenRoute } from '../core/gen-router.js';
import { frontDoorCaddyfile, hostsFilePath, trustPlan } from '../core/front-door-caddy.js';
import { hostsFileBlock } from '../core/gen-router.js';
import { HUMAN, addressOf, resolveAddress as resolveOnRoster, type Resolution } from '../core/inbox.js';
import type { AgentRecord } from '../core/identity.js';
import { ReminderBook } from '../core/inbox-reminders.js';
import { configSync, githubAppStatus, tynnGate, type AnnotatedRow, type GithubAppStatus, type SyncResult } from '../core/integrations.js';
import { AgentFilesHealth, type AgentFilesReport, type AgentFilesStep, type SyncSource } from '../core/agent-files-health.js';
import { writeAgentGitignore } from './agent-gitignore.js';
import { writeAgentRouters } from './agent-routers.js';
import { writeAgentSkills } from './agent-skills.js';
import { configSyncTargets, writeAgentProtocol } from './config-sync-targets.js';
import { PluginHost } from './plugin-host.js';
import type { Verification } from './mcp-server.js';
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
    /** Whether a real server/discover through the server's own door answered at boot (§6.4 "native transport verified at boot"). */
    readonly mcpVerification?: () => Verification | null;
    /** Every tool Genie's MCP serves, with what it does — what every agent gets (Settings lists it). */
    readonly mcpTools?: () => readonly { name: string; description: string }[];
    /**
     * The live agent roster — the same one the agents' own inbox tool resolves against. Late-bound: the registry
     * exists after composition. Addresses, names, uncollected mail and reminders all derive from it; absent = none.
     */
    readonly roster?: () => readonly AgentRecord[];
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
    integrations(): { tynnSignedIn: boolean; github: GithubAppStatus; gated: AnnotatedRow[]; mcp: { url: string | null; verified: Verification | null; tools: readonly { name: string; description: string }[] }; agentFiles: readonly AgentFilesReport[] };
    /** Config sync (§6.9): Genie's MCP endpoint into a workspace's four targets, each reported on its own. `source`: Genie's start (default) or you. */
    syncConfig(workspacePath: string, source?: SyncSource): Promise<SyncResult[]>;
    /** The Genie 2 protocol files under `.agents/_genie/`, then the AGENTS.md / CLAUDE.md routers and RULES.md, then the skills (separate from the four config-sync targets). */
    syncAgentDocs(workspacePath: string, source?: SyncSource): Promise<void>;
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
    /** Every roster agent's full address with its name — the human's peer list. */
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
    const roster = (): readonly AgentRecord[] => input.roster?.() ?? [];
    // Who each agent is, for the Deck's names and the reminder/uncollected-mail counts: from the roster, now.
    const agents = (): Map<string, { name: string; workspaceId: string }> => new Map(roster().map((r) => [r.id as string, { name: r.name, workspaceId: r.workspaceId }]));
    const reminders = new ReminderBook();
    // What the sync did to each workspace's agent files, for Settings (nothing about them is silent).
    const agentFiles = new AgentFilesHealth();
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
                agents: Object.fromEntries(agents()),
            }),
        ],
        inboxReminders: ({ now, idle }) =>
            [...agents().keys()].flatMap((id) => {
                const text = reminders.due({ agentId: id, unread: inbox.unread(id as never).length, idle: idle(id), now });
                return text ? [{ agentId: id, text }] : [];
            }),
        signals: ({ osAgentWorking }) => ({
            flowsRunning: flowScheduler.inFlightCount(),
            // Mail agents have not collected: unread for every registered agent, the human excluded.
            uncollectedMail: [...agents().keys()].reduce((n, id) => n + inbox.unread(id as never).length, 0),
            githubBlocked: githubAppStatus({ authorized: settings.snapshot().github_authorized === true, installedRepos: settings.snapshot().github_installed === true ? ['this workstation'] : [], neededRepos: ['this workstation'] }).blocking,
            osAgentWorking,
        }),
        integrations: () => {
            const values = settings.snapshot();
            return {
                tynnSignedIn: typeof values.tynn_token === 'string' && values.tynn_token.length > 0,
                github: githubAppStatus({ authorized: values.github_authorized === true, installedRepos: values.github_installed === true ? ['this workstation'] : [], neededRepos: ['this workstation'] }),
                gated: tynnGate([{ id: 'tynn-sync', label: 'Sync work items with Tynn', tynn: true }], { signedIn: typeof values.tynn_token === 'string' && values.tynn_token.length > 0 }),
                mcp: { url: input.mcpEndpoint?.()?.url ?? null, verified: input.mcpVerification?.() ?? null, tools: input.mcpTools?.() ?? [] },
                agentFiles: agentFiles.list(),
            };
        },
        get plugins() { return plugins; },
        pluginsDir,
        pluginsRefresh: async () => { plugins = await openPlugins(); },
        syncConfig: async (workspacePath, source = 'start') => {
            const endpoint = input.mcpEndpoint?.() ?? null;
            if (!endpoint) {
                const reason = 'Genie has no MCP endpoint yet (the server is not listening); nothing to write into the workspace';
                agentFiles.config(workspacePath, [{ label: 'Genie MCP', ok: false, error: reason }], Date.now(), source);
                throw new Error(reason);
            }
            const values = settings.snapshot();
            const flag = (k: string) => values[k] !== false;
            const targets = configSyncTargets({
                workspacePath,
                fs: {
                    read: async (p) => { try { return await readFileP(p, 'utf8'); } catch { return null; } },
                    write: async (p, text) => { await mkdir(dirname(p), { recursive: true }); await writeFileP(p, text, 'utf8'); },
                    remove: async (p) => { try { await unlinkP(p); } catch { /* not there: nothing to remove */ } },
                    list: async (d) => { try { return await readdirP(d); } catch { return []; } },
                },
                flags: { mcp_sync_claude: flag('mcp_sync_claude'), mcp_sync_cursor: flag('mcp_sync_cursor'), mcp_sync_codex: flag('mcp_sync_codex'), mcp_sync_hooks: flag('mcp_sync_hooks') },
            });
            const results = await configSync(targets, { GENIE_MCP_URL: endpoint.url, GENIE_MCP_TOKEN: endpoint.token });
            agentFiles.config(workspacePath, results, Date.now(), source);
            return results;
        },
        syncAgentDocs: async (workspacePath, source = 'start') => {
            const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const on = settings.snapshot().mcp_sync_agents !== false;
            // One node fs for every step; each write and removal is reported to the health record Settings reads.
            const nodeFs = (touched: (path: string) => void) => ({
                read: async (p: string) => { try { return await readFileP(p, 'utf8'); } catch { return null; } },
                write: async (p: string, text: string) => { await mkdir(dirname(p), { recursive: true }); await writeFileP(p, text, 'utf8'); touched(p); },
                remove: async (p: string) => { try { await unlinkP(p); touched(p); } catch { /* not there: nothing to remove */ } },
                unlink: async (p: string) => { await unlinkP(p); touched(p); },
                list: async (d: string) => { try { return await readdirP(d); } catch { return []; } },
                removeDir: async (d: string) => { try { await rmdir(d); } catch { /* not empty or not there: left as it is */ } },
                isSymlink: async (p: string) => { try { return (await lstat(p)).isSymbolicLink(); } catch { return false; } },
                exists: async (p: string) => { try { await lstat(p); return true; } catch { return false; } },
            });
            const steps: AgentFilesStep[] = [
                // First, whatever the switches: the files that carry Genie's MCP token are kept out of a commit.
                { step: 'gitignore', run: (t) => writeAgentGitignore({ workspacePath, fs: nodeFs(t) }) },
                // The protocol files (.agents/_genie/), true for Genie 2, listing the tools Genie's MCP actually serves.
                { step: 'protocol', run: (t) => writeAgentProtocol({ workspacePath, enabled: on, tools: input.mcpTools?.() ?? [], fs: nodeFs(t) }) },
            ];
            if (on) {
                // The routers and RULES.md after the protocol they import (Genie 1's repaired); then Genie 2's skills.
                steps.push({ step: 'routers', run: (t) => writeAgentRouters({ workspacePath, stamp, fs: nodeFs(t) }) });
                steps.push({ step: 'skills', run: (t) => writeAgentSkills({ workspacePath, stamp, fs: nodeFs(t) }) });
            }
            // A failing step is recorded and does not stop the steps after it.
            const report = await agentFiles.run(workspacePath, steps, Date.now(), source);
            for (const f of report.failed) console.error(`[workspace-files] ${workspacePath} ${f.step}: ${f.error}`);
        },
        agentAddresses: () => roster().map((r) => ({ address: addressOf(r, 'full'), agentId: r.id as string, name: r.name })),
        // The inbox's own rule (core/inbox.ts), on the same roster the agents' tool uses: one rule for both.
        resolveAddress: (text) => resolveOnRoster(text, roster()),
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
