import { describe, expect, it } from 'vitest';
import { composeHostSiteEnv } from '../host-site-process';
import type { DevSiteConfig } from '../sites-config';

/**
 * Env composition for a host-native site process (story #238, task #672). Same
 * precedence as the sandbox path (weakest first, the workspace service env WINS),
 * but the service env is HOST-form (127.0.0.1:<published port>) and, because the
 * process runs on the host, `localhost` already IS the host — so the gateway is
 * plain loopback, not the sandbox's host-gateway address.
 */
function cfg(over: Partial<DevSiteConfig> = {}): DevSiteConfig {
    return { name: 'app', genName: 'app.gen', kind: 'http', port: 8080, ...over } as DevSiteConfig;
}

describe('composeHostSiteEnv', () => {
    it('sets GENIE_HOST_GATEWAY to plain loopback (localhost IS the host now)', () => {
        const env = composeHostSiteEnv(cfg(), ['php', 'artisan', 'serve'], {});
        expect(env.GENIE_HOST_GATEWAY).toBe('127.0.0.1');
    });

    it('lets the workspace host-form service env WIN over the site\'s own env', () => {
        const env = composeHostSiteEnv(
            cfg({ env: { DB_HOST: 'user-set', APP_ENV: 'local' } }),
            ['node', 'server.js'],
            { DB_HOST: '127.0.0.1', DB_PORT: '54329' },
        );
        expect(env.DB_HOST).toBe('127.0.0.1'); // service env wins
        expect(env.DB_PORT).toBe('54329');
        expect(env.APP_ENV).toBe('local'); // site env preserved where not overridden
    });

    it('keeps the site\'s own env above the (weakest) gateway default', () => {
        const env = composeHostSiteEnv(cfg({ env: { GENIE_HOST_GATEWAY: 'overridden' } }), ['x'], {});
        expect(env.GENIE_HOST_GATEWAY).toBe('overridden');
    });
});
