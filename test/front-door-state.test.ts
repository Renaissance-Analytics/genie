import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostsFilePath } from '../src/core/front-door-caddy.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import type { Step } from '../src/main/elevate.js';
import type { HostsIo } from '../src/main/hosts-file.js';
import type { PtyOpened, PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';

/**
 * THE EXTERNAL FRONT DOOR'S STATE — beyond "Caddy is running": whether the hosts file carries the
 * .gen block (synced on every site change, through the OS prompt only when the plain write is
 * refused, a declined prompt recorded with the block to paste), and whether Genie's local root is
 * TRUSTED (`caddy trust`, run once on the person's click, remembered by a marker so no second
 * prompt). Both are facts the Hosting surface shows; neither is a gate on anything else.
 */

function fakePty() {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    let n = 0;
    const port: PtyPort = {
        open(o) { const id = `term_${++n}`; opened.push({ ...o, id }); return { id, pid: 500 + n, shell: 'sh', scrollback: '' } satisfies PtyOpened; },
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };
    return { port, opened };
}

function fakeHosts(initial: string) {
    let content = initial;
    const state = { denyPlain: false, denyElevated: false };
    const port: HostsIo = {
        read: async () => content,
        write: async (next) => { if (state.denyPlain) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); content = next; },
        writeElevated: async (next) => { if (state.denyElevated) throw new Error('Request dismissed'); content = next; },
    };
    return { port, state, content: () => content };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 15));

let dir: string;
let services: ComposedServices | null = null;
let hosts: ReturnType<typeof fakeHosts>;
let elevated: Step[];
let declineTrust = false;
const CADDY = '/opt/genie/runtime/caddy';

async function compose(caddyBin: string | null = CADDY): Promise<ComposedServices> {
    return composeServices({
        userData: dir, pty: fakePty().port, v1Settings: () => null, caddyBin, frontDoorPort: 0,
        hostsIo: hosts.port,
        runElevated: async (step) => { elevated.push(step); if (declineTrust) throw new Error('the user declined'); },
    });
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-front-door-state-'));
    hosts = fakeHosts('127.0.0.1 localhost\n');
    elevated = [];
    declineTrust = false;
});

afterEach(async () => {
    await services?.shutdown();
    services = null;
    await rm(dir, { recursive: true, force: true });
});

describe('the hosts file', () => {
    it('is synced at boot and on every site change; the result is on the front door state and listeners hear it', async () => {
        services = await compose();
        const heard: string[] = [];
        services.onFrontDoorChange(() => heard.push(JSON.stringify(services!.externalFrontDoor)));
        await settle();
        const caddyfile = join(dir, 'runtime', 'caddy', 'Caddyfile');
        expect(services.externalFrontDoor).toEqual({ running: true, caddyfile, hostsPath: hostsFilePath(process.platform), hosts: { changed: true, elevated: false }, trusted: false });
        expect(hosts.content()).toContain('# >>> genie .gen sites');

        services.sites.create({ name: 'docs', workspaceId: 'tynn', repoPath: dir, serve: { mode: 'proxy' }, hostPort: 5173 });
        await settle();
        expect(hosts.content()).toContain('127.0.0.1 docs.gen');
        services.sites.remove('site_docs');
        await settle();
        expect(hosts.content()).not.toContain('docs.gen');
        expect(heard.length).toBeGreaterThanOrEqual(2);
    });

    it('a refused plain write goes through the OS prompt; a declined prompt is recorded with the block to paste, and syncHosts() tries again on request', async () => {
        hosts.state.denyPlain = true;
        services = await compose();
        await settle();
        expect(services.externalFrontDoor).toMatchObject({ hosts: { changed: true, elevated: true } });

        hosts.state.denyElevated = true;
        services.sites.create({ name: 'docs', workspaceId: 'tynn', repoPath: dir, serve: { mode: 'proxy' }, hostPort: 5173 });
        await settle();
        const fd = services.externalFrontDoor as { hosts: { error: string; manualBlock: string } };
        expect(fd.hosts.error).toBe('Request dismissed');
        expect(fd.hosts.manualBlock).toContain('127.0.0.1 docs.gen');

        hosts.state.denyElevated = false;
        expect(await services.syncHosts()).toEqual({ changed: true, elevated: true });
        expect(hosts.content()).toContain('127.0.0.1 docs.gen');
    });

    it('without a bundled Caddy nothing is synced and syncHosts says why', async () => {
        services = await compose(null);
        await settle();
        expect(hosts.content()).toBe('127.0.0.1 localhost\n');
        expect(services.externalFrontDoor).toEqual({ running: false, reason: 'this install has no bundled Caddy; https://<name>.gen in external browsers is off, the in-app browser still works' });
        await expect(services.syncHosts()).rejects.toThrow(/no bundled Caddy/);
    });
});

describe('trusting the local root', () => {
    it('trustCertificate runs `caddy trust` through the OS prompt with Genie’s Caddy dirs, marks trusted, and the marker survives a restart', async () => {
        services = await compose();
        expect(await services.trustCertificate()).toEqual({ ok: true });
        const caddyDir = join(dir, 'runtime', 'caddy');
        expect(elevated).toEqual([{ command: CADDY, args: ['trust', '--config', `${caddyDir}/Caddyfile`, '--adapter', 'caddyfile'], env: { XDG_DATA_HOME: `${caddyDir}/data`, XDG_CONFIG_HOME: `${caddyDir}/config` } }]);
        expect(services.externalFrontDoor).toMatchObject({ trusted: true });
        await expect(stat(join(caddyDir, 'trusted'))).resolves.toBeDefined();
        expect((await readFile(join(caddyDir, 'trusted'), 'utf8')).length).toBeGreaterThan(0);

        await services.shutdown();
        services = await compose();
        expect(services.externalFrontDoor).toMatchObject({ trusted: true });
        // Already trusted: no second prompt.
        expect(await services.trustCertificate()).toEqual({ ok: true });
        expect(elevated).toHaveLength(1);
    });

    it('a declined prompt is reported and nothing is marked; with no bundled Caddy the answer says why', async () => {
        declineTrust = true;
        services = await compose();
        expect(await services.trustCertificate()).toEqual({ ok: false, reason: 'the user declined' });
        expect(services.externalFrontDoor).toMatchObject({ trusted: false });
        await expect(stat(join(dir, 'runtime', 'caddy', 'trusted'))).rejects.toThrow();

        await services.shutdown();
        services = await compose(null);
        expect(await services.trustCertificate()).toEqual({ ok: false, reason: 'this install has no bundled Caddy; https://<name>.gen in external browsers is off, the in-app browser still works' });
    });
});
