/**
 * Hosting Manager E2E harness — a deterministic stand-in for the container
 * layer, gated on `GENIE_E2E_HOSTING=1`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Hosting Manager's backend is Docker. A CI runner has no Docker (and the
 * macOS runner cannot have it), so an E2E spec that waited for a real container
 * would either be skipped everywhere or be a flake generator. The container
 * FUNCTION is proven separately against a real runtime; what E2E is for here is
 * the half unit tests structurally cannot reach — the RUNNING renderer: does
 * the workstation page paint what the machine reports, does a tab switch really
 * swap the list, does a destructive stop ask before it fires, does the panel
 * re-read when main pushes, does the add-a-site picker keep the port in step
 * with the option.
 *
 * So this module answers the six `dev:*` IPC channels the two Hosting surfaces
 * call, from an in-memory fixture a spec can rewrite. Every judgement under
 * test — `runtimeDiagnostics`, `engineGroups`, `stopEngineWarning`,
 * `engineActionAvailability`, `holdersNote`, `optionLabel` — runs on REAL
 * payloads of the shape `main/dev-server/workstation.ts` and
 * `runManageSite` / `runManageService` produce, so the components see exactly
 * what production hands them.
 *
 * HOW IT'S WIRED
 * --------------
 * `registerE2EMocks()` (mock.ts) calls {@link registerHostingE2EMocks} when
 * {@link isE2EHosting} is true — i.e. ONLY for the hosting spec's launch. Every
 * other E2E spec keeps the real `dev:*` handlers, so this can never mask a
 * hosting regression for a suite that isn't looking at hosting.
 *
 * HOW A TEST SCRIPTS IT
 * ---------------------
 * Through `globalThis.__GENIE_E2E_HOSTING__` from the MAIN process
 * (`electronApp.evaluate`): read `state` / `calls`, call `runtimeUnavailable()`
 * to take the container runtime away mid-session, `reset()` between tests, and
 * `notifyChanged()` to fire the REAL `dev-server:changed` broadcast the
 * renderer subscribes to — which is how the spec proves the surfaces are
 * push-driven rather than frozen at mount.
 *
 * Types are re-declared here rather than imported from the renderer for the
 * same reason `renderer/lib/genie.ts` re-declares them: neither side reaches
 * into the other. They mirror `DevWorkstationInfo`, `DevSiteInfo`,
 * `DevServiceInfo` and friends field for field.
 */

import { ipcMain } from 'electron';
import { broadcastDevServerChanged } from '../ipc';
import type { ToolUpdate } from '../dev-server/toolchain-updates';

/** True only when the Hosting Manager harness was requested. */
export function isE2EHosting(): boolean {
    return process.env.GENIE_E2E === '1' && process.env.GENIE_E2E_HOSTING === '1';
}

// --- the payload shapes (mirrors of the renderer's Dev* types) --------------

interface RuntimeProbe {
    kind: string;
    installed: boolean;
    running: boolean;
    version?: string;
    detail?: string;
}

interface WorkstationInfo {
    runtime: {
        kind: string;
        version?: string;
        installHint?: string;
        reason?: string;
        probes: RuntimeProbe[];
    };
    devBase: {
        image: string;
        installed: boolean;
        toolchain: Array<{
            id: string;
            label: string;
            version: string;
            source: string;
            extras?: string[];
        }>;
    };
    engines: EngineInfo[];
}

interface EngineInfo {
    recordKey: string;
    engineKey: string;
    engine: string;
    version: string;
    label: string;
    summary: string;
    provision: string;
    image: string;
    containerName: string;
    installed: boolean;
    state: 'running' | 'stopped' | 'absent';
    dedicated: boolean;
    holders: number;
    configured: number;
    workspaces: string[];
}

interface SiteInfo {
    id: string;
    name: string;
    genName: string;
    repo: string;
    runMode: string;
    kind: 'http' | 'tcp';
    enabled: boolean;
    state: string;
    ready?: boolean;
    port?: number;
    hostPort?: number;
    origin?: string;
    localOrigin?: string;
    command?: string[];
    hostServe?: { mode: 'static' | 'php'; root: string; spa?: boolean; version?: string };
    browserExposed?: boolean;
}

interface RunOption {
    runMode: string;
    stack?: string;
    source: string;
    reason: string;
    command?: string[];
    port?: number;
    confident: boolean;
    needs?: string;
}

interface ServiceInfo {
    id: string;
    engine: string;
    version: string;
    engineKey: string;
    dedicated: boolean;
    enabled: boolean;
    state: string;
    ready?: boolean;
    holders?: number;
    endpoints?: Array<{
        name: string;
        kind: 'http' | 'tcp';
        host: string;
        port: number;
        hostPort?: number;
        localAddress?: string;
    }>;
    envKeys?: string[];
}

interface CatalogEntry {
    engine: string;
    label: string;
    summary: string;
    versions: string[];
    defaultVersion?: string;
    shared: boolean;
    provision: string;
}

export interface HostingE2EState {
    workstation: WorkstationInfo;
    sites: SiteInfo[];
    services: ServiceInfo[];
    catalog: CatalogEntry[];
    repos: string[];
    /** What `dev:site` `detect` offers — the add-a-site picker's rows. */
    runOptions: RunOption[];
    /**
     * Every action that reached main, in order (`stop:postgres-16`).
     *
     * The confirm-before-a-destructive-stop test asserts on ABSENCE here: a
     * dialog that renders and fires anyway looks identical on screen to one
     * that waits, and only the call log tells them apart.
     */
    calls: {
        workstation: number;
        engine: string[];
        site: string[];
        service: string[];
        /** Tools whose Update was clicked, in order (Toolchain Manager, #242 P2). */
        toolchainUpdate: string[];
        /** `<tool>:<version>` per Set-default that reached main (Toolchain page). */
        toolchainSetDefault: string[];
        /** `<tool>:<version>` per Remove that reached main (Toolchain page). */
        toolchainRemove: string[];
    };
    /** The Dev Tools section's update rows (#242 P2). */
    toolchainUpdates: ToolUpdate[];
    /** The Toolchain page's Languages tab: what this "machine" has installed. */
    toolchainInstalls: ToolchainInstallsFixture;
}

/** Mirrors `ToolchainInstallsInfo` from the toolchain manager, restated here so
 *  the harness stays a plain fixture with no import into the real scanner. */
interface ToolchainInstallsFixture {
    installs: Array<{
        tool: string;
        version: string;
        dir: string;
        exe: string;
        source: string;
        removable: boolean;
        sizeBytes?: number;
    }>;
    defaults: Record<string, string>;
    addable: Record<string, string[]>;
    sites: Array<{ genName: string; tool: string; version?: string }>;
    root: string;
}

// --- the fixture ------------------------------------------------------------

/** The workspace names holding the shared Postgres — named, because the stop
 *  warning has to say WHO it takes down, not just how many. */
const PG_HOLDERS = ['Tynn', 'Guardian', 'Hosting E2E'];

function runningDockerRuntime(): WorkstationInfo['runtime'] {
    return {
        kind: 'docker',
        version: '27.1.1',
        probes: [
            { kind: 'docker', installed: true, running: true, version: '27.1.1' },
            {
                kind: 'podman',
                installed: false,
                running: false,
                detail: 'podman: command not found',
            },
        ],
    };
}

/**
 * INSTALLED but not running — deliberately not "not installed".
 *
 * They need opposite advice, and telling someone to install what they already
 * have is the failure `runtimeDiagnostics` splits them to avoid. The spec
 * asserts the sentence that distinguishes them.
 */
function stoppedDockerRuntime(): WorkstationInfo['runtime'] {
    return {
        kind: 'none',
        reason: 'not-running',
        installHint:
            'Docker is installed but its engine is not running — start Docker Desktop and it will be picked up.',
        probes: [
            {
                kind: 'docker',
                installed: true,
                running: false,
                detail: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
            },
            {
                kind: 'podman',
                installed: false,
                running: false,
                detail: 'podman: command not found',
            },
        ],
    };
}

/**
 * A machine with one engine in each of the three states the page groups by.
 * Every pair of (image on disk / container up / workspaces holding it) occurs
 * in practice, so the fixture covers one of each rather than three shades of
 * running: Postgres up and SHARED (the row with a hazard), Redis pulled but
 * down, MySQL not here at all.
 */
export function defaultHostingE2EState(): HostingE2EState {
    return {
        workstation: {
            runtime: runningDockerRuntime(),
            devBase: {
                image: 'ghcr.io/wishborn/genie-dev-base:1',
                installed: true,
                toolchain: [
                    {
                        id: 'node',
                        label: 'Node',
                        version: '22.11.0',
                        source: 'Dockerfile ARG NODE_VERSION',
                        extras: ['npm 10', 'pnpm 9'],
                    },
                    {
                        id: 'php',
                        label: 'PHP',
                        version: '8.3',
                        source: 'Dockerfile ARG PHP_VERSION',
                        extras: ['composer 2'],
                    },
                    {
                        id: 'python',
                        label: 'Python',
                        version: '3.12',
                        source: 'Debian bookworm',
                    },
                ],
            },
            engines: [
                {
                    recordKey: 'postgres-16',
                    engineKey: 'postgres-16',
                    engine: 'postgres',
                    version: '16',
                    label: 'Postgres',
                    summary: 'The relational database most stacks default to.',
                    provision: 'sql-database-role',
                    image: 'postgres:16-alpine',
                    containerName: 'genie-postgres-16',
                    installed: true,
                    state: 'running',
                    dedicated: false,
                    holders: PG_HOLDERS.length,
                    configured: PG_HOLDERS.length,
                    workspaces: [...PG_HOLDERS],
                },
                {
                    recordKey: 'redis-7',
                    engineKey: 'redis-7',
                    engine: 'redis',
                    version: '7',
                    label: 'Redis',
                    summary: 'Cache, queue and session store.',
                    provision: 'redis-acl',
                    image: 'redis:7-alpine',
                    containerName: 'genie-redis-7',
                    installed: true,
                    state: 'stopped',
                    dedicated: false,
                    holders: 0,
                    configured: 1,
                    workspaces: ['Hosting E2E'],
                },
                {
                    recordKey: 'mysql-8',
                    engineKey: 'mysql-8',
                    engine: 'mysql',
                    version: '8',
                    label: 'MySQL',
                    summary: 'The other relational database.',
                    provision: 'sql-database-role',
                    image: 'mysql:8',
                    containerName: 'genie-mysql-8',
                    installed: false,
                    state: 'absent',
                    dedicated: false,
                    holders: 0,
                    configured: 0,
                    workspaces: [],
                },
            ],
        },
        // The workspace hosts NOTHING yet: the empty state + the add-a-site
        // flow are the first thing a real user meets, and the flow that has
        // somewhere to go wrong.
        sites: [],
        services: [
            {
                id: 'svc-pg',
                engine: 'postgres',
                version: '16',
                engineKey: 'postgres-16',
                dedicated: false,
                enabled: true,
                state: 'running',
                ready: true,
                holders: PG_HOLDERS.length,
                endpoints: [
                    {
                        name: 'postgres',
                        kind: 'tcp',
                        host: 'genie-postgres-16',
                        port: 5432,
                        hostPort: 55432,
                        localAddress: '127.0.0.1:55432',
                    },
                ],
                envKeys: ['DATABASE_URL', 'PGHOST', 'PGDATABASE'],
            },
        ],
        catalog: [
            {
                engine: 'postgres',
                label: 'Postgres',
                summary: 'The relational database most stacks default to.',
                versions: ['16', '15'],
                defaultVersion: '16',
                shared: true,
                provision: 'sql-database-role',
            },
            {
                engine: 'redis',
                label: 'Redis',
                summary: 'Cache, queue and session store.',
                versions: ['7'],
                defaultVersion: '7',
                shared: true,
                provision: 'redis-acl',
            },
            {
                engine: 'mailpit',
                label: 'Mailpit',
                summary: 'Catches the mail your app sends.',
                versions: ['1'],
                defaultVersion: '1',
                shared: true,
                provision: 'namespace',
            },
        ],
        repos: ['genie', 'tynn'],
        // Two options with DIFFERENT ports, and the second not confident — the
        // picker has to move the port when the choice moves, and has to say
        // what it guessed. Both are silent, plausible-looking failures.
        runOptions: [
            {
                runMode: 'dockerfile',
                stack: 'node',
                source: 'Dockerfile',
                reason: 'The repo ships a Dockerfile — Genie builds it and runs what it defines.',
                command: ['node', 'server.js'],
                port: 8000,
                confident: true,
            },
            {
                runMode: 'explicit',
                stack: 'php',
                source: 'composer.json',
                reason: 'A Laravel app — served by FrankenPHP the way it runs in production.',
                command: ['frankenphp', 'php-server', '--root', 'public'],
                port: 3000,
                confident: false,
                needs: 'the port was defaulted rather than read from the repo',
            },
        ],
        calls: {
            workstation: 0,
            engine: [],
            site: [],
            service: [],
            toolchainUpdate: [],
            toolchainSetDefault: [],
            toolchainRemove: [],
        },
        // The Toolchain page's Languages tab. Deliberately the machine that
        // caused genie#206: Genie owns two PHPs under its own toolchain folder
        // AND Herd has a third one level down in `bin/php84`. The foreign row
        // must render as informational — no Set default, no Remove — or a site
        // could be pointed at an install another app upgrades underneath it.
        toolchainInstalls: {
            root: 'C:\\Users\\e2e\\AppData\\Roaming\\Genie\\toolchain',
            installs: [
                {
                    tool: 'php',
                    version: '8.3.33',
                    dir: 'C:\\Users\\e2e\\AppData\\Roaming\\Genie\\toolchain\\php\\8.3.33',
                    exe: 'C:\\Users\\e2e\\AppData\\Roaming\\Genie\\toolchain\\php\\8.3.33\\php.exe',
                    source: 'genie',
                    removable: true,
                    sizeBytes: 94_371_840,
                },
                {
                    tool: 'php',
                    version: '8.2.33',
                    dir: 'C:\\Users\\e2e\\AppData\\Roaming\\Genie\\toolchain\\php\\8.2.33',
                    exe: 'C:\\Users\\e2e\\AppData\\Roaming\\Genie\\toolchain\\php\\8.2.33\\php.exe',
                    source: 'genie',
                    removable: true,
                    sizeBytes: 92_274_688,
                },
                {
                    tool: 'php',
                    version: '8.4.1',
                    dir: 'C:\\Users\\e2e\\.config\\herd\\bin\\php84',
                    exe: 'C:\\Users\\e2e\\.config\\herd\\bin\\php84\\php.exe',
                    source: 'herd',
                    removable: false,
                },
            ],
            defaults: { php: '8.3.33' },
            addable: { php: ['8.4.24'], node: ['26.7.0', '24.19.0'] },
            // One site follows the default and one pins — so a default change
            // must name the first and leave the second alone.
            sites: [
                { genName: 'web.hosting-e2e.gen', tool: 'php' },
                { genName: 'api.hosting-e2e.gen', tool: 'php', version: '8.2.33' },
            ],
        },
        // Dev Tools (#242 P2): one tool with an update, one current, one whose
        // latest could not be learned — the three tones the row model renders.
        toolchainUpdates: [
            {
                name: 'git',
                installed: '2.40.0',
                latest: '2.45.0',
                updateAvailable: true,
                source: 'package-manager',
                // A FOREIGN install (genie#213). The machine this fixture
                // describes has a git winget put there, which the page must show
                // as detected-but-not-managed rather than as one of its own —
                // the same treatment a Herd php gets on the Languages tab.
                origin: {
                    managedByGenie: false,
                    source: 'winget',
                    directory: 'C:\Users\dev\AppData\Local\Microsoft\WinGet\Links',
                },
            },
            {
                name: 'node',
                installed: '22.11.0',
                latest: '22.11.0',
                updateAvailable: false,
                source: 'version-index',
            },
            {
                name: 'docker',
                installed: '27.1.1',
                updateAvailable: false,
                source: 'unknown',
                // Genie's OWN install, so this one is managed. Paired with the
                // winget git above so a spec can prove the page tells them apart
                // rather than labelling everything the same way.
                origin: {
                    managedByGenie: true,
                    source: 'genie',
                    directory: 'C:\Users\dev\AppData\Roaming\genie\toolchain\docker\bin',
                },
            },
            // NOT INSTALLED — the state that used to render a row saying so and
            // offering nothing to do about it (genie#212). One per tab, because
            // the Install button has to exist on both.
            { name: 'composer', updateAvailable: false, source: 'unknown' },
            { name: 'claude-code', updateAvailable: false, source: 'unknown' },
        ],
    };
}

/** The live scriptable state (only meaningful under GENIE_E2E_HOSTING). */
export let hostingE2EState: HostingE2EState = defaultHostingE2EState();

// --- the IPC surface --------------------------------------------------------

interface SiteRequest {
    action: string;
    id?: string;
    name?: string;
    repo?: string;
    runMode?: string;
    command?: string[];
    port?: number;
    hostServe?: { mode: 'static' | 'php'; root: string; spa?: boolean; version?: string } | null;
    browserExposed?: boolean;
}

interface ServiceRequest {
    action: string;
    id?: string;
    engine?: string;
    dedicated?: boolean;
}

interface EngineRequest {
    recordKey: string;
    action: 'start' | 'stop' | 'logs' | 'install';
}

/**
 * Override-register the six `dev:*` channels the Hosting surfaces call.
 *
 * Same override discipline as the GitHub mock: `removeHandler` first, so this
 * wins regardless of registration order, and the real handlers stay untouched
 * for every launch that did not ask for this harness.
 */
export function registerHostingE2EMocks(): void {
    publishHandle();

    const override: typeof ipcMain.handle = (channel, listener) => {
        ipcMain.removeHandler(channel as string);
        ipcMain.handle(channel as string, listener as never);
    };

    override('dev:workstation', async () => {
        hostingE2EState.calls.workstation += 1;
        return hostingE2EState.workstation;
    });

    override('dev:runtime-status', async () => {
        const { runtime } = hostingE2EState.workstation;
        return {
            kind: runtime.kind,
            ...(runtime.version ? { version: runtime.version } : {}),
            ...(runtime.installHint ? { installHint: runtime.installHint } : {}),
        };
    });

    override('dev:repos', async () => hostingE2EState.repos);

    // Dev Tools section (#242 P2). The read is deterministic here (the real one
    // shells out to `<pm> outdated`); an Update records the tool and reflects it
    // as now-current, so a spec can assert the button reached main AND the row
    // repainted — without installing anything on the runner.
    override('toolchain:updates', async () => hostingE2EState.toolchainUpdates);

    override('toolchain:update', async (_e, tool: string) => {
        hostingE2EState.calls.toolchainUpdate.push(tool);
        const row = hostingE2EState.toolchainUpdates.find((u) => u.name === tool);
        if (row) {
            row.updateAvailable = false;
            // An INSTALL lands a version where there was none; an update moves an
            // existing one to latest. Both end with the row naming what is now on
            // the machine, which is what lets a spec prove the button did
            // something rather than merely being clickable.
            if (!row.installed) row.installed = row.latest ?? '1.0.0';
            else if (row.latest) row.installed = row.latest;
        }
        return {
            ok: true,
            results: [{ tool, status: 'succeeded' as const }],
            restartRequired: false,
            skipped: [],
        };
    });

    // The Toolchain page's Languages tab. The real read walks
    // `<userData>/toolchain` and Herd/XAMPP/nvm; here it is a fixture, so the
    // spec drives the SHIPPED component against a machine that has both a
    // Genie-owned php and a Herd one — the case the page exists to disambiguate.
    override('toolchain:installs', async () => hostingE2EState.toolchainInstalls);

    override('toolchain:set-default', async (_e, tool: string, version: string) => {
        hostingE2EState.calls.toolchainSetDefault.push(`${tool}:${version}`);
        const owned = hostingE2EState.toolchainInstalls.installs.some(
            (i) => i.tool === tool && i.version === version && i.source === 'genie',
        );
        // Same refusal as the real handler: only a GENIE-managed install can be
        // the default, so a spec can prove a foreign row offers no way in.
        if (!owned) return { ok: false, error: `Genie does not manage ${tool} ${version}.` };
        hostingE2EState.toolchainInstalls.defaults[tool] = version;
        return { ok: true };
    });

    override('toolchain:remove-version', async (_e, tool: string, version: string) => {
        hostingE2EState.calls.toolchainRemove.push(`${tool}:${version}`);
        const fixture = hostingE2EState.toolchainInstalls;
        const target = fixture.installs.find((i) => i.tool === tool && i.version === version);
        if (!target || target.source !== 'genie') {
            return { ok: false, error: `Genie did not install ${tool} ${version}.` };
        }
        fixture.installs = fixture.installs.filter((i) => i !== target);
        return { ok: true, freedBytes: target.sizeBytes };
    });

    override('dev:engine', async (_e, req: EngineRequest) => {
        hostingE2EState.calls.engine.push(`${req.action}:${req.recordKey}`);
        const engine = hostingE2EState.workstation.engines.find(
            (row) => row.recordKey === req.recordKey,
        );
        if (!engine) return { ok: false, error: `no engine ${req.recordKey}` };
        // Pre-install (#242 P3): the image lands on this machine and NOTHING
        // starts — a pulled image is not a running engine.
        if (req.action === 'install') {
            engine.installed = true;
            return { ok: true };
        }
        if (req.action === 'logs') {
            return { ok: true, logs: `${engine.containerName}: ready to accept connections\n` };
        }
        if (req.action === 'stop') {
            engine.state = 'stopped';
            engine.holders = 0;
        } else {
            engine.state = 'running';
            engine.holders = Math.max(engine.holders, engine.configured);
        }
        return { ok: true };
    });

    override('dev:site', async (_e, _workspaceId: string, req: SiteRequest) => {
        hostingE2EState.calls.site.push(req.action);
        const sites = hostingE2EState.sites;
        const row = req.id ? sites.find((s) => s.id === req.id) : undefined;
        switch (req.action) {
            case 'detect':
                return { ok: true, sites, options: hostingE2EState.runOptions };
            case 'create': {
                const name = req.name ?? 'web';
                // Mirror production's DEV-NATIVE-FIRST create: with no runMode /
                // command / image the backend runs the repo's own dev server on
                // the HOST (`runMode: 'host'`), not a built container. A recipe
                // runMode is the opt-in, and only reaches here when the human
                // chose the production-build picker.
                // A Genie-served (static/php) site is host-native and carries its
                // serve mode; mirrors runManageSite forcing runMode:'host' on hostServe.
                const runMode = req.hostServe ? 'host' : (req.runMode ?? 'host');
                const created: SiteInfo = {
                    id: `site-${name}`,
                    name,
                    genName: `${name}.hosting-e2e.gen`,
                    repo: req.repo ?? '',
                    runMode,
                    kind: 'http',
                    enabled: true,
                    state: 'running',
                    ready: true,
                    port: req.port ?? 8000,
                    hostPort: 49001,
                    origin: `https://${name}.hosting-e2e.gen`,
                    localOrigin: 'http://127.0.0.1:49001',
                    ...(req.command ? { command: req.command } : {}),
                    ...(req.hostServe ? { hostServe: req.hostServe } : {}),
                };
                sites.push(created);
                return { ok: true, sites, affectedId: created.id };
            }
            case 'start':
            case 'restart':
                if (row) {
                    row.state = 'running';
                    row.ready = true;
                }
                return { ok: true, sites, ...(row ? { affectedId: row.id } : {}) };
            case 'stop':
                if (row) {
                    row.state = 'stopped';
                    row.ready = false;
                }
                return { ok: true, sites, ...(row ? { affectedId: row.id } : {}) };
            case 'update':
                if (row) {
                    if (req.name !== undefined) row.name = req.name;
                    if (req.runMode !== undefined) row.runMode = req.runMode;
                    if (req.port !== undefined) row.port = req.port;
                    if (req.command !== undefined) row.command = req.command;
                    if (req.browserExposed !== undefined) row.browserExposed = req.browserExposed;
                    // Serve mode: null CLEARS (back to proxy), a config SETS it (and
                    // makes the site host-native), undefined leaves it — mirrors main.
                    if (req.hostServe !== undefined) {
                        if (req.hostServe === null) delete row.hostServe;
                        else {
                            row.hostServe = req.hostServe;
                            row.runMode = 'host';
                        }
                    }
                }
                return { ok: true, sites, ...(row ? { affectedId: row.id } : {}) };
            case 'logs':
                return {
                    ok: true,
                    sites,
                    affectedId: req.id,
                    logs: 'build: done\nserver: listening\n',
                };
            case 'remove':
                hostingE2EState.sites = sites.filter((s) => s.id !== req.id);
                return { ok: true, sites: hostingE2EState.sites };
            default:
                return { ok: true, sites };
        }
    });

    override('dev:service', async (_e, _workspaceId: string, req: ServiceRequest) => {
        hostingE2EState.calls.service.push(req.action);
        const services = hostingE2EState.services;
        const row = req.id ? services.find((s) => s.id === req.id) : undefined;
        const base = { ok: true, services, catalog: hostingE2EState.catalog };
        switch (req.action) {
            case 'connection':
                return {
                    ...base,
                    env: {
                        DATABASE_URL: 'postgres://hosting_e2e@genie-postgres-16:5432/hosting_e2e',
                        PGHOST: 'genie-postgres-16',
                    },
                };
            case 'logs':
                return {
                    ...base,
                    affectedId: req.id,
                    logs: 'database system is ready to accept connections\n',
                };
            case 'start':
                if (row) {
                    row.state = 'running';
                    row.ready = true;
                }
                return base;
            case 'stop':
                if (row) {
                    row.state = 'stopped';
                    row.ready = false;
                }
                return base;
            case 'dedicated':
                if (row) row.dedicated = !!req.dedicated;
                return base;
            case 'remove':
                hostingE2EState.services = services.filter((s) => s.id !== req.id);
                return { ...base, services: hostingE2EState.services };
            default:
                return base;
        }
    });
}

/**
 * The spec's handle on main. `runtimeUnavailable` is the one scenario switch:
 * it takes the container runtime away WITHOUT a reload, so the spec can prove
 * the page repaints from the `dev-server:changed` push rather than only at
 * mount — a frozen surface is invisible in a screenshot and fatal in use.
 */
function publishHandle(): void {
    (globalThis as Record<string, unknown>).__GENIE_E2E_HOSTING__ = {
        get state() {
            return hostingE2EState;
        },
        reset(): void {
            hostingE2EState = defaultHostingE2EState();
        },
        runtimeUnavailable(): void {
            hostingE2EState.workstation.runtime = stoppedDockerRuntime();
        },
        /** Fire the REAL broadcast every hosting surface subscribes to. */
        notifyChanged(): void {
            broadcastDevServerChanged();
        },
    };
}
