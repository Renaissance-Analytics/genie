import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { browserWebSocketEnv, buildHostingDeps, initHosting, type HostingPorts } from '../hosting';
import { devSiteManager } from '../../dev-server/site-manager';
import { devServiceManager } from '../../dev-server/services/service-manager';
import { devLifecycle } from '../../dev-server/lifecycle';
import { makeTmpDir } from '../../../test/helpers';

/**
 * The host-owned HOSTING seam.
 *
 * Container hosting (dev sites + services + their lifecycle) is an agent ability,
 * so it belongs to the Host — not to the desktop shell that used to construct the
 * managers inline in `background.ts`, AFTER the `isHeadless()` bail (which made
 * hosting desktop-only and left the headless host unable to serve at all).
 *
 * `buildHostingDeps(ports)` is the pure heart of the seam: it maps ONE injected
 * port set into the three managers' dep objects. Proving that mapping here needs
 * no container runtime and no process-wide singletons — so it is the honest unit
 * to TDD. Both shells (desktop-backed, genie-cloud-backed) supply the ports; this
 * asserts the wiring is identical regardless of who backs them.
 */

function fakePorts(over: Partial<HostingPorts> = {}): HostingPorts {
    return {
        resolveRuntime: async () => ({ runtime: {} as never, detection: {} as never }),
        listWorkspaces: () => [],
        workspaceFor: () => null,
        devSitesFor: () => ({}),
        devServicesFor: () => ({}),
        engineAdmin: () => ({}) as never,
        devServiceEnvFor: () => ({}),
        devServiceHostEnvFor: () => ({}),
        onChanged: () => {},
        onSiteProgress: () => {},
        ...over,
    };
}

describe('buildHostingDeps — the host-core hosting seam', () => {
    it('injects the trusted WSS endpoint used by browser Echo clients', () => {
        expect(
            browserWebSocketEnv('Workspace A', {
                REVERB_APP_KEY: 'workspace_a',
                REVERB_HOST: '127.0.0.1',
                REVERB_PORT: '49123',
                REVERB_SCHEME: 'http',
            }),
        ).toMatchObject({
            VITE_REVERB_APP_KEY: 'workspace_a',
            VITE_REVERB_HOST: 'reverb.ws-workspace-a-3bbd1699.gen',
            VITE_REVERB_PORT: '443',
            VITE_REVERB_SCHEME: 'https',
        });
    });
    /**
     * genie#: a hosted `.gen` site could not open a WebSocket from the browser.
     *
     * The browser endpoint was injected into the SITE PROCESS env only. But
     * `VITE_*` is a BUILD-TIME substitution — `import.meta.env.VITE_REVERB_HOST`
     * becomes a literal string when `vite build` runs, and that build is a
     * SEPARATE process (an agent or a person in a terminal), which never sees a
     * site's env. A Laravel app served by `php artisan serve` therefore shipped
     * a bundle built from the `.env` FILE — where Genie wrote the loopback
     * backend address and nothing browser-facing at all.
     *
     * So the app had two reachable states and both were broken: keep the stock
     * `VITE_REVERB_HOST="${REVERB_HOST}"` and it expands from the very block
     * Genie writes, baking in `wss://127.0.0.1:<port>` where nothing terminates
     * TLS; delete it and the bundle bakes `wsHost: undefined`.
     *
     * The `.env` is the one source both a build and the server read, so it is
     * where the browser endpoint has to land.
     */
    it('writes the BROWSER wss endpoint into the repo .env — a vite build reads the FILE, never a site process env', () => {
        const root = makeTmpDir('envsync');
        fs.mkdirSync(path.join(root, 'repos', 'app'), { recursive: true });
        const envPath = path.join(root, 'repos', 'app', '.env');
        // The stock Laravel lines, which expand from the block Genie writes.
        fs.writeFileSync(
            envPath,
            'VITE_REVERB_HOST="${REVERB_HOST}"\nVITE_REVERB_PORT="${REVERB_PORT}"\nVITE_REVERB_SCHEME="${REVERB_SCHEME}"\n',
        );

        const d = buildHostingDeps(
            fakePorts({
                workspaceFor: () => ({ path: root }) as never,
                devSitesFor: () => ({ web: { repo: 'app' } }) as never,
                devServiceHostEnvFor: () => ({
                    REVERB_APP_KEY: 'workspace_a',
                    REVERB_HOST: '127.0.0.1',
                    REVERB_PORT: '49123',
                    REVERB_SCHEME: 'http',
                }),
            }),
        );

        d.services.onServiceEnvChanged?.('Workspace A');
        const written = fs.readFileSync(envPath, 'utf8');

        // The server-to-server path is unchanged: loopback, http. It is correct.
        expect(written).toContain('REVERB_HOST=127.0.0.1');
        expect(written).toContain('REVERB_SCHEME=http');
        // The BROWSER gets the TLS front door — rewritten IN PLACE over the stock
        // expansion, so no second copy can shadow it.
        expect(written).toContain('VITE_REVERB_HOST=reverb.ws-workspace-a-3bbd1699.gen');
        expect(written).toContain('VITE_REVERB_PORT=443');
        expect(written).toContain('VITE_REVERB_SCHEME=https');
        expect(written).toContain('VITE_REVERB_APP_KEY=workspace_a');
        expect(written).not.toContain('${REVERB_HOST}');
    });

    it('puts the browser endpoint in the env a runMode:host SITE receives, not just in the file', async () => {
        // `serviceHostEnvReportFor` is the HOST-NATIVE path — the env a site's own
        // dev server is spawned with. Asserted directly rather than inferred from
        // the call site, because "it is wired at line N" is not the same claim as
        // "the value comes out".
        //
        // NOTE, so nobody mistakes this for a guard on the wss fix: this path was
        // ALREADY correct before that fix, and this test passes on the old code
        // too. That IS the finding — the dev-server env was never the problem, so
        // a site running `npm run dev` always had the right endpoint. What was
        // broken is the BUILT bundle, which reads the `.env` FILE and never sees a
        // site's process env at all. The `.env` write is tested separately, and
        // that test is the one that goes red without the fix. Both paths, or only
        // one kind of site works.
        const ports = fakePorts({
            devServiceHostEnvFor: () => ({
                REVERB_APP_KEY: 'workspace_a',
                REVERB_HOST: '127.0.0.1',
                REVERB_PORT: '49123',
                REVERB_SCHEME: 'http',
            }),
        });
        // The closure reads the process-wide service manager, so stand one up —
        // this is the boot path a real host takes, not a shortcut around it.
        initHosting(ports);
        const report = await buildHostingDeps(ports).sites.serviceHostEnvReportFor!('Workspace A');

        expect(report.env).toMatchObject({
            VITE_REVERB_HOST: 'reverb.ws-workspace-a-3bbd1699.gen',
            VITE_REVERB_PORT: '443',
            VITE_REVERB_SCHEME: 'https',
            VITE_REVERB_APP_KEY: 'workspace_a',
        });
        // The server-to-server values ride along untouched: the site's PHP still
        // publishes to the engine on loopback over http, which is correct.
        expect(report.env.REVERB_HOST).toBe('127.0.0.1');
        expect(report.env.REVERB_SCHEME).toBe('http');
    });

    it('adds no browser endpoint when the workspace has no websocket service', async () => {
        // The positive control for the test above: if `browserWebSocketEnv` bolted
        // its keys on unconditionally, that test would pass on a workspace that has
        // no socket server at all, and every site would be told to dial a `.gen`
        // name nothing serves.
        const ports = fakePorts({ devServiceHostEnvFor: () => ({ DB_PORT: '5432' }) });
        initHosting(ports);
        const report = await buildHostingDeps(ports).sites.serviceHostEnvReportFor!('Workspace A');
        expect(report.env).toEqual({ DB_PORT: '5432' });
    });

    it('maps ports into the three managers so the SHELL supplies the DB reads, not the boot', () => {
        const ports = fakePorts();
        const d = buildHostingDeps(ports);
        // The DB-backed reads come straight from the ports — desktop backs them
        // with genie.db, genie-cloud with its own store; the seam is identical.
        expect(d.sites.devSitesFor).toBe(ports.devSitesFor);
        expect(d.services.devServicesFor).toBe(ports.devServicesFor);
        expect(d.services.engineAdmin).toBe(ports.engineAdmin);
        expect(d.lifecycle.workspaceFor).toBe(ports.workspaceFor);
        // ONE runtime resolver, shared by all three.
        expect(d.sites.resolveRuntime).toBe(ports.resolveRuntime);
        expect(d.services.resolveRuntime).toBe(ports.resolveRuntime);
        expect(d.lifecycle.resolveRuntime).toBe(ports.resolveRuntime);
    });

    it('probes SERVICES (no in-container check) but not SITES (they probe through Caddy already)', () => {
        const d = buildHostingDeps(fakePorts());
        expect(typeof d.services.probeReady).toBe('function');
        expect(d.sites.probeReady).toBeUndefined();
    });

    it('routes both managers change events to the ONE onChanged port, and site progress to onSiteProgress', () => {
        const onChanged = vi.fn();
        const onSiteProgress = vi.fn();
        const d = buildHostingDeps(fakePorts({ onChanged, onSiteProgress }));
        d.services.onChanged?.();
        d.sites.onChanged?.();
        expect(onChanged).toHaveBeenCalledTimes(2);
        d.sites.onProgress?.({} as never);
        expect(onSiteProgress).toHaveBeenCalledTimes(1);
    });

    it('gives the lifecycle lazy handles to the live managers (the Host owns the orchestration)', () => {
        const d = buildHostingDeps(fakePorts());
        expect(typeof d.lifecycle.sites).toBe('function');
        expect(typeof d.lifecycle.services).toBe('function');
    });

    it('wires openInBrowser only when the shell provides it (desktop yes; headless leaves it a no-op)', () => {
        const opener = vi.fn(async () => ({ ok: true }));
        expect(buildHostingDeps(fakePorts()).siteTools.openInBrowser).toBeUndefined();
        expect(buildHostingDeps(fakePorts({ openInBrowser: opener })).siteTools.openInBrowser).toBe(opener);
    });
});

describe('initHosting — stands the managers up from ports', () => {
    it('constructs the site + service + lifecycle managers and registers them process-wide', () => {
        // The exact path a shell boot relies on: after initHosting, the MCP tools
        // (which read the process-wide singletons) resolve a live manager. Before
        // this seam that only happened in the desktop boot; now any host does it.
        const handles = initHosting(fakePorts());
        expect(handles.sites).toBe(devSiteManager());
        expect(handles.services).toBe(devServiceManager());
        expect(handles.lifecycle).toBe(devLifecycle());
        expect(devSiteManager()).not.toBeNull();
        expect(devServiceManager()).not.toBeNull();
        expect(devLifecycle()).not.toBeNull();
    });
});

/**
 * THE `.env` WRITE, END TO END (genie#242).
 *
 * The seam is where the two halves meet: the service manager knows a workspace's
 * connection has moved, and the site config knows which repos that workspace's
 * apps live in. Neither knows the other, so the wiring is here — and it is worth
 * asserting against a REAL file, because every interesting property of this fix
 * (the user's edits survive, a moved port is rewritten in place, a second write
 * changes nothing) is a property of bytes on a disk.
 */
describe('a workspace service connection lands in the repo .env', () => {
    function workspaceWithRepo(name: string): { root: string; envPath: string } {
        const root = makeTmpDir(`hosting-env-${name}`);
        fs.mkdirSync(path.join(root, 'repos', 'tynn'), { recursive: true });
        return { root, envPath: path.join(root, 'repos', 'tynn', '.env') };
    }

    function portsFor(root: string, hostEnv: Record<string, string>): HostingPorts {
        return fakePorts({
            workspaceFor: () => ({ id: 'a', path: root, label: 'a' }),
            devSitesFor: () => ({
                s1: { name: 'web', genName: 'web.gen', repo: 'tynn', runMode: 'host' } as never,
            }),
            devServiceHostEnvFor: () => hostEnv,
        });
    }

    it("writes the app's connection into the site repo's .env", () => {
        const { root, envPath } = workspaceWithRepo('write');
        const d = buildHostingDeps(portsFor(root, { DB_PORT: '58377', DB_HOST: '127.0.0.1', PGPORT: '58377' }));

        d.services.onServiceEnvChanged?.('a');

        const content = fs.readFileSync(envPath, 'utf8');
        expect(content).toContain('DB_PORT=58377');
        expect(content).toContain('DB_HOST=127.0.0.1');
        // The client-tool names are a shell's business, not an app's.
        expect(content).not.toContain('PGPORT');
        // A file about to hold a service password is never committable.
        expect(fs.readFileSync(path.join(root, 'repos', 'tynn', '.gitignore'), 'utf8')).toContain('.env');
    });

    it("moves the port in a hand-edited .env and leaves everything else alone", () => {
        // The reported failure: live Postgres on 58377, the file still saying
        // 51157 — in a file the user owns, with their own keys around it.
        const { root, envPath } = workspaceWithRepo('moved');
        fs.writeFileSync(envPath, '# mine\nAPP_KEY=base64:xyz\nDB_PORT=51157\nMY_OWN=keep\n');
        const d = buildHostingDeps(portsFor(root, { DB_PORT: '58377' }));

        d.services.onServiceEnvChanged?.('a');

        expect(fs.readFileSync(envPath, 'utf8')).toBe(
            '# mine\nAPP_KEY=base64:xyz\nDB_PORT=58377\nMY_OWN=keep\n',
        );
    });

    it('a repeat announcement does not touch the file', () => {
        const { root, envPath } = workspaceWithRepo('idem');
        const d = buildHostingDeps(portsFor(root, { DB_PORT: '58377' }));
        d.services.onServiceEnvChanged?.('a');
        const mtime = fs.statSync(envPath).mtimeMs;

        d.services.onServiceEnvChanged?.('a');

        expect(fs.statSync(envPath).mtimeMs).toBe(mtime);
    });
});

/**
 * genie#407 — the seam that makes a stop survive the launch, and the wiring that
 * makes it exist at all.
 *
 * `siteRunState` is OPTIONAL on the ports, because a host that has not adopted
 * it must still compile. That is also its danger: an unwired port is not a type
 * error and not a test failure anywhere else — the manager simply forgets every
 * stop, silently, and the bug this fixes comes straight back looking exactly
 * like it did before. So both halves are pinned: the mapping here, and the
 * desktop shell actually supplying it.
 */
describe('the desired run state reaches the site manager (genie#407)', () => {
    it('forwards the port to the manager as `runState`', () => {
        const calls: Array<[string, boolean]> = [];
        const d = buildHostingDeps(
            fakePorts({
                siteRunState: {
                    setStopped: (siteId, stopped) => calls.push([siteId, stopped]),
                    isStopped: (siteId) => siteId === 'already-stopped',
                },
            }),
        );

        expect(d.sites.runState).toBeDefined();
        d.sites.runState!.setStopped('site-1', true);
        expect(calls).toEqual([['site-1', true]]);
        expect(d.sites.runState!.isStopped('already-stopped')).toBe(true);
        expect(d.sites.runState!.isStopped('site-1')).toBe(false);
    });

    it('omits it when the host does not supply one — the pre-#407 behaviour, intact', () => {
        expect(buildHostingDeps(fakePorts()).sites.runState).toBeUndefined();
    });

    it('the DESKTOP shell supplies it, backed by genie.db', () => {
        // Not reachable from a unit test: `background.ts` builds the port set
        // inside a 2000-line Electron boot. An unwired port compiles, every test
        // stays green, and every stop is forgotten — the precise shape of the
        // failure being fixed, so it is pinned at the source.
        const boot = fs.readFileSync(path.join(__dirname, '..', '..', 'background.ts'), 'utf8');
        const wiring = boot.slice(boot.indexOf('siteRunState:'), boot.indexOf('siteRunState:') + 400);

        expect(boot).toContain('siteRunState:');
        expect(wiring).toContain('setSiteStoppedByUser');
        expect(wiring).toContain('isSiteStoppedByUser');
    });
});
