import { describe, expect, it } from 'vitest';
import { phpFastcgiCaddyfile, phpFastcgiWorkerCommand } from '../php-fastcgi';

/**
 * The nginx-style PHP serving (the owner's steer away from FrankenPHP): Genie's
 * bundled Caddy in front, a host PHP FastCGI worker (`php-cgi -b` — ships with PHP
 * on every OS) behind, both run as host processes on allocated loopback ports. TLS
 * is added by the `.gen` front door, so the per-site Caddy is plain http here.
 */
describe('phpFastcgiCaddyfile', () => {
    it('serves the repo public/ on the site port via php_fastcgi to the worker (plain http)', () => {
        const cf = phpFastcgiCaddyfile({ sitePort: 5321, publicRoot: '/repos/moic/public', fcgiPort: 5322 });
        expect(cf).toContain(':5321 {');
        expect(cf).toContain('root * "/repos/moic/public"');
        expect(cf).toContain('php_fastcgi 127.0.0.1:5322');
        // Plain http on loopback — TLS is the `.gen` front door's job, not here.
        expect(cf).toContain('auto_https off');
        expect(cf).not.toMatch(/\btls\b/);
    });

    it('normalises Windows roots to forward slashes and refuses an injectable one', () => {
        expect(phpFastcgiCaddyfile({ sitePort: 1, publicRoot: 'C:\\r\\public', fcgiPort: 2 })).toContain(
            'root * "C:/r/public"',
        );
        expect(() => phpFastcgiCaddyfile({ sitePort: 1, publicRoot: 'a"\n}', fcgiPort: 2 })).toThrow();
    });
});

describe('phpFastcgiWorkerCommand', () => {
    it('runs php-cgi as a FastCGI server bound to the worker port (portable — php-cgi ships with PHP)', () => {
        expect(phpFastcgiWorkerCommand(5322)).toEqual(['php-cgi', '-b', '127.0.0.1:5322']);
    });
});
