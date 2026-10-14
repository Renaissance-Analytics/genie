import { describe, expect, it } from 'vitest';
import { frontDoorCaddyfile, hostsFilePath, trustPlan } from '../src/core/front-door-caddy.js';
import { syncHostsFile, type HostsIo } from '../src/main/hosts-file.js';

/**
 * THE EXTERNAL-BROWSER PATH (§6.6) — Chrome/Edge reaching `https://<name>.gen`. Two things make it
 * work and both are rendered or planned here, never hand-rolled by an agent: the OS hosts file carries
 * a Genie-owned block (written with elevation only when it actually changes), and Genie's bundled
 * Caddy serves 443 with its INTERNAL CA (`tls internal`), whose root `caddy trust` installs once.
 */

describe('the front-door Caddyfile', () => {
    const routes = [{ host: 'tynn.gen', target: '127.0.0.1:4101' }, { host: 'dash.gen', target: '127.0.0.1:4102' }];

    it('one https site block per route with tls internal and a reverse_proxy to the loopback target; http redirects to https', () => {
        const out = frontDoorCaddyfile(routes);
        expect(out).toContain('https://tynn.gen {\n\ttls internal\n\treverse_proxy 127.0.0.1:4101\n}');
        expect(out).toContain('https://dash.gen {\n\ttls internal\n\treverse_proxy 127.0.0.1:4102\n}');
        expect(out).toContain('http://tynn.gen, http://dash.gen {\n\tredir https://{host}{uri} permanent\n}');
        // Loopback bind only — never an interface the LAN could reach.
        expect(out).toMatch(/^\{\n\tdefault_bind 127\.0\.0\.1\n/);
    });

    it('no routes → the global options only, so a running Caddy serves nothing rather than erroring on an empty file', () => {
        expect(frontDoorCaddyfile([])).toBe('{\n\tdefault_bind 127.0.0.1\n\tskip_install_trust\n\tauto_https disable_redirects\n}\n');
    });

    // The owner, 2026-10-14: a Windows "install this certificate?" prompt appeared at Genie's start, unasked. Caddy
    // installs its local root into the trust store on start unless told not to; only the person's Trust may.
    it('never installs its root into the trust store by itself: skip_install_trust in the global block, routes or none', () => {
        for (const routes of [[], [{ host: 'tynn.gen', target: '127.0.0.1:4101' }]]) {
            const globals = /^\{([\s\S]*?)\n\}/.exec(frontDoorCaddyfile(routes))?.[1] ?? '';
            expect(globals).toMatch(/^\s*skip_install_trust\s*$/m);
        }
    });

    it('a non-loopback target is refused — the front door never proxies off-host', () => {
        expect(() => frontDoorCaddyfile([{ host: 'evil.gen', target: '10.0.0.5:80' }])).toThrow(/loopback/);
    });
});

describe('trusting the internal CA', () => {
    it('plans `caddy trust` once, with the data dir Genie runs Caddy under, and says it will prompt for elevation', () => {
        expect(trustPlan('/opt/genie/runtime/caddy', '/home/me/.genie/caddy')).toEqual({
            command: '/opt/genie/runtime/caddy',
            args: ['trust', '--config', '/home/me/.genie/caddy/Caddyfile', '--adapter', 'caddyfile'],
            env: { XDG_DATA_HOME: '/home/me/.genie/caddy/data', XDG_CONFIG_HOME: '/home/me/.genie/caddy/config' },
            elevates: true,
            note: 'Installs Genie’s local root certificate into the system trust store so browsers accept https://<name>.gen. Your OS will ask for permission once.',
        });
    });
});

describe('the hosts file', () => {
    it('is at the platform’s path', () => {
        expect(hostsFilePath('win32')).toBe('C:\\Windows\\System32\\drivers\\etc\\hosts');
        expect(hostsFilePath('darwin')).toBe('/etc/hosts');
        expect(hostsFilePath('linux')).toBe('/etc/hosts');
    });

    function io(initial: string, opts: { denyPlain?: boolean; denyElevated?: boolean } = {}) {
        let content = initial;
        const calls: string[] = [];
        const port: HostsIo = {
            read: async () => { calls.push('read'); return content; },
            write: async (next) => { calls.push('write'); if (opts.denyPlain) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); content = next; },
            writeElevated: async (next) => { calls.push('elevated'); if (opts.denyElevated) throw new Error('the user declined'); content = next; },
        };
        return { port, calls, content: () => content };
    }

    it('writes nothing when the block already matches — no elevation prompt for no change', async () => {
        const current = '127.0.0.1 localhost\n# >>> genie .gen sites — managed, do not edit between the markers\n127.0.0.1 tynn.gen\n# <<< genie .gen sites\n';
        const f = io(current);
        const r = await syncHostsFile([{ host: 'tynn.gen', target: '127.0.0.1:4101' }], f.port);
        expect(r).toEqual({ changed: false, elevated: false });
        expect(f.calls).toEqual(['read']);
    });

    it('writes plainly when it can; escalates only on EACCES; reports a declined elevation as an error with the block the person could paste', async () => {
        const plain = io('127.0.0.1 localhost\n');
        expect(await syncHostsFile([{ host: 'tynn.gen', target: '127.0.0.1:4101' }], plain.port)).toEqual({ changed: true, elevated: false });
        expect(plain.content()).toContain('127.0.0.1 tynn.gen');

        const locked = io('127.0.0.1 localhost\n', { denyPlain: true });
        expect(await syncHostsFile([{ host: 'tynn.gen', target: '127.0.0.1:4101' }], locked.port)).toEqual({ changed: true, elevated: true });
        expect(locked.calls).toEqual(['read', 'write', 'elevated']);

        const declined = io('127.0.0.1 localhost\n', { denyPlain: true, denyElevated: true });
        const r = await syncHostsFile([{ host: 'tynn.gen', target: '127.0.0.1:4101' }], declined.port);
        expect(r).toMatchObject({ changed: false, elevated: false, error: 'the user declined' });
        expect((r as { manualBlock: string }).manualBlock).toContain('127.0.0.1 tynn.gen');
    });

    it('removing the last site leaves only the markers, and a file with no block gets one appended', async () => {
        const f = io('127.0.0.1 localhost\n# >>> genie .gen sites — managed, do not edit between the markers\n127.0.0.1 old.gen\n# <<< genie .gen sites\n');
        await syncHostsFile([], f.port);
        expect(f.content()).toBe('127.0.0.1 localhost\n# >>> genie .gen sites — managed, do not edit between the markers\n# <<< genie .gen sites\n');
    });
});
