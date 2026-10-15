import { describe, expect, it } from 'vitest';
import { frontDoorCaddyfile, hostsFilePath } from '../src/core/front-door-caddy.js';

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
    // What is WRITTEN, when, and through which prompt: test/hosts-sync.test.ts (the hosts file follows the CONFIGURED names).
});
