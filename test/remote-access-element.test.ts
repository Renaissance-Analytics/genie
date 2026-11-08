import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REMOTE_ACCESS_ELEMENT } from '../src/main/genie-catalog.js';
import { genieCatalog } from '../src/main/genie-catalog.js';
import { hostRemoteApi, RelayBridgeHost, RemoteAccessHost, RemoteAccessService } from '../src/main/remote-access-host.js';

/*
 * REMOTE ACCESS IS AN ADF ELEMENT (Tynn #409; the owner: the host split is built on ADF). `genie.remote-access` is a
 * `host-service` on BOTH sides: genie-host runs it, a window's Settings → Workstation draws it, and its `reach.link` is the
 * only channel between them. The handlers its payload names are real: the host side answers them.
 */

let home = '';
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); home = ''; });

describe('genie.remote-access in the catalog', () => {
    it('is a host-service on both sides, linked by the engine link\'s remote access call and event', () => {
        const element = genieCatalog().list('host-service').find((d) => d.id === 'genie.remote-access');
        expect(element).toMatchObject({
            kind: 'host-service',
            source: 'builtin',
            reach: { side: 'both', requiresWindow: false, remote: 'local', link: { calls: ['engine.remoteAccess'], events: ['remoteAccess.event'] } },
            payload: { start: 'remoteAccess.start', stop: 'remoteAccess.stop', health: 'remoteAccess.health', settingsSection: 'workstation' },
        });
        expect(REMOTE_ACCESS_ELEMENT.id).toBe('genie.remote-access');
    });

    it('the handlers its payload names are answered by the host side', async () => {
        home = await mkdtemp(join(tmpdir(), 'genie2-remote-element-'));
        const listener = { on: false };
        const access = await RemoteAccessHost.open({
            home, hostName: 'alphar', transport: { onConnection: () => () => {} },
            api: hostRemoteApi({ hostName: 'alphar', own: {}, window: { connected: () => false, invoke: async () => null } }),
        });
        const service = new RemoteAccessService(access, new RelayBridgeHost(() => {}), {
            switch: { apply: async () => { listener.on = true; }, restart: async () => {}, stop: async () => { listener.on = false; } },
            newestWindow: () => null, windowEvent: () => {}, send: () => {},
        });
        const handler = (name: string) => name.slice('remoteAccess.'.length);
        const payload = REMOTE_ACCESS_ELEMENT.payload as { start: string; stop: string; health: string };
        await service.call('window-1', handler(payload.start), []);
        expect(listener.on).toBe(true);
        expect(await service.call('window-1', handler(payload.health), [])).toMatchObject({ host: 'alphar', listening: false, why: expect.any(String) });
        await service.call('window-1', handler(payload.stop), []);
        expect(listener.on).toBe(false);
        await access.close();
    });
});
