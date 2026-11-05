import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import type { HostingApi } from '../src/main/hosting-host.js';
import type { PtyOpened, PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';

/**
 * P5a (host split): THE FRONT DOOR, THE SERVICE ENGINES AND THE SITE ROUTES ARE GENIE-HOST'S. With a host linked, the
 * window's composition is handed the host's hosting (as it is handed the host's supervisor) and builds none of its own:
 * no Caddy started, no front door listening, no engine registry opened, no CA made. What it answers comes from the host's.
 * CONTROL: the same composition with no host (the emergency fallback, until P6) still builds its own, as today.
 */

function fakePty() {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    let n = 0;
    const port: PtyPort = {
        open(o) { const id = `term_${++n}`; opened.push({ ...o, id }); return { id, pid: 500 + n, shell: 'sh', scrollback: '' } satisfies PtyOpened; },
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
        onData: () => () => {}, onExit: () => () => {},
    };
    return { port, opened };
}

const exists = (path: string) => access(path).then(() => true, () => false);
const CADDY = '/opt/genie/runtime/caddy';
const caddyStarts = (opened: Array<{ command?: string }>) => opened.filter((o) => o.command?.includes(`${CADDY} run`)).length;
/** Lets compose's start-up work (the Caddy controller's first pass, the CA) run before anything is read. */
const settle = () => new Promise((r) => setTimeout(r, 30));

let dir: string | null = null;
let services: ComposedServices | null = null;
afterEach(async () => {
    await services?.shutdown();
    services = null;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
});

async function compose(hosting?: HostingApi) {
    dir = await mkdtemp(join(tmpdir(), 'genie2-p5a-'));
    const pty = fakePty();
    services = await composeServices({
        userData: dir, pty: pty.port, v1Settings: () => null, caddyBin: CADDY, frontDoorPort: 0,
        hostsIo: { read: async () => '', write: async () => {}, stage: async () => ({ command: 'cp', args: [] }) },
        elevate: async () => ({ ok: true }), hostsDebounceMs: 1, frontDoorPorts: { probe: async () => 'free', holder: async () => null }, trustStore: { has: async () => false },
        ...(hosting ? { hosting } : {}),
    });
    await settle();
    return { services, pty, dir };
}

/** The host's hosting, as the window's replica would answer it: a front door on the host's port, one route. */
function hostsHosting(): HostingApi {
    const routes = [{ host: 'docs.gen', target: '127.0.0.1:5173' }];
    return {
        frontDoorPort: 47111,
        routes: () => routes,
        configuredHosts: () => ['docs.gen'],
        browserTrust: () => ({ caPem: '-----BEGIN CERTIFICATE-----\nHOST\n-----END CERTIFICATE-----\n', thumbprint: 'AB'.repeat(20) }),
        externalFrontDoor: { running: false, reason: 'the host’s' },
    } as unknown as HostingApi;
}

describe('P5a: with genie-host linked, the window builds no hosting of its own', () => {
    it('starts no Caddy, makes no CA, writes no Caddyfile, and answers from the host’s hosting', async () => {
        const hosting = hostsHosting();
        const { services: s, pty, dir: d } = await compose(hosting);
        expect(caddyStarts(pty.opened)).toBe(0);
        expect(await exists(join(d, 'runtime', 'caddy', 'Caddyfile'))).toBe(false);
        expect(await exists(join(d, 'runtime', 'gen-ca'))).toBe(false);
        expect(s.frontDoorPort).toBe(47111);
        expect(s.routes()).toEqual([{ host: 'docs.gen', target: '127.0.0.1:5173' }]);
        expect(s.configuredHosts()).toEqual(['docs.gen']);
        expect(s.browserTrust()).toEqual(hosting.browserTrust());
    });

    it('CONTROL, no host (the emergency fallback until P6): the window still builds its own, as today', async () => {
        const { services: s, pty, dir: d } = await compose();
        expect(caddyStarts(pty.opened)).toBe(1);
        expect(await exists(join(d, 'runtime', 'caddy', 'Caddyfile'))).toBe(true);
        expect(s.frontDoorPort).toBeGreaterThan(0);
        expect(s.frontDoorPort).not.toBe(47111);
    });
});
