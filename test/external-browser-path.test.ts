import { describe, expect, it } from 'vitest';
import { frontDoorCaddyfile, hostsFilePath } from '../src/core/front-door-caddy.js';
import { syncHostsFile, type HostsIo } from '../src/main/hosts-file.js';

/**
 * THE EXTERNAL-BROWSER PATH (§6.6) — Chrome/Edge reaching `https://<name>.gen`. Two things make it
 * work and both are rendered or planned here, never hand-rolled by an agent: the OS hosts file carries
 * a Genie-owned block (written with elevation only when it actually changes), and Genie's bundled
 * Caddy serves 443 with GENIE'S OWN leaf (`tls <cert> <key>`, from Genie's CA — Genie 1's, adopted, on
 * an upgrade), never `tls internal` (Caddy's own root, which nobody trusted: every site a certificate error).
 */

describe('the front-door Caddyfile', () => {
    const routes = [{ host: 'tynn.gen', target: '127.0.0.1:4101' }, { host: 'dash.gen', target: '127.0.0.1:4102' }];
    const tls = { certPath: '/home/me/.genie/runtime/gen-ca/leaf.crt', keyPath: '/home/me/.genie/runtime/gen-ca/leaf.key' };

    it('one https site block per route served with Genie’s leaf (tls <cert> <key>) and a reverse_proxy to the loopback target; http redirects to https', () => {
        const out = frontDoorCaddyfile(routes, tls);
        expect(out).toContain('https://tynn.gen {\n\ttls "/home/me/.genie/runtime/gen-ca/leaf.crt" "/home/me/.genie/runtime/gen-ca/leaf.key"\n\treverse_proxy 127.0.0.1:4101\n}');
        expect(out).toContain('https://dash.gen {\n\ttls "/home/me/.genie/runtime/gen-ca/leaf.crt" "/home/me/.genie/runtime/gen-ca/leaf.key"\n\treverse_proxy 127.0.0.1:4102\n}');
        expect(out).toContain('http://tynn.gen, http://dash.gen {\n\tredir https://{host}{uri} permanent\n}');
        // Loopback bind only — never an interface the LAN could reach.
        expect(out).toMatch(/^\{\n\tdefault_bind 127\.0\.0\.1\n/);
    });

    // COUNTED, not "contains": every route's block has exactly one tls line and it is Genie's leaf; Caddy's own root
    // appears nowhere (the owner, 2026-10-14: certificate errors in the browser on every .gen site).
    it('EVERY route uses tls <cert> <key>, and there is no `tls internal` anywhere', () => {
        const many = [...routes, { host: 'web.acme.gen', target: '127.0.0.1:4103' }];
        const out = frontDoorCaddyfile(many, tls);
        expect(out).not.toMatch(/tls\s+internal/);
        expect(out.match(/^\ttls /gm) ?? []).toHaveLength(many.length);
        expect(out.match(/^\ttls "\/home\/me\/\.genie\/runtime\/gen-ca\/leaf\.crt" "\/home\/me\/\.genie\/runtime\/gen-ca\/leaf\.key"$/gm) ?? []).toHaveLength(many.length);
        for (const r of many) expect(out).toContain(`https://${r.host} {\n\ttls "`);
    });

    it('a Windows path is written with forward slashes and quoted (a space in the user name stays one token); a path that could break the quote is refused', () => {
        const out = frontDoorCaddyfile([routes[0]!], { certPath: 'C:\\Users\\Jo Example\\.genie\\runtime\\gen-ca\\leaf.crt', keyPath: 'C:\\Users\\Jo Example\\.genie\\runtime\\gen-ca\\leaf.key' });
        expect(out).toContain('\ttls "C:/Users/Jo Example/.genie/runtime/gen-ca/leaf.crt" "C:/Users/Jo Example/.genie/runtime/gen-ca/leaf.key"\n');
        expect(() => frontDoorCaddyfile([routes[0]!], { certPath: '/tmp/x" {\n}', keyPath: '/tmp/k' })).toThrow(/cannot be written into a Caddyfile/);
    });

    it('routes without a certificate are refused, never served some other way', () => {
        expect(() => frontDoorCaddyfile(routes, null)).toThrow(/Genie’s certificate/);
    });

    it('no routes → the global options only, so a running Caddy serves nothing rather than erroring on an empty file', () => {
        expect(frontDoorCaddyfile([], null)).toBe('{\n\tdefault_bind 127.0.0.1\n\tskip_install_trust\n\tauto_https disable_redirects\n}\n');
        expect(frontDoorCaddyfile([], tls)).toBe('{\n\tdefault_bind 127.0.0.1\n\tskip_install_trust\n\tauto_https disable_redirects\n}\n');
    });

    // The owner, 2026-10-14: a Windows "install this certificate?" prompt appeared at Genie's start, unasked. Caddy
    // installs its local root into the trust store on start unless told not to; only the person's Trust may.
    it('never installs its root into the trust store by itself: skip_install_trust in the global block, routes or none', () => {
        for (const rs of [[], [{ host: 'tynn.gen', target: '127.0.0.1:4101' }]]) {
            const globals = /^\{([\s\S]*?)\n\}/.exec(frontDoorCaddyfile(rs, tls))?.[1] ?? '';
            expect(globals).toMatch(/^\s*skip_install_trust\s*$/m);
        }
    });

    it('a non-loopback target is refused — the front door never proxies off-host', () => {
        expect(() => frontDoorCaddyfile([{ host: 'evil.gen', target: '10.0.0.5:80' }], tls)).toThrow(/loopback/);
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
