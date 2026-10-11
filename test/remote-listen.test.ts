import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { attachWebSocketServer } from '@particle-academy/fancy-ws';
import { remoteListener, type RemoteListener } from '../src/main/remote-listen.js';

/**
 * WHERE THE HOST'S SOCKET LISTENS (§6.8). The remote transport binds to this machine's Tailscale
 * IPv4 ONLY and advertises its MagicDNS name — a device on the tailnet reaches it, nothing on the LAN
 * or the internet does. No Tailscale → nothing listens, and the REASON is in words a person can act
 * on; the host never falls back to every interface. A real fancy-ws socket connects through it.
 */

const running = (ip: string, dns: string) => JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${dns}.`, TailscaleIPs: [ip, 'fd7a:115c:a1e0::1'] } });

let listener: RemoteListener | null = null;
afterEach(async () => { await listener?.stop(); listener = null; });

const once = <T>(target: { addEventListener: (type: string, cb: (e: T) => void) => void }, type: string) => new Promise<T>((r) => target.addEventListener(type, r));

describe('remoteListener', () => {
    it('without Tailscale nothing listens, no server is even created, and the reason is in words; a missing binary is its own reason', async () => {
        let servers = 0;
        listener = remoteListener({ tailscale: async () => JSON.stringify({ BackendState: 'Stopped' }), port: 0, attach: attachWebSocketServer, createServer: () => { servers += 1; return createServer(); } });
        expect(listener.unavailable()).toBe('not started');
        await listener.start();
        expect(listener.transport.address()).toBeNull();
        expect(listener.unavailable()).toMatch(/Tailscale is not running/);
        expect(servers).toBe(0);
        await listener.stop();

        listener = remoteListener({ tailscale: async () => { throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' }); }, port: 0, attach: attachWebSocketServer, createServer: () => { servers += 1; return createServer(); } });
        await listener.start();
        expect(listener.transport.address()).toBeNull();
        expect(listener.unavailable()).toMatch(/Tailscale is not installed or not on PATH/);
        expect(servers).toBe(0);
    });

    it('with Tailscale it binds to the Tailscale IPv4 ONLY, advertises the MagicDNS name, carries a real socket both ways, and stop() closes the door', async () => {
        const binds: Array<{ port: unknown; host: unknown }> = [];
        const spyServer = (): Server => {
            const s = createServer();
            const listen = s.listen.bind(s);
            (s as { listen: unknown }).listen = (...args: unknown[]) => { binds.push({ port: args[0], host: args[1] }); return (listen as (...a: unknown[]) => Server)(...args); };
            return s;
        };
        listener = remoteListener({ tailscale: async () => running('127.0.0.1', 'alphar.tailnet.invalid'), port: 0, attach: attachWebSocketServer, createServer: spyServer });
        await listener.start();

        const url = listener.transport.address();
        expect(url).toMatch(/^ws:\/\/alphar\.tailnet\.invalid:\d+\/genie$/);
        const port = Number(/:(\d+)\/genie$/.exec(url!)![1]);
        expect(port).toBeGreaterThan(0);
        expect(binds).toEqual([{ port: 0, host: '127.0.0.1' }]);
        expect(listener.unavailable()).toBeNull();

        const received: string[] = [];
        const connected = new Promise<void>((resolve) => {
            listener!.transport.onConnection((c) => { c.onMessage((t) => { received.push(t); if (t === 'hello') c.send('hi back'); }); resolve(); });
        });
        const client = new WebSocket(`ws://127.0.0.1:${port}/genie`);
        await once(client, 'open');
        await connected;
        const reply = once<{ data: unknown }>(client, 'message');
        client.send('hello');
        expect(String((await reply).data)).toBe('hi back');
        expect(received).toEqual(['hello']);
        client.close();

        await listener.stop();
        expect(listener.transport.address()).toBeNull();
        expect(listener.unavailable()).toBe('stopped');
        const refused = new WebSocket(`ws://127.0.0.1:${port}/genie`);
        await Promise.race([once(refused, 'error'), once(refused, 'close')]);
        expect(refused.readyState).not.toBe(WebSocket.OPEN);
    });
});
