import { describe, expect, it } from 'vitest';
import { isHostNativeSite, siteListensOn } from '../dev-server';
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

describe('a host-native site with no port configured at all', () => {
    it('reports nothing, which is also what it reports when one IS configured', () => {
        expect(siteListensOn(site({ hostPort: 65058 }))).toBeUndefined();
    });
});

describe("a site running the REPO's own dev server, host-native", () => {
    it('claims no port either — the host allocates it and REWRITES the command', () => {
        // site-manager.ts: "The HOST owns the port ... The stored `config.port` is
        // ignored on this path precisely because a fixed stored port is the
        // collision vector." `withPort()` rewrites the argv to bind the allocated
        // port, so a stored 8080 is never listened on by anything.
        const s = site({ runMode: 'host', port: 8080, hostPort: 65058 });
        expect(siteListensOn(s)).toBeUndefined();
    });
});

describe('a CONTAINER site', () => {
    it('reports its configured port — there the command really does bind it', () => {
        // The container path REQUIRES this port and refuses to start without it,
        // so it is the one case where the stored number is load-bearing.
        const s = site({ runMode: 'recipe', port: 3000, hostPort: 49812 });
        expect(siteListensOn(s)).toBe(3000);
    });
});

describe('telling the two apart', () => {
    it('does NOT use hostPort, which both kinds have once running', () => {
        // `hostPort` is the PUBLISHED port and is set for a container site too
        // (site-manager.ts sets `hostPort: entry.caddyHostPort` for both, and
        // distinguishes them by `sniTls`). Classifying on it made a RUNNING
        // container site read as host-native — hiding the port and image fields
        // the container path requires, and showing the external-browser toggle
        // that does nothing for it. Worse, it flipped when the site started.
        expect(isHostNativeSite({ runMode: 'recipe', hostPort: 49812 })).toBe(false);
        expect(isHostNativeSite({ runMode: 'host', hostPort: 65058 })).toBe(true);
    });

    it('treats a Genie-served site as host-native whatever its runMode says', () => {
        expect(isHostNativeSite({ runMode: '', hostServe: { mode: 'php', root: 'public' } })).toBe(true);
    });
});
