import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnabledGenSite } from '../../remote';

/**
 * WHERE A `.gen` SITE COMES FROM — and, since the container Dev Server shipped
 * (#234), where it does NOT.
 *
 * `listLocalEnabledGenSites()` answers one question: "which `.gen` sites can
 * this machine serve right now?" It used to answer it from TWO sources, and the
 * first of them was wrong:
 *
 *   - DISCOVERY (the OS hosts file + a loopback probe) could only ever describe
 *     a site something ELSE serves — Herd's `tynn.test`, an `artisan serve`, a
 *     stray Vite. Genie did not start it, cannot restart it, and learns nothing
 *     about it beyond a name and a port that answered once. That is the
 *     "tunnel a site you are running elsewhere" model the container Dev Server
 *     replaced, and the owner's call is blunt: `.gen` sites are NOT configured
 *     from what is found in the hosts file.
 *   - The DEV SERVER serves a container Genie started, whose published loopback
 *     port it read back from the runtime.
 *
 * So there is exactly ONE source now, and the tests below pin both halves of
 * that: a hosts-file `.test` entry produces NOTHING, and a Dev Server site
 * still lands as an ordinary `EnabledGenSite` that `localTargetsBySiteId` → the
 * local carrier (local) and `/api/sites/enabled` → the remote shim (remote)
 * both carry with no code of their own. The CARRIER is untouched; only the
 * source is.
 */

const devServerGenSites = vi.fn((): EnabledGenSite[] => []);

vi.mock('../../dev-server/site-manager', () => ({
    devServerGenSites: () => devServerGenSites(),
}));

// eslint-disable-next-line import/first -- `vi.mock` is hoisted above this.
import {
    listLocalEnabledGenSites,
    localTargetsBySiteId,
    resolveEnabledSite,
} from '../local-sites';

/** A dev site the container Dev Server is serving right now — the `port` is the
 *  runtime's PUBLISHED loopback port for the container. */
const CONTAINER: EnabledGenSite = {
    workspaceId: 'ws1',
    genName: 'web.acme.gen',
    siteId: 'id-web',
    hostname: 'web.acme.gen',
    scheme: 'http',
    port: 49_812,
    loopback: '127.0.0.1',
};

beforeEach(() => {
    vi.clearAllMocks();
    devServerGenSites.mockReturnValue([]);
});

describe('listLocalEnabledGenSites', () => {
    it('EMITS a container dev site, so `<name>.gen` resolves to its published port', async () => {
        // THE ROUTING SEAM. A dev server running in the workspace sandbox reaches
        // the Testing Browser as an ordinary `EnabledGenSite` whose target is the
        // container's published loopback port — no proxy, no second resolution
        // path, and identical for a local and a remote viewer.
        devServerGenSites.mockReturnValue([CONTAINER]);
        const targets = localTargetsBySiteId(await listLocalEnabledGenSites());
        expect(targets.get('id-web')).toEqual({
            scheme: 'http',
            hostname: 'web.acme.gen',
            port: 49_812,
            loopback: '127.0.0.1',
        });
    });

    it('serves NOTHING when the Dev Server is serving nothing', async () => {
        // The retirement, stated as an assertion: a machine covered in Herd
        // `.test` vhosts has no `.gen` sites until Genie itself serves one. If
        // this file ever reads a hosts file again, this is what fails.
        expect(await listLocalEnabledGenSites()).toEqual([]);
    });

    it('touches no workspace tunnel config and no hosts file to answer', async () => {
        // A structural assertion, not a behavioural one: the module must not
        // even IMPORT the retired discovery. An unmocked `../../db` or
        // `../../mobile/hosts` here would throw (electron/better-sqlite3 are not
        // loadable in this env), so the fact that the import above resolved at
        // all is the proof — restated as an explicit expectation so a
        // reintroduced dependency fails loudly rather than silently reappearing.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const source = fs.readFileSync(
            path.resolve(process.cwd(), 'main/sites/local-sites.ts'),
            'utf8',
        );
        expect(source).not.toMatch(/mobile\/hosts/);
        expect(source).not.toMatch(/TunnelSites|tunnel_sites/);
    });
});

/**
 * The REMOTE half of the same seam.
 *
 * A remote viewer does not dial loopback itself — it addresses
 * `/api/site/<siteId>/…` on the host, and the host's site-proxy resolves that
 * opaque id to a loopback target. That resolver used to read the hosts file
 * too, which meant a Dev Server site appeared in the host's `/api/sites/enabled`
 * listing (so the remote's browser offered it) and then 404'd the moment the
 * remote actually opened it — the listing and the resolver disagreed about what
 * a site is.
 *
 * Resolving from the SAME aggregation the listing comes from is what makes that
 * impossible rather than merely unlikely.
 */
describe('resolveEnabledSite', () => {
    it('resolves a Dev Server site to its published loopback target', async () => {
        devServerGenSites.mockReturnValue([CONTAINER]);
        expect(await resolveEnabledSite('id-web')).toEqual({
            workspaceId: 'ws1',
            hostname: 'web.acme.gen',
            scheme: 'http',
            port: 49_812,
            loopback: '127.0.0.1',
        });
    });

    it('fails closed on an id nothing is serving', async () => {
        // The SSRF floor: an id that does not resolve is a 404, and a remote can
        // supply nothing else — never a hostname, never a port.
        devServerGenSites.mockReturnValue([CONTAINER]);
        expect(await resolveEnabledSite('id-not-served')).toBeNull();
        expect(await resolveEnabledSite('')).toBeNull();
    });

    it('carries the site’s allowed WebSocket origins when it declares them', async () => {
        // HMR / Reverb sockets are origin-checked against this; dropping the
        // field would reject the very sockets a dev server depends on.
        devServerGenSites.mockReturnValue([
            { ...CONTAINER, allowedOrigins: ['web.acme.gen', 'localhost'] },
        ]);
        expect((await resolveEnabledSite('id-web'))?.allowedOrigins).toEqual([
            'web.acme.gen',
            'localhost',
        ]);
    });
});
