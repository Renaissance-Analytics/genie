import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ENGINE_METHODS } from '../src/core/engine-protocol.js';
import { REMOTE_METHODS, capabilityOf, type RemoteMethod } from '../src/core/remote-protocol.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { HOST_ALONE_METHODS } from '../src/main/host-alone-api.js';
import { hostWindowView, readWindowView, v1DatabaseFrom, type HostWindowView } from '../src/main/host-window-view.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';

/*
 * CLIENT/HOST SPLIT STEP 2g-4d B (Tynn #1044; part of #955). Three things genie-host does for itself now, which it took from
 * this machine's window before:
 *   1. THE BUG: an agent's service variables (DB_URL and the rest) came only from the window. Each engine.start carried the
 *      window's `serviceEnvFor`, the engine server kept it per workspace and genie-host used that copy, so an agent started
 *      with no window connected (or before one did) got none. genie-host now computes them from its own engines.
 *   2. Genie 1's import: genie-host finds Genie 1's database itself, from the userData it was launched with.
 *   3. The window view: genie-host names its workspaces itself; main's own client says only whether the person is active,
 *      on a local, own-only `window.view`. The engine link's engine.windowView and engine.v1Import go.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const VIEW = 'window.view' as RemoteMethod;

describe('1. an agent’s service env is genie-host’s own', () => {
    it('with NO window connected, an agent gets its workspace’s service env, from the host’s own engines (the bug)', () => {
        const hostEnv = vi.fn((workspaceId: string) => ({ DB_URL: `postgres://db/${workspaceId}` }));
        const server = new SessionEngineServer({ token: 't', build: 'b', serviceEnvFor: hostEnv });
        expect(server.hostOptions().serviceEnvFor('ws_a')).toEqual({ DB_URL: 'postgres://db/ws_a' });
        expect(server.serviceEnvFor('ws_a')).toEqual({ DB_URL: 'postgres://db/ws_a' });
        expect(hostEnv).toHaveBeenCalledWith('ws_a');
    });

    it('CONTROL: a server given none answers an empty env, as before', () => {
        expect(new SessionEngineServer({ token: 't', build: 'b' }).serviceEnvFor('ws_a')).toEqual({});
    });

    it('no window’s env is kept or used: engine.start no longer stores one, and the window sends none', () => {
        const server = code(src('src/main/session-engine-server.ts'));
        expect(server).not.toMatch(/#env\b/);
        const client = code(src('src/main/session-engine-client.ts'));
        expect(client).not.toMatch(/serviceEnvFor/);
        expect(code(src('src/main/main.ts'))).not.toMatch(/serviceEnvFor|engines\.envFor/);
    });

    it('wired: genie-host hands its engine server its own engines’ env', () => {
        expect(code(src('src/main/genie-host.ts'))).toMatch(/serviceEnvFor: \(workspaceId\) => hostingStack\?\.engines\.envFor\(workspaceId\) \?\? \{\},/);
    });
});

describe('2. Genie 1’s import is genie-host’s, at its own boot', () => {
    it('Genie 1’s database is found from the userData the window launched it with; none given, none', () => {
        expect(v1DatabaseFrom({ GENIE_V1_USERDATA: '/home/u/.config/Genie' })).toBe(join('/home/u/.config/Genie', 'genie.db'));
        expect(v1DatabaseFrom({})).toBeNull();
        expect(v1DatabaseFrom({ GENIE_V1_USERDATA: '' })).toBeNull();
    });

    it('the same file the window used to name: its userData’s genie.db', () => {
        expect(code(src('src/main/main.ts'))).toMatch(/GENIE_V1_USERDATA: app\.getPath\('userData'\)/);
    });

    it('wired: genie-host opens its kept processes and flows at its own boot, with Genie 1’s data when found, and the engine link no longer carries it', () => {
        const host = code(src('src/main/genie-host.ts'));
        expect(host).toMatch(/void importFromV1\(v1DatabaseFrom\(process\.env\)\);/);
        // After both are defined: called before, a const not yet made throws at boot.
        const call = host.indexOf('void importFromV1(v1DatabaseFrom(process.env));');
        expect(call).toBeGreaterThan(host.indexOf('const openFlows = (databasePath: string | null)'));
        expect(call).toBeGreaterThan(host.indexOf('const openProcessBook = (databasePath: string | null)'));
        // A host with no Genie 1 to find (genie-cloud) still opens its process book and flows, without it.
        expect(host).toMatch(/await openProcessBook\(databasePath\);\s*await openFlows\(databasePath\);/);
        expect(host).toMatch(/if \(databasePath\) await runV1FlowImport\(/);
        expect(ENGINE_METHODS as readonly string[]).not.toContain('engine.v1Import');
        expect(code(src('src/main/main.ts'))).not.toMatch(/\.v1Import\(/);
    });
});

describe('3. the window view: names genie-host finds itself, and the person’s presence over window.view', () => {
    function rig(workspaces: Array<{ id: string; path: string }>) {
        const views: HostWindowView[] = [];
        let written = () => {};
        const v = hostWindowView({
            workspaces: () => workspaces,
            nameOf: (path) => `name of ${path}`,
            setView: (view) => { views.push(view); },
            onRegistryWritten: (l) => { written = l; return () => {}; },
        });
        return { v, views, write: () => written(), workspaces };
    }

    it('names its own workspaces at once; the person is away until the window says otherwise', () => {
        const r = rig([{ id: 'ws_a', path: '/w/a' }]);
        expect(r.views).toEqual([{ workspaceNames: { ws_a: 'name of /w/a' }, userActive: false }]);
    });

    it('names them again on a registry write, and keeps what the window said of the person', () => {
        const r = rig([{ id: 'ws_a', path: '/w/a' }]);
        r.v.userActive(true);
        r.workspaces.push({ id: 'ws_b', path: '/w/b' });
        r.write();
        expect(r.views.at(-1)).toEqual({ workspaceNames: { ws_a: 'name of /w/a', ws_b: 'name of /w/b' }, userActive: true });
        r.v.userActive(false);
        expect(r.views.at(-1)?.userActive).toBe(false);
    });

    it('window.view is a local method genie-host answers, only from main’s own client, with a strict argument', async () => {
        expect(REMOTE_METHODS as readonly string[]).toContain(VIEW);
        expect(capabilityOf(VIEW)).toBe('local');
        expect(HOST_ALONE_METHODS.has(VIEW)).toBe(true);
        expect(readWindowView([{ userActive: true }])).toEqual({ userActive: true });
        for (const bad of [[], [null], [{ userActive: 'yes' }], [{}]]) expect(readWindowView(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
        const said = vi.fn();
        const api = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null, windowView: { userActive: said } } as unknown as HostApiDeps);
        const base = { connectionId: 'c1', origin: 'local-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'Genie’s tray' } as const;
        expect(await api.invoke(VIEW, [{ userActive: true }], { ...base, own: true })).toBeNull();
        expect(said).toHaveBeenCalledWith(true);
        expect(await api.invoke(VIEW, [{ userActive: false }], base)).toMatchObject({ ok: false });
        expect(said).toHaveBeenCalledTimes(1);
    });

    it('wired: main says the person’s presence over its own client, and pushes no view on the engine link; genie-host names its workspaces itself', () => {
        const main = code(src('src/main/main.ts'));
        expect(main).toMatch(/ownProtocol\.call\('window\.view', \[\{ userActive: powerMonitor\.getSystemIdleTime\(\) < 120 \}\]\)/);
        expect(main).not.toMatch(/pushWindowView|pushHostView|workspaceNames/);
        expect(ENGINE_METHODS as readonly string[]).not.toContain('engine.windowView');
        const host = code(src('src/main/genie-host.ts'));
        expect(host).toMatch(/hostWindowView\(\{/);
        expect(host).toMatch(/nameOf: workspaceNameFor,/);
    });
});
