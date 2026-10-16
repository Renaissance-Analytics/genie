import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workspaceDnsName } from '../src/core/v1-services.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * AN HTTPS SITE REACHES THE SHARED WEBSOCKETS SERVER (moic, via the owner, 2026-10-16). Genie 2 gave the browser
 * `127.0.0.1:<port>` over plain ws, reasoning that a browser treats loopback as a secure origin. pusher-js does not ask:
 * on an https page it ALWAYS uses TLS (useTLS = forceTLS || location.protocol === 'https:'), so it dialled
 * wss://127.0.0.1:<port> — nothing speaks TLS there — and every https site's live updates fell back to polling.
 *
 * Genie 1 served the engine through the front door at `websockets.<ws-name>.gen` (host-core/hosting.ts), with Genie's
 * certificate, and a moic `.env` written then still names that host. So: each workspace attached to the shared
 * WebSockets engine gets that front-door route (in the routes the doors serve, the hosts file and the certificate),
 * and the BROWSER keys (`VITE_*`) name it — https, 443. The SERVER keys (`REVERB_*`, `GENIE_WS_*`) stay on loopback,
 * where the backend talks to the engine directly. Every value is invented; names are RFC 2606 (`example*`).
 */

const pty: PtyPort = {
    open: () => ({ id: 't', pid: 1, shell: 'sh', scrollback: '' }), write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};
function fakeDocker(): DockerRunner {
    const containers = new Map<string, string>();
    return async (args) => {
        const [cmd, sub] = args;
        if (cmd === 'image' && sub === 'inspect') return { stdout: '[{}]', exitCode: 0 };
        if (cmd === 'container' && sub === 'inspect') {
            const st = containers.get(args[2]!);
            return st ? { stdout: JSON.stringify([{ State: { Status: st, StartedAt: 't' } }]), exitCode: 0 } : { stdout: '', exitCode: 1 };
        }
        if (cmd === 'create') { containers.set(args[2]!, 'created'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'start') { containers.set(args[1]!, 'running'); return { stdout: '', exitCode: 0 }; }
        return { stdout: '', exitCode: 0 };
    };
}

let dir: string;
let services: ComposedServices;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-ws-door-'));
    for (const ws of ['example', 'example-other']) {
        await mkdir(join(dir, ws), { recursive: true });
        await writeFile(join(dir, ws, 'project.json'), `${JSON.stringify({ name: ws, repos: [] }, null, 2)}\n`, 'utf8');
    }
    services = await composeServices({
        userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker: fakeDocker(), portFree: async () => true,
        workspaces: () => [{ id: 'example', path: join(dir, 'example') }, { id: 'example-other', path: join(dir, 'example-other') }],
    });
});
afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

const browserHost = (ws: string) => `websockets.${workspaceDnsName(ws)}.gen`;
const attach = (workspaceId: string) => services.engines.add({ engine: 'websockets', major: '4.7.0', scope: { kind: 'shared' }, consent: true, workspaceId });
const engine = () => services.engines.list().find((i) => i.engine === 'websockets')!;

describe('the shared WebSockets engine, for an https site', () => {
    it('the browser keys name its front-door host over https; the server keys stay on loopback', async () => {
        await attach('example');
        const env = services.engines.envFor('example');
        const port = String(engine().publishedPort);
        expect({ host: env.VITE_REVERB_HOST, port: env.VITE_REVERB_PORT, scheme: env.VITE_REVERB_SCHEME }).toEqual({ host: browserHost('example'), port: '443', scheme: 'https' });
        expect({ host: env.VITE_GENIE_WS_HOST, port: env.VITE_GENIE_WS_PORT, scheme: env.VITE_GENIE_WS_SCHEME }).toEqual({ host: browserHost('example'), port: '443', scheme: 'https' });
        expect({ host: env.REVERB_HOST, port: env.REVERB_PORT, scheme: env.REVERB_SCHEME }).toEqual({ host: '127.0.0.1', port, scheme: 'http' });
        expect({ host: env.GENIE_WS_HOST, port: env.GENIE_WS_PORT, scheme: env.GENIE_WS_SCHEME }).toEqual({ host: '127.0.0.1', port, scheme: 'http' });
    });

    it("the front door serves that host to the engine, and it is in the hosts file's names — one per attached workspace", async () => {
        expect(services.routes().filter((r) => r.host.startsWith('websockets.'))).toEqual([]); // CONTROL: nothing attached, no route
        await attach('example');
        await attach('example-other');
        const target = `127.0.0.1:${engine().publishedPort}`;
        const ws = services.routes().filter((r) => r.host.startsWith('websockets.')).sort((a, b) => a.host.localeCompare(b.host));
        expect(ws).toEqual([{ host: browserHost('example'), target }, { host: browserHost('example-other'), target }].sort((a, b) => a.host.localeCompare(b.host)));
        expect(services.configuredHosts()).toEqual(expect.arrayContaining([browserHost('example'), browserHost('example-other')]));
    });

    it("Genie 1's name: a .env written under Genie 1 still names the host the front door now serves", () => {
        expect(browserHost('01k95ewdtyd93jn55vxfcwg98y')).toBe('websockets.ws-01k95ewdtyd93jn55vxfcwg98y.gen');
    });
});
