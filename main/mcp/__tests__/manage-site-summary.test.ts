import { describe, expect, it } from 'vitest';
import { manageSiteSummary, type DevSiteInfo, type ManageSiteResult } from '../protocol';

/**
 * What Genie SAYS about a site that is up but not answering (genie#227).
 *
 * The reported failure: a `runMode: host` site whose app was provably healthy —
 * 200 on its own port, the dev server's log clean — while Genie's proxy served
 * nothing, and every call said *"its container is up, but nothing is listening on
 * port 5173 yet — it may still be starting."* Forever.
 *
 * Two faults in one sentence. It says **container** for a mode documented as
 * having none, which sent the reporter hunting a container that does not exist.
 * And *"may still be starting"* is unfalsifiable: a permanent misconfiguration and
 * a slow boot produce the identical message, indefinitely, so there is no reading
 * of it that ever means "this is broken".
 */

const site = (over: Partial<DevSiteInfo> = {}): DevSiteInfo => ({
    id: 'site-1',
    workspaceId: 'ws',
    name: 'karma',
    genName: 'karma.gen',
    repo: 'dashboard',
    runMode: 'host',
    kind: 'http',
    enabled: true,
    state: 'running',
    ready: false,
    port: 5173,
    hostPort: 64630,
    ...over,
});

const result = (s: DevSiteInfo): ManageSiteResult =>
    ({ ok: true, sites: [s], affectedId: s.id }) as ManageSiteResult;

describe('a host-native site that is not answering', () => {
    it('does not call it a container', () => {
        // `runMode: host` is documented as "no container, no build". Naming one
        // sends people looking for something that does not exist.
        const text = manageSiteSummary(result(site()));
        expect(text).not.toMatch(/container/i);
        expect(text).toMatch(/process/i);
    });

    it('names the port GENIE is proxying to, not just the one in the command', () => {
        // The actual failure mode: the host allocates the port and rewrites the
        // command; if the app binds a different one, Genie proxies into nothing.
        // The message has to expose that gap to be diagnosable at all.
        expect(manageSiteSummary(result(site()))).toContain('64630');
    });

    it('says how to tell a slow boot from a broken one', () => {
        // The whole complaint: "may still be starting" is a claim that can never
        // be falsified. It must point at something checkable.
        const text = manageSiteSummary(result(site()));
        expect(text).toMatch(/curl|check|listening on a different/i);
    });
});

describe('a CONTAINER site that is not answering', () => {
    it('still says container, because there is one', () => {
        const text = manageSiteSummary(result(site({ runMode: 'explicit', hostPort: 8443 })));
        expect(text).toMatch(/container/i);
    });
});

describe('what still works', () => {
    it('reports a ready site as serving', () => {
        const text = manageSiteSummary(
            result(site({ ready: true, origin: 'https://karma.gen' } as Partial<DevSiteInfo>)),
        );
        expect(text).toContain('serving');
        expect(text).toContain('https://karma.gen');
    });

    it('reports a failed site with its reason', () => {
        const text = manageSiteSummary(
            result(site({ state: 'failed', error: 'port 443 in use' } as Partial<DevSiteInfo>)),
        );
        expect(text).toContain('port 443 in use');
    });
});
