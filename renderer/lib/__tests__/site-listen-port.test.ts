import { describe, expect, it } from 'vitest';
import { siteListensOn } from '../dev-server';
import type { DevSiteInfo } from '../genie';

/**
 * Which port the site card may claim the site "listens on".
 *
 * The card printed the CONFIGURED `port` unconditionally, and for a site Genie
 * serves ITSELF (hostServe `php`/`static`) that number is not in use by
 * anything: Genie allocates a free port at start. A site could therefore read
 * "listens on :8091" directly above "On this machine http://127.0.0.1:58228" —
 * two different numbers for one site, only one of them real.
 *
 * Worse, the Edit dialog deliberately (and correctly) hides the port field for a
 * host-native site, because the port is host-owned. So the card advertised a
 * number that could not be found, changed, or connected to.
 */

const site = (over: Partial<DevSiteInfo>): DevSiteInfo =>
    ({
        id: 's',
        name: 'docs',
        genName: 'prism.gen',
        runMode: 'host',
        kind: 'http',
        enabled: true,
        state: 'running',
        ...over,
    }) as DevSiteInfo;

describe('a site GENIE serves itself', () => {
    it('claims no port — Genie allocated it, and the configured one is dead config', () => {
        const s = site({ port: 8091, hostPort: 58228, hostServe: { mode: 'php', root: 'public' } });
        expect(siteListensOn(s)).toBeUndefined();
    });

    it('says the same for a static site', () => {
        const s = site({ port: 3000, hostPort: 51002, hostServe: { mode: 'static', root: 'dist' } });
        expect(siteListensOn(s)).toBeUndefined();
    });
});

describe("a site running the REPO's own dev server", () => {
    it('reports the port that server binds — which the person chose and can edit', () => {
        // Here `port` is real and load-bearing: the command binds it, and Genie
        // reverse-proxies `.gen` to it.
        const s = site({ port: 8080, hostPort: 65058 });
        expect(siteListensOn(s)).toBe(8080);
    });

    it('reports nothing when no port was configured', () => {
        expect(siteListensOn(site({ hostPort: 65058 }))).toBeUndefined();
    });
});
