import { phpWorkerEnvWithTrust } from './php-trust-host.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { asleepOnlyEngine, enginesToRelease, enginesToResume } from '../core/hibernate-engines.js';
import { DEFAULT_READINESS, engineStatuses as engineStatusesOf, readinessHandshake, reconcileEngines, type ReadinessBound, type ReconcileReport } from '../core/engine-reconcile.js';
import { PortAllocator } from '../core/port-allocator.js';
import type { ServiceInstance } from '../core/services.js';
import { websocketRoutes } from './websocket-front-door.js';
import { mailpitRoutes } from '../core/mailpit-name.js';
import type { DeckItem } from '../core/deck.js';
import type { GenRoute } from '../core/gen-router.js';
import { frontDoorCaddyfile, hostsFilePath, type FrontDoorTls } from '../core/front-door-caddy.js';
import { trustDeckItem, trustInstallStep } from '../core/gen-ca.js';
import { GenCa, osTrustStore, type CaSource, type CertIssuer, type TrustStorePort } from './gen-ca.js';
import { runV1ServicesAdoption } from './v1-services.js';
import type { AppEnvSource } from './app-inbox-service.js';
import { Elevator, realHostsIo, runElevatedBatch, stepOutcome, type ElevationOutcome, type PrivilegedStep } from './elevate.js';
import { GenRouterServer } from './gen-router-server.js';
import { GenLeafContexts } from './browser-trust.js';
import { FRONT_DOOR_PORTS, bindFailure, heldReason, realFrontDoorPorts, type FrontDoorBlocked, type FrontDoorPort, type FrontDoorPorts } from './front-door-port.js';
import { HostsSync, type HostsIo, type HostsSyncResult } from './hosts-file.js';
import { runtimeDir } from './paths.js';
import type { SupervisorApi } from './process-supervisor.js';
import { loopbackAnswers, loopbackPortFree } from './port-probe.js';
import { ServiceDriver, dockerRunnerOver, type DockerEventsPort, type DockerRunner } from './service-driver.js';
import { ServiceRegistry } from './service-registry.js';
import { DotEnvSync, envFileSites, gitIgnoredOver, type DotEnvSyncPorts } from './dotenv-sync.js';
import { ownTrust, type TrustApi } from './hosting-trust.js';
import { SiteManager, type PhpCgiResolution } from './site-manager.js';
import { EnvelopeSites, nodeEnvelopeFs, type WorkspaceRef } from './envelope-sites-host.js';
import { readJson, writeJsonAtomic } from './store.js';
import { execFileRunner, lineStreamRunner } from './toolchain-runner.js';
import type { SettingsApi } from './agent-stores-api.js';
import type { HostingApi } from './hosting-host.js';
import { LIVE_STATUS_PAUSED } from './linked-stream.js';

/**
 * THE HOSTING HALF OF THE COMPOSITION (the host split, P5a): the shared port allocator, the service engines on the Docker
 * driver (Genie 1's taken over, the boot reconcile), the site manager and the workspaces' declared sites, the `.env`
 * sync, Genie's `.gen` CA, the in-app front door and the external one (Caddy, the hosts block, Trust). Built by
 * genie-host when it runs, and by the window's compose.ts only on the emergency path (no host) — the same code both ways.
 *
 * Electron-free (test/genie-host-no-electron.test.ts): what only Electron can say (the bundled Caddy's path, Genie 1's
 * CA folders) is computed by the caller and handed in.
 */

/**
 * The external front door, beyond "Caddy runs": the hosts block; Genie's CA (whose it is, its thumbprint) and whether
 * the OS trust store holds it — READ from the store, `null` until the first read answers; the last Trust's failure, with
 * its reason; and a leaf that could not be issued.
 */
export type FrontDoorStatus =
    | {
          running: true;
          caddyfile: string;
          hostsPath: string;
          hosts: HostsSyncResult | null;
          authority: { source: CaSource; thumbprint: string };
          trusted: boolean | null;
          trustError: string | null;
          certificateError: string | null;
      }
    /**
     * Off: no bundled Caddy or no CA (`reason` alone), or — `blocked` — a port the front door needs is held by another
     * process (or refused by the OS): Caddy is not started and not restarted until the person tries again.
     */
    | { running: false; reason: string; blocked?: { port: FrontDoorPort; holder: string | null } };

/** What the hosting is built with, beyond the supervisor and the settings: the same options compose has always taken. */
export interface HostingOptions {
    /** Why there is no bundled Caddy, when the caller knows (genie-host: the launch input it lacks); the generic reason otherwise. */
    readonly noCaddyReason?: string;
    /** What this hosting was started without, each with what goes without it — shown in Hosting (genie-host's launch inputs). */
    readonly problems?: readonly string[];
    /**
     * The link of the spawn-host child the engines' `docker events` watch runs under (genie-host's process helper). While it
     * is down the live status cannot be followed, and Hosting says so (LIVE_STATUS_PAUSED) until it is back. Absent = none.
     */
    readonly liveStatusLink?: { up(): boolean; onChange(listener: () => void): () => void };
    /**
     * `docker events` as a stream of lines, so engine states are read on change instead of on every look (genie#1397).
     * Absent with no `docker` given = the real one, created where `execFileRunner`'s commands are; absent with a `docker`
     * given (a test's fake) = no watch, every look asks.
     */
    readonly dockerEvents?: DockerEventsPort;
    /**
     * Genie 1's database, for TAKING OVER its service engines in place and stopping its sandbox/site containers
     * (main/v1-services.ts) — at boot until services.json records a take-over that saw Genie 1 and Docker. Before the
     * sites and the process book start, because both read the engines' env. Absent = no Genie 1 to take over from.
     */
    readonly v1Services?: { readonly database: string };
    readonly caddyBin: string | null;
    /** What every site's php-cgi worker is given on top of the pty host's env: Genie's CA ini directory (toolchain-ops.ts). */
    readonly phpWorkerEnv?: () => Readonly<Record<string, string>>;
    /** This machine's system CA roots for PHP's trust bundle (main/php-trust-host.ts systemRootsPem). Absent = none. */
    readonly phpSystemRoots?: () => string | null;
    /** Which php-cgi a site's PHP pin runs (main/php-versions.ts `resolvePhpCgi`); absent = PATH php-cgi, pins refused. */
    readonly resolvePhpCgi?: (pin: string | undefined) => PhpCgiResolution;
    /** Right before a pinned site's php-cgi starts (main/php-versions.ts `refreshManagedIni`). */
    readonly preparePhpCgi?: (pin: string | undefined) => void;
    /** php-cgi workers per PHP site (site-manager PHP_WORKERS when absent). */
    readonly phpWorkers?: number;
    /** 0 picks a free loopback port. */
    readonly frontDoorPort?: number;
    readonly allocatePort?: () => number;
    /** Whether 127.0.0.1:<port> is free to bind (the shared allocator's probe); a real bind probe by default. */
    readonly portFree?: (port: number) => Promise<boolean>;
    /** Runs `docker <args>`; execFile in production. A missing Docker answers a non-zero exit, never a throw. */
    readonly docker?: DockerRunner;
    /** ONE readiness probe of an engine on its loopback port; the engine's own handshake over a real socket by default. */
    readonly engineAnswers?: (instance: ServiceInstance) => Promise<boolean>;
    /**
     * A started site's readiness wait (parity audit #9): true once its port answers. main.ts passes the real one
     * (port-probe.ts `siteAnswers`); absent = no wait, a site is running when its process is (most composition tests).
     */
    readonly siteProbe?: (port: number, options: { behindCaddy: boolean }) => Promise<boolean>;
    /** How long an engine started at Genie start is waited for, and how often it is asked. */
    readonly engineReadiness?: ReadinessBound;
    /** Does git ignore a `.env` in a folder (`git check-ignore` by default)? Asked before a service password is written into one. */
    readonly gitIgnored?: DotEnvSyncPorts['gitIgnored'];
    /** The OS hosts file; the real one by default. */
    readonly hostsIo?: HostsIo;
    /**
     * Runs a BATCH of steps through ONE OS elevation prompt and says which step, if any, stopped it (elevate.ts). The real
     * prompt by default. Genie calls it one batch at a time, and a hosts write due when the person trusts rides along.
     */
    readonly elevate?: (steps: readonly PrivilegedStep[]) => Promise<ElevationOutcome>;
    /** How long a burst of site changes is waited out before the one hosts write; 250 ms by default. */
    readonly hostsDebounceMs?: number;
    /** The front door's :443/:80 — free, or held and by whom; real bind probes and the OS's listener table by default. */
    readonly frontDoorPorts?: FrontDoorPorts;
    /**
     * Genie 1's `host-gen` folders (`<Genie 1 userData>/host-gen`), where its `.gen` CA may be — ADOPTED by copying when
     * Genie 2 has no CA of its own. None by default: only main.ts names Genie 1's real folders.
     */
    readonly v1CaDirs?: readonly string[];
    /** The OS trust store, asked by thumbprint; the real one (read-only) by default. */
    readonly trustStore?: TrustStorePort;
    /** Issues the CA and the leaf; the node:crypto X.509 builder by default. */
    readonly certIssuer?: CertIssuer;
}

export interface HostingComposeInput extends HostingOptions {
    readonly userData: string;
    /** SAFE MODE (Tynn #386; genie-host's): while on, no site and no stopped engine is started by a launch or a wake. */
    readonly safeMode?: () => boolean;
    /** A site safe mode held down, with the name the banner shows it by. */
    readonly heldSite?: (siteId: string, name: string) => void;
    readonly now?: () => number;
    /** The registered workspaces (id, folder, asleep), late-bound: their envelopes' `sites` are what Hosting lists and serves. */
    readonly workspaces?: () => readonly WorkspaceRef[];
    /** Fires when the registered workspaces change — one added, removed, hibernated or woken. */
    readonly onWorkspacesChange?: (listener: () => void) => () => void;
    /** The process supervisor the sites and the front door run under (genie-host's own, or the window's on the emergency path). */
    readonly supervisor: SupervisorApi;
    /** The settings, for the one that moves a site's env: "Apps and scripts may message agents here" (`app_inbox`). */
    readonly settings: Pick<SettingsApi, 'onChange'>;
    /** A source's app credential (genie#1345) under its workspace's switch — laid over that site's env only. */
    readonly appEnv: (source: AppEnvSource) => Readonly<Record<string, string>>;
    /** A workspace's trust verdict moved (genie#1519): told after the record is updated. */
    readonly onTrustVerdict?: ((workspaceId: string) => void) | undefined;
    /** The slow pass over what a verdict reads. Absent = `TRUST_PASS_MS`. */
    readonly trustWatchEveryMs?: number | undefined;
    /** False = no folder watchers, the slow pass alone. Absent = watch. */
    readonly trustWatchFolders?: boolean | undefined;
}

/** The hosting as its builder holds it: the API, and its shutdown in the steps a quit interleaves with stopping every supervised process. */
export interface HostingStack extends HostingApi {
    // The classes themselves — what the window's narrow surface (hosting-host.ts) is a part of.
    readonly sites: SiteManager;
    readonly envelopeSites: EnvelopeSites;
    readonly engines: ServiceRegistry;
    /** The workspace's service connection kept current in each site repo's `.env` — refused where git would commit it. */
    readonly envFiles: DotEnvSync;
    /** The in-app browser's front door (S7). */
    readonly frontDoor: GenRouterServer;
    /** The workspaces' trust (genie#1519): its record and verdicts, owned where the hosting is. */
    readonly trust: TrustApi;
    /** Nothing more is started or synced: the hosts sync and the port probe, the docker watch, the workspace watch. */
    quiesce(): void;
    /** The `.env` pass in flight is let finish (compose-env-drain.test.ts): a quit mid-pass cut a write short. */
    drainEnvFiles(): Promise<void>;
    /** The in-app front door's connections closed. */
    closeFrontDoor(): Promise<void>;
    /** No trust pass starts from here; the one in flight is waited for, and this process's git policy goes (genie#1519). */
    closeTrust(): Promise<void>;
    /** The port allocator's last write landed. */
    settled(): Promise<void>;
}

/**
 * The EXTERNAL front door: Genie's bundled Caddy serving https://<name>.gen on 443 with GENIE'S OWN CA's leaf
 * (core/gen-ca.ts — Genie 1's CA adopted on upgrade, so a root the browser already trusts), as ONE supervised process
 * started with --watch, so the routes change by rewriting the Caddyfile and never by spawning a second Caddy. Without
 * a bundled binary nothing starts, and the reason is recorded for the Hosting surface — the in-app browser does not
 * need this path.
 */
interface FrontDoorController {
    status(): FrontDoorStatus;
    onChange(listener: () => void): () => void;
    settled(): Promise<void>;
    syncHosts(): Promise<HostsSyncResult>;
    /** Boot has loaded the workspaces' sites: the hosts file follows them from here, starting with one sync. */
    beginHosts(): void;
    retry(): Promise<FrontDoorStatus>;
    trust(): Promise<{ ok: true } | { ok: false; reason: string }>;
    deferTrust(): void;
    /** Genie's own Deck items about the front door: the one Trust ask. */
    deckItems(): DeckItem[];
    /** Shutdown: nothing more is started or synced. */
    close(): void;
}

const FRONT_DOOR_ID = 'genie-front-door';
const TRUST_STEP_ID = 'trust';

const NO_CADDY = 'this install has no bundled Caddy; https://<name>.gen in external browsers is off, the in-app browser still works';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Genie's `.gen` CA, opened ONCE for both doors: the external Caddy serves its leaf, and the in-app browser's tunnel
 * (S7) serves the same leaf and trusts the same root. A CA that cannot be set up is a reason, never a throw.
 */
function openGenCa(input: { caDir: string; v1CaDirs: readonly string[]; issuer: CertIssuer | undefined; now: () => number }): { ca: GenCa; error: null } | { ca: null; error: string } {
    try {
        return { ca: GenCa.open({ dir: input.caDir, v1Dirs: input.v1CaDirs, now: input.now, ...(input.issuer ? { issuer: input.issuer } : {}), log: (line) => console.log(line) }), error: null };
    } catch (error) {
        console.error(`[gen-ca] ${message(error)}`);
        return { ca: null, error: message(error) };
    }
}

function startExternalFrontDoor(input: {
    caddyBin: string | null;
    noCaddyReason?: string | undefined;
    caddyDir: string;
    /** Opens the shared CA on first call (main: once, for both doors). */
    genCa: () => { ca: GenCa; error: null } | { ca: null; error: string };
    trustStore: TrustStorePort;
    platform: NodeJS.Platform;
    now: () => number;
    sites: SiteManager;
    /** Every route the door serves: the sites' and the shared engines' browser-facing ones (websocketRoutes). */
    routes: () => GenRoute[];
    /** Called when routes other than the sites' change (an engine attached or detached). */
    onRoutesChange: (listener: () => void) => void;
    /** The names the hosts file carries — configured, not running (ComposedServices.configuredHosts). */
    configuredHosts: () => readonly string[];
    supervisor: SupervisorApi;
    hostsIo: HostsIo;
    hostsPath: string;
    hostsDebounceMs: number;
    elevator: Elevator;
    ports: FrontDoorPorts;
}): FrontDoorController {
    const listeners = new Set<() => void>();
    const onChange = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
    const notify = () => { for (const l of listeners) l(); };
    const { caddyBin, caddyDir, sites, supervisor } = input;
    const off = (reason: string): FrontDoorController => ({
        status: () => ({ running: false, reason }),
        onChange,
        settled: async () => {},
        syncHosts: async () => { throw new Error(reason); },
        beginHosts: () => {},
        retry: async () => ({ running: false, reason }),
        trust: async () => ({ ok: false, reason }),
        deferTrust: () => {},
        deckItems: () => [],
        close: () => {},
    });
    if (caddyBin === null) return off(input.noCaddyReason ?? NO_CADDY);
    // Without a CA there is no certificate to serve: say so, and start nothing that would serve a broken one.
    const opened = input.genCa();
    if (opened.ca === null) return off(`Genie’s certificate authority could not be set up (${opened.error}); https://<name>.gen is off in external browsers and in the in-app browser`);
    const ca = opened.ca;
    const caddyfile = join(caddyDir, 'Caddyfile');
    // Caddy's storage: where XDG_DATA_HOME (below) has put it since the first beta, now named in the Caddyfile too.
    const caddyStorage = join(caddyDir, 'data', 'caddy');
    /** What this process last wrote to the Caddyfile; null = not yet, so the first render always writes. */
    let written: string | null = null;
    // Earlier betas remembered `caddy trust` (Caddy's own root) with this marker. Trust is read from the OS store now,
    // and that root is no longer served; the marker would only mislead whoever reads the folder.
    rmSync(join(caddyDir, 'trusted'), { force: true });
    let trusted: boolean | null = null;
    let trustError: string | null = null;
    let certificateError: string | null = null;
    let askedAt: number | null = null;
    let deferredFor = ca.trustDeferred();
    let trusting: Promise<{ ok: true } | { ok: false; reason: string }> | null = null;
    /** A front-door port another process holds (or the OS refused): Caddy is down on purpose, with the reason. */
    let blocked: FrontDoorBlocked | null = null;
    let failure: string | null = null;
    let closed = false;
    const reportFailure = (error: unknown) => {
        if (closed) return;
        failure = `Genie could not complete its external front door check: ${message(error)}`;
        notify();
    };
    // Include state updates and notifications in each completion, not just the underlying OS request.
    const pending = new Set<Promise<unknown>>();
    let generation = 0;
    const track = <T>(work: Promise<T>): Promise<T> => {
        generation += 1;
        const tracked: Promise<T> = work.finally(() => { pending.delete(tracked); });
        pending.add(tracked);
        return tracked;
    };
    const render = () => {
        const routes = input.routes();
        let tls: FrontDoorTls | null = null;
        if (routes.length > 0) {
            try {
                tls = ca.leafFor(routes.map((r) => r.host));
                certificateError = null;
            } catch (error) {
                // The previous Caddyfile (and leaf) stay as they were; the failure is a fact on the Hosting surface.
                certificateError = `Genie could not issue the certificate for ${routes.map((r) => r.host).join(', ')}: ${message(error)}`;
                console.error(`[gen-ca] ${certificateError}`);
                return;
            }
        }
        // Written only when the config CHANGED. render() runs on every process status change anywhere in Genie, and
        // each one rewrote the same bytes: a file write Defender scans and a reload decision Caddy's --watch makes.
        const next = frontDoorCaddyfile(routes, tls, caddyStorage);
        if (next === written) return;
        mkdirSync(caddyDir, { recursive: true });
        writeFileSync(caddyfile, next, 'utf8');
        written = next;
    };
    // READ from the OS store by the CA's thumbprint — never a marker. A store that cannot be read is untrusted with
    // the reason, so the person still has the Trust door.
    const readTrust = async (): Promise<boolean> => {
        let holds: boolean;
        try {
            holds = await input.trustStore.has(ca.thumbprint);
            if (holds) trustError = null;
        } catch (error) {
            holds = false;
            trustError = `Genie could not read the trust store: ${message(error)}`;
        }
        trusted = holds;
        return holds;
    };
    // The hosts block follows the CONFIGURED names, so a start or a stop never writes it (and never prompts); a burst of
    // changes is one write, one sync at a time, and a declined prompt is a recorded fact with the block to paste.
    const hosts = new HostsSync({
        names: input.configuredHosts,
        io: input.hostsIo,
        elevator: input.elevator,
        debounceMs: input.hostsDebounceMs,
        schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
        onResult: notify,
    });
    render();
    sites.onChange(() => { render(); hosts.changed(); });
    input.onRoutesChange(() => { render(); hosts.changed(); });
    supervisor.onChange((status) => {
        render();
        // Started again (by the person's Restart in Processes, or by Try again): whatever held the port is asked anew —
        // Caddy's own words below set it again if it still cannot bind.
        if (status.id === FRONT_DOOR_ID && status.state === 'running' && (blocked !== null || failure !== null)) { blocked = null; failure = null; notify(); }
    });
    const spec = {
        id: FRONT_DOOR_ID,
        workspaceId: '_genie',
        name: 'Genie front door (Caddy)',
        command: `${caddyBin} run --config ${caddyfile} --adapter caddyfile --watch`,
        cwd: caddyDir,
        env: { XDG_DATA_HOME: join(caddyDir, 'data'), XDG_CONFIG_HOME: join(caddyDir, 'config') },
        restart: 'always' as const,
    };
    const block = (port: FrontDoorPort, holder: string | null, reason: string) => {
        blocked = { port, holder, reason };
        notify();
    };
    /** Caddy's recent output, across chunks (a line can arrive in two). */
    let output = '';
    // ASKED before Caddy starts: a port another process holds is reported, and Caddy is not started into a restart loop.
    const startCaddy = async (): Promise<void> => {
        for (const port of FRONT_DOOR_PORTS) {
            if ((await input.ports.probe(port)) !== 'held') continue;
            const holder = await input.ports.holder(port);
            if (closed) return;
            failure = null;
            block(port, holder, heldReason(port, holder));
            return;
        }
        if (closed) return;
        blocked = null;
        failure = null;
        output = '';
        supervisor.start(spec);
        notify();
    };
    // And READ from Caddy's own words while it runs: a bind that fails at start, or on a --watch reload that brings the
    // first route (with no routes Caddy binds nothing), stops the front door instead of letting `always` restart it.
    supervisor.onOutput((id, data) => {
        if (id !== FRONT_DOOR_ID || closed) return;
        output = (output + data).slice(-4_000);
        const failed = bindFailure(output);
        if (!failed) return;
        output = '';
        supervisor.stop(FRONT_DOOR_ID);
        block(failed.port, null, failed.kind === 'held' ? heldReason(failed.port, null) : `the front door could not listen on :${failed.port} (${failed.words}); https://<name>.gen in external browsers is off — the in-app browser still works`);
        // Who: when the OS lists a listener on the port, that process holds it — whatever words the bind failed with
        // (Windows answers "forbidden", not "in use", for a port http.sys holds).
        void track(input.ports.holder(failed.port).then((holder) => {
            if (holder !== null && blocked?.port === failed.port && blocked.holder === null) block(failed.port, holder, heldReason(failed.port, holder));
        }).catch((error: unknown) => {
            if (blocked?.port === failed.port && blocked.holder === null) reportFailure(error);
        }));
    });
    const status = (): FrontDoorStatus =>
        failure !== null
            ? { running: false, reason: failure, ...(blocked !== null ? { blocked: { port: blocked.port, holder: blocked.holder } } : {}) }
            : blocked !== null
            ? { running: false, reason: blocked.reason, blocked: { port: blocked.port, holder: blocked.holder } }
            : { running: true, caddyfile, hostsPath: input.hostsPath, hosts: hosts.result, authority: { source: ca.source, thumbprint: ca.thumbprint }, trusted, trustError, certificateError };
    void track(startCaddy().catch(reportFailure));
    void track(readTrust().then(notify));
    return {
        status,
        onChange,
        settled: async () => {
            for (;;) {
                const started = generation;
                await Promise.allSettled([...pending]);
                await hosts.settled();
                if (pending.size === 0 && started === generation) return;
            }
        },
        syncHosts: () => hosts.flush(),
        beginHosts: () => hosts.begin(),
        retry: async () => {
            if (supervisor.status(FRONT_DOOR_ID)?.state !== 'running') {
                await track(startCaddy().catch((error: unknown) => { reportFailure(error); throw error; }));
            }
            return status();
        },
        trust: () => {
            // One Trust at a time: the Deck's and Hosting's buttons pressed together raise ONE prompt. A hosts write that
            // is due rides in that same prompt (genie#604): trusting never costs two approvals.
            trusting ??= track((async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
                if (await readTrust()) { notify(); return { ok: true }; }
                const trustStep: PrivilegedStep = { id: TRUST_STEP_ID, label: 'install Genie’s certificate into the trust store', step: trustInstallStep(input.platform, ca.certPath) };
                let ran: readonly PrivilegedStep[] = [trustStep];
                const outcome = await hosts.joinElevation(async (hostsSteps) => {
                    ran = [trustStep, ...hostsSteps];
                    return { outcome: await input.elevator.run(ran), steps: ran };
                });
                const mine = stepOutcome(outcome, ran, TRUST_STEP_ID);
                if (!mine.ok) {
                    trustError = `Genie could not install its certificate into the trust store: ${mine.error}`;
                    notify();
                    return { ok: false, reason: trustError };
                }
                // The install said it worked; the store is the judge.
                trustError = null;
                if (!(await readTrust())) {
                    trustError ??= `the install finished, but the trust store does not hold Genie’s certificate (thumbprint ${ca.thumbprint})`;
                    notify();
                    return { ok: false, reason: trustError };
                }
                notify();
                return { ok: true };
            })().finally(() => { trusting = null; }));
            return trusting;
        },
        deferTrust: () => {
            ca.deferTrust();
            deferredFor = ca.thumbprint;
            notify();
        },
        deckItems: () => {
            const all = sites.list();
            if (trusted !== false || all.length === 0) return [];
            askedAt ??= input.now();
            const item = trustDeckItem({ trusted, sites: all.length, host: sites.routes()[0]?.host ?? all[0]?.host ?? null, deferredFor, thumbprint: ca.thumbprint, at: askedAt });
            return item ? [item] : [];
        },
        close: () => {
            closed = true;
            hosts.close();
        },
    };
}

export async function composeHosting(input: HostingComposeInput): Promise<HostingStack> {
    const now = input.now ?? Date.now;
    const { supervisor, settings } = input;
    const appEnvOf = input.appEnv;
    // ONE loopback allocator for sites and engines: two things never share a port — not a port an engine has
    // RECORDED (services.json, read through the registry every time), not one something else on this machine holds
    // (a bind probe), and the same ports for the same records after a restart (core/port-allocator.ts).
    let registry: ServiceRegistry | null = null;
    const portAllocator = input.allocatePort
        ? null
        // Reserved: every live engine's ports AND the ones a removed engine is remembered by (handed back on re-add).
        : new PortAllocator({ first: 4101, reserved: () => registry?.reservedPorts() ?? [], isFree: input.portFree ?? loopbackPortFree, log: (line) => console.error(line) });
    const allocatePort = input.allocatePort ?? (() => portAllocator!.next());
    // Only a pull gets the long bound (service-driver.ts); every other docker call keeps the short one.
    const docker: DockerRunner = input.docker ?? dockerRunnerOver(execFileRunner);
    const driver = new ServiceDriver(docker);
    const dockerEvents: DockerEventsPort | undefined = input.dockerEvents ?? (input.docker ? undefined : (args, onLine, onEnd) => lineStreamRunner('docker', args, onLine, onEnd));
    if (dockerEvents) driver.watch(dockerEvents);
    const engines = await ServiceRegistry.open(input.userData, driver, { allocatePort, randomPassword: () => randomBytes(18).toString('base64url'), portFree: input.portFree ?? loopbackPortFree });
    registry = engines;
    // Genie 1's engines, taken over in place (and its sandboxes stopped) BEFORE anything reads a workspace's env, primes
    // a port or reconciles: the adopted engines' ports are then reserved, and the reconcile sees them as registered.
    if (input.v1Services) {
        try {
            await runV1ServicesAdoption(engines, {
                database: input.v1Services.database,
                docker,
                reportFile: join(input.userData, 'v1-services.json'),
                now,
                workspaces: () => input.workspaces?.() ?? [],
            });
        } catch (error) {
            // Not recorded as done, so the next boot tries again; the engines Genie 2 already had are untouched.
            console.error(`[genie] taking over Genie 1's service engines failed: ${(error as Error).message}`);
        }
    }
    await portAllocator?.prime();
    // The person's engine Stops are machine-local like the sites' (site-run-state.json below): a restart keeps them stopped.
    const engineRunState = join(runtimeDir(input.userData), 'engine-run-state.json');
    const engineStopped = new Set<string>(
        await readJson<{ stopped?: unknown }>(engineRunState, { stopped: [] }).then((data) => (Array.isArray(data.stopped) ? data.stopped.filter((s): s is string => typeof s === 'string') : [])),
    );
    const saveEngineStopped = () => writeJsonAtomic(engineRunState, { stopped: [...engineStopped] });
    // WHO USES WHICH ENGINE, and who is asleep (core/hibernate-engines.ts; parity audit #12): the registry's chosen engine
    // per kind, and the registered workspaces as they are now.
    const engineUse = {
        chosen: (ws: string) => new Set(engines.choices(ws).flatMap((c) => (c.chosen ? [c.chosen.id] : []))),
        workspaces: () => (input.workspaces?.() ?? []).map((w) => ({ id: w.id, asleep: w.asleep === true })),
    };
    const enginePorts = {
        available: () => driver.available(),
        instances: () => engines.list(),
        state: async (id: string) => (await engines.status(id)).state,
    };
    // Not awaited: readiness is bounded in tens of seconds and nothing else at boot needs it. The readiness clock is
    // the real one, never `input.now` — a fixed test clock would never reach the deadline.
    const engineReconcile: Promise<ReconcileReport> = reconcileEngines(
        {
            ...enginePorts,
            personStopped: () => engineStopped,
            ...(input.safeMode ? { safeMode: input.safeMode } : {}),
            // A hibernated workspace stays asleep through a restart: an engine only sleeping workspaces use is not started.
            asleepOnly: (i) => asleepOnlyEngine(i, { chosen: engineUse.chosen, workspaces: engineUse.workspaces() }),
            start: (id) => engines.start(id),
            // Found running: a shared Redis's workspace users are put back (`start` above does it for one it starts).
            restore: (i) => engines.restoreSlices(i.id),
            answers: input.engineAnswers ?? ((i) => loopbackAnswers(i.publishedPort, readinessHandshake(i.engine))),
            now: Date.now,
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        },
        input.engineReadiness ?? DEFAULT_READINESS,
    ).then(
        (report) => {
            for (const e of report.engines) if ('reason' in e) console.error(`[engines] ${e.outcome}: ${e.reason}`);
            return report;
        },
        (error: unknown): ReconcileReport => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[engines] the registered engines could not be checked at start: ${message}`);
            return { docker: null, engines: [], error: message };
        },
    );
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
        // Every PHP worker trusts Genie's own CA too (core/php-trust.ts): a site's server side reaches https .gen addresses.
        phpWorkerEnv: () => phpWorkerEnvWithTrust({
            base: input.phpWorkerEnv?.() ?? {},
            genCaPem: () => { const opened = genCa(); if (opened.ca === null) return null; try { return readFileSync(opened.ca.certPath, 'utf8'); } catch { return null; } },
            systemRoots: () => input.phpSystemRoots?.() ?? null,
            dir: join(runtimeDir(input.userData), 'php-trust'),
            platform: process.platform,
            fs: {
                readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
                writeText: (p, t) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, t, 'utf8'); },
            },
        }),
        ...(input.resolvePhpCgi ? { resolvePhpCgi: input.resolvePhpCgi } : {}),
        ...(input.preparePhpCgi ? { preparePhpCgi: input.preparePhpCgi } : {}),
        ...(input.phpWorkers !== undefined ? { phpWorkers: input.phpWorkers } : {}),
        serviceEnv: (workspaceId) => engines.envFor(workspaceId),
        ...(input.siteProbe ? { probeReady: input.siteProbe } : {}),
        appEnv: (site) => appEnvOf(site),
    });
    // An engine change reaches the running sites it changed the env of, with no restart asked of anyone.
    engines.onChange(() => { sites.serviceEnvChanged(); });
    // The app switch moved (genie#1345): that workspace's running sites gain or lose their app credential now.
    settings.onChange((key, _value, workspaceId) => { if (key === 'app_inbox') sites.serviceEnvChanged(workspaceId); });
    // The sites' routes and the shared WebSockets server's browser-facing ones (core/services.ts websocketRoutes).
    // Mailpit's web inbox at its .gen name (core/mailpit-name.ts): the Genie browser opens .gen sites only.
    const routes = () => [...sites.routes(), ...websocketRoutes(engines.list()), ...mailpitRoutes(engines.list())];
    // The person's site Stops are machine-local (never in the git-tracked envelope): one small file here.
    const siteRunState = join(runtimeDir(input.userData), 'site-run-state.json');
    const envelopeSites = new EnvelopeSites(sites, {
        fs: nodeEnvelopeFs(),
        runState: {
            load: async () => {
                const data = await readJson<{ stopped?: unknown }>(siteRunState, { stopped: [] });
                return Array.isArray(data.stopped) ? data.stopped.filter((s): s is string => typeof s === 'string') : [];
            },
            save: (stopped) => writeJsonAtomic(siteRunState, { stopped }),
        },
        trust: {
            // A record that cannot be read is moved aside whole, for a person to look at; envelope-sites-host.ts writes a new one.
            load: async () => {
                const file = join(runtimeDir(input.userData), 'workspace-trust.json');
                try {
                    return await readJson<unknown>(file, null);
                } catch (error) {
                    await rename(file, `${file}.unreadable`).catch(() => undefined);
                    throw error;
                }
            },
            save: (book) => writeJsonAtomic(join(runtimeDir(input.userData), 'workspace-trust.json'), book),
        },
        envFor: (workspaceId) => engines.envFor(workspaceId),
        log: (line) => console.error(line),
        ...(input.safeMode ? { safeMode: input.safeMode } : {}),
        held: (siteId) => input.heldSite?.(siteId, sites.get(siteId)?.host ?? siteId),
    });
    // A site waiting for its first start here is not configured yet: the person's Start is what asks for its name.
    // CONFIGURED, not running (genie#624): a site that exists resolves whether or not it is up, so a start or a stop never
    // moves the hosts file. Unioned with what is up only so a name Caddy serves always resolves (a site started by
    // hand that its envelope declares disabled).
    const configuredHosts = (): string[] => [
        ...new Set([
            ...sites.list().filter((s) => s.state !== 'unservable' && s.firstStart === undefined && !envelopeSites.disabled(s.id)).map((s) => s.host),
            ...routes().map((r) => r.host),
        ]),
    ];
    // S7: the in-app browser opens https://<name>.gen through this door's CONNECT tunnel, terminated with Genie's leaf.
    // The CA is opened on first need — the external front door's start, or the browser's first .gen page — and once.
    let genCaOpened: ReturnType<typeof openGenCa> | null = null;
    const genCa = () => (genCaOpened ??= openGenCa({ caDir: join(runtimeDir(input.userData), 'gen-ca'), v1CaDirs: input.v1CaDirs ?? [], issuer: input.certIssuer, now }));
    let leafContexts: GenLeafContexts | null = null;
    const frontDoor = new GenRouterServer(routes, {
        tls: (host) => {
            const opened = genCa();
            if (opened.ca === null) throw new Error(`Genie’s certificate authority could not be set up (${opened.error})`);
            leafContexts ??= new GenLeafContexts(opened.ca, routes);
            return leafContexts.forHost(host);
        },
    });
    const frontDoorPort = await frontDoor.listen(input.frontDoorPort ?? 0);
    const elevationRun = (plan: { command: string; args: readonly string[] }) => execFileRunner(plan.command, plan.args, { timeoutMs: 300_000 });
    const frontDoorCtl = startExternalFrontDoor({
        caddyBin: input.caddyBin,
        noCaddyReason: input.noCaddyReason,
        caddyDir: join(runtimeDir(input.userData), 'caddy'),
        genCa,
        // Read-only: one PowerShell Test-Path per Root store on Windows, the System keychain on macOS, the bundles on Linux.
        trustStore: input.trustStore ?? osTrustStore(process.platform, (command, args) => execFileRunner(command, args, { timeoutMs: 20_000 })),
        platform: process.platform,
        now,
        sites,
        supervisor,
        routes,
        onRoutesChange: (listener) => { engines.onChange(listener); },
        configuredHosts,
        hostsIo: input.hostsIo ?? realHostsIo({ platform: process.platform, tmpDir: runtimeDir(input.userData) }),
        hostsPath: hostsFilePath(process.platform),
        hostsDebounceMs: input.hostsDebounceMs ?? 250,
        // Every elevation Genie raises goes through this one Elevator: one prompt at a time, batches carried whole.
        elevator: new Elevator(input.elevate ?? ((steps) => runElevatedBatch(process.platform, steps, elevationRun))),
        ports: input.frontDoorPorts ?? realFrontDoorPorts(process.platform, (command, args) => execFileRunner(command, args, { timeoutMs: 10_000 })),
    });
    // The workspaces' declared sites, after the front door so it re-renders as they start. Awaited: Hosting's
    // first snapshot lists them. A workspace added, hibernated or woken later is synced as it happens.
    const workspacesNow = (): readonly WorkspaceRef[] => input.workspaces?.() ?? [];
    await envelopeSites.sync(workspacesNow()).catch((error: unknown) => console.error(`[sites] the workspaces' sites could not be loaded: ${error instanceof Error ? error.message : String(error)}`));
    // Only now does the hosts file follow the sites: the boot's declare-and-start burst is ONE sync of the whole
    // configured set, never a write of a half-loaded list (which would drop names, then prompt again to add them).
    frontDoorCtl.beginHosts();
    // ONE VERDICT FOR EACH WORKSPACE (genie#1519), beside the sites that read the same record. Until a workspace has been
    // read it is not trusted, so git reads there check its config first.
    const trust = ownTrust({
        workspaces: workspacesNow,
        envelopeSites,
        readText: nodeEnvelopeFs().readText,
        everyMs: input.trustWatchEveryMs,
        watchFolders: input.trustWatchFolders,
        verdictMoved: input.onTrustVerdict,
    });
    // Each site repo's `.env` follows the workspace's engines: after the sites are known, and on every engine or site change.
    const envFiles = new DotEnvSync({
        envFor: (workspaceId) => engines.envFor(workspaceId),
        sites: () => envFileSites(sites.list()),
        fs: nodeEnvelopeFs(),
        gitIgnored: input.gitIgnored ?? gitIgnoredOver(execFileRunner),
        // The name each workspace was registered with (Settings → General "Env file name"); none recorded is `.env`.
        envFileOf: (workspaceId) => workspacesNow().find((w) => w.id === workspaceId)?.envFile,
        log: (line) => console.error(line),
    });
    const syncEnvFiles = () => { envFiles.syncAll().catch((error: unknown) => console.error(`[env] ${error instanceof Error ? error.message : String(error)}`)); };
    syncEnvFiles();
    engines.onChange(syncEnvFiles);
    sites.onChange(syncEnvFiles);
    const stopWatchingWorkspaces = input.onWorkspacesChange?.(() => {
        // Release sleeping folders' watches synchronously, before any remaining sites finish their sync.
        trust.workspacesChanged();
        envelopeSites.sync(workspacesNow()).catch((error: unknown) => console.error(`[sites] ${error instanceof Error ? error.message : String(error)}`));
    }) ?? (() => {});
    const quiesce = () => {
        stopWatchingWorkspaces();
        driver.unwatch();
        frontDoorCtl.close();
    };
    const drainEnvFiles = () => envFiles.close();
    const closeFrontDoor = () => new Promise<void>((r) => frontDoor.close(r));
    const settled = async () => { await portAllocator?.settled(); };
    const engineDependents = (id: string): string[] => {
        const i = engines.list().find((x) => x.id === id);
        if (!i) throw new Error(`no service ${id}`);
        const workspaceIds = new Set([
            ...(input.workspaces?.() ?? []).map((w) => w.id),
            ...(i.scope.kind === 'dedicated' ? [i.scope.workspaceId] : []),
            ...Object.keys(i.slices ?? {}),
            ...sites.list().map((x) => x.workspaceId),
            ...supervisor.list().map((x) => x.workspaceId),
        ]);
        const using = new Set([...workspaceIds].filter((ws) => (i.engine === 'custom' && i.scope.kind === 'dedicated' && i.scope.workspaceId === ws) || engines.choices(ws).some((c) => c.chosen?.id === id)));
        return [
            ...[...using].map((ws) => `workspace ${ws}`),
            ...sites.list().filter((x) => using.has(x.workspaceId) && ['running', 'starting', 'external'].includes(x.state)).map((x) => `site ${x.host} (workspace ${x.workspaceId})`),
            ...supervisor.list().filter((x) => using.has(x.workspaceId) && ['running', 'restarting'].includes(x.state)).map((x) => `process ${x.name} (workspace ${x.workspaceId})`),
        ];
    };
    let down: Promise<void> | null = null;

    return {
        sites,
        envelopeSites,
        engines,
        engineReconcile,
        envFiles,
        engineStatuses: () => engineStatusesOf(enginePorts),
        engineDependents: (id) => engineDependents(id),
        updateEngine: (id, options) => engines.update(id, {
            consent: options.consent,
            // At the moment the engine is stopped — after the image downloaded — the LIVE dependents against the reviewed ones.
            beforeStop: () => {
                const now = engineDependents(id);
                if (now.some((d) => !(options.approvedDependents ?? []).includes(d))) throw new Error('The engine’s dependents changed while its image was downloading; nothing was replaced. Review them and try again.');
            },
        }),
        hostingProblems: () => [...(input.problems ?? []), ...(input.liveStatusLink && !input.liveStatusLink.up() ? [LIVE_STATUS_PAUSED] : [])],
        startEngine: async (id) => {
            // The person wants it running: no longer stopped by them, even if Docker refuses (the refusal is the answer).
            if (engineStopped.delete(id)) await saveEngineStopped();
            await engines.start(id);
        },
        stopEngine: async (id) => {
            await engines.stop(id);
            engineStopped.add(id);
            await saveEngineStopped();
        },
        hibernationEngines: {
            toRelease: (workspaceId) => enginesToRelease({ workspaceId, instances: engines.list(), chosen: engineUse.chosen, workspaces: engineUse.workspaces() }),
            toResume: (workspaceId) => enginesToResume({ workspaceId, instances: engines.list(), chosen: engineUse.chosen, personStopped: engineStopped }),
            stop: (id) => engines.stop(id),
            start: (id) => engines.start(id),
        },
        removeEngine: async (id, options) => {
            await engines.remove(id, options);
            if (engineStopped.delete(id)) await saveEngineStopped();
        },
        frontDoor,
        trust: trust.api,
        frontDoorPort,
        browserTrust: () => {
            const opened = genCa();
            if (!opened.ca) return { caPem: null, reason: opened.error };
            // Read at each ask: a CA file that went away (a folder removed under a running Genie) is a reason, never a throw.
            try { return { caPem: readFileSync(opened.ca.certPath, 'utf8'), thumbprint: opened.ca.thumbprint }; } catch (error) { return { caPem: null, reason: `Genie’s certificate authority could not be read: ${message(error)}` }; }
        },
        get externalFrontDoor() { return frontDoorCtl.status(); },
        // The live-status line moves with the process helper's link: told like any other change Hosting shows.
        onFrontDoorChange: (listener) => {
            const offDoor = frontDoorCtl.onChange(listener);
            const offLink = input.liveStatusLink?.onChange(listener);
            return () => { offDoor(); offLink?.(); };
        },
        frontDoorSettled: frontDoorCtl.settled,
        syncHosts: frontDoorCtl.syncHosts,
        retryFrontDoor: frontDoorCtl.retry,
        trustCertificate: frontDoorCtl.trust,
        deferTrustCertificate: frontDoorCtl.deferTrust,
        routes,
        configuredHosts,
        trustDeckItems: () => frontDoorCtl.deckItems(),
        quiesce,
        drainEnvFiles,
        closeFrontDoor,
        closeTrust: () => trust.close(),
        settled,
        // Its own part only: supervised processes (the sites, Caddy) are the supervisor's owner's to stop.
        shutdown: () => down ??= (async () => {
            quiesce();
            await drainEnvFiles();
            await trust.close();
            await closeFrontDoor();
            await settled();
        })(),
    };
}
