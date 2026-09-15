import { describe, expect, it } from 'vitest';
import { createDevSiteManager, type DevSiteProgress } from '../site-manager';
import { devSiteIdFor } from '../sites-config';
import type { DevSites } from '../sites-config';
import type { ContainerRuntime, RuntimeDetection } from '../container-runtime';

/**
 * STOP WHILE A SITE IS STILL STARTING.
 *
 * Reported on the owner's machine: a host-native PHP site (`prism.gen`) sat on
 * "Starting — waiting for the server to answer…", the owner pressed Stop, and the
 * card stayed on Starting. Genie itself answered `state: stopped, phase: starting`.
 *
 * What happened: a host-native start records the site LIVE and then waits up to
 * the ready timeout for it to answer. Stop, arriving in that wait, took the site
 * down and removed the live entry. When the wait ended, the start read the entry
 * back — gone — and threw. The start's progress is only ever finished on SUCCESS,
 * so the `starting` phase was never cleared: the list kept reporting it, the card
 * kept drawing it, and nothing short of restarting Genie removed it.
 *
 * And a Stop that arrives EARLIER — before the start has recorded anything — found
 * nothing live, returned, and the start carried on and brought the site up anyway.
 */

const NO_RUNTIME: RuntimeDetection = { kind: 'none', probes: [] };
const WS = { id: 'prism', path: '/work/prism', label: 'prism' };
const SITE_ID = devSiteIdFor('prism', 'docs');
const FCGI_ID = `${SITE_ID}-fcgi`;

const SITES: DevSites = {
    [SITE_ID]: {
        name: 'docs',
        genName: 'prism.gen',
        repo: 'prism-sandbox',
        runMode: 'host',
        kind: 'http',
        enabled: true,
        hostServe: { mode: 'php', root: 'public' },
    },
};

/** A promise and the function that settles it — a step a test holds open. */
function gate<T = void>() {
    let open!: (value: T) => void;
    const promise = new Promise<T>((r) => (open = r));
    return { promise, open };
}

/** Let every already-queued continuation run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function harness(opts: {
    probeReady?: () => Promise<boolean>;
    workerStart?: () => Promise<void>;
    writeServeConfig?: () => string;
} = {}) {
    const spawned: string[] = [];
    const up = new Set<string>();
    const stopped: string[] = [];
    const progress: DevSiteProgress[] = [];
    let nextPort = 5300;
    const m = createDevSiteManager({
        resolveRuntime: async () => ({ runtime: null as ContainerRuntime | null, detection: NO_RUNTIME }),
        listWorkspaces: () => [WS],
        devSitesFor: () => SITES,
        platform: 'linux',
        hostIds: null,
        hostSpawn: {
            start: async (i: { siteId: string }) => {
                if (i.siteId === FCGI_ID && opts.workerStart) await opts.workerStart();
                spawned.push(i.siteId);
                up.add(i.siteId);
                return { ok: true as const, pid: 4242 };
            },
            stop: async (id: string) => {
                stopped.push(id);
                up.delete(id);
            },
            alive: async (id: string) => up.has(id),
            readLog: async () => '',
        },
        probeReady: opts.probeReady ?? (async () => true),
        allocateFreePort: async () => (nextPort += 1),
        caddyBin: '/opt/genie/caddy',
        writeServeConfig: opts.writeServeConfig ?? ((siteId) => `/cfg/${siteId}.caddyfile`),
        prepareUploadTmpDir: (siteId) => `/gd/host-site-uploads/${siteId}`,
        resolveEngine: async () => ({
            ok: true as const,
            version: '8.4.24',
            install: {
                tool: 'php' as const,
                version: '8.4.24',
                dir: '/gd/toolchain/php/8.4.24',
                exe: '/gd/toolchain/php/8.4.24/php',
                source: 'genie' as const,
                removable: true,
            },
            exe: '/gd/toolchain/php/8.4.24/php-cgi',
        }),
        onProgress: (p) => progress.push(p),
    });
    return { m, spawned, up, stopped, progress };
}

describe('Stop while the site is waiting to answer (the reported case)', () => {
    it('ends the start as STOPPED, clears the phase, and takes both processes down', async () => {
        const answered = gate<boolean>();
        let probing = false;
        const h = harness({
            probeReady: async () => {
                probing = true;
                return answered.promise;
            },
        });

        const starting = h.m.start('prism', SITE_ID);
        while (!probing) await settle();
        // Control: the site really is mid-start, the state the owner saw.
        expect(h.m.list('prism')[0]?.phase).toBe('starting');

        await h.m.stop(SITE_ID, 'user');
        answered.open(false);

        // Resolves — it used to REJECT here, reading back an entry Stop had removed.
        const status = await starting;
        expect(status.state).toBe('stopped');

        const row = h.m.list('prism')[0];
        expect(row?.state).toBe('stopped');
        expect(row?.phase).toBeUndefined();
        expect(h.stopped).toEqual(expect.arrayContaining([SITE_ID, FCGI_ID]));
        expect(h.up.size).toBe(0);
        // The card is told the start is over, and not that it FAILED: the owner
        // stopped it.
        expect(h.progress.at(-1)?.phase).toBe('stopped');
    });

    it('can be started again afterwards', async () => {
        const answered = gate<boolean>();
        let calls = 0;
        const h = harness({
            probeReady: async () => (++calls === 1 ? answered.promise : true),
        });
        const first = h.m.start('prism', SITE_ID);
        while (calls === 0) await settle();
        await h.m.stop(SITE_ID, 'user');
        answered.open(false);
        await first;

        const again = await h.m.start('prism', SITE_ID);
        expect(again.state).toBe('running');
        expect(h.m.list('prism')[0]?.state).toBe('running');
    });
});

describe('Stop before the start has recorded anything', () => {
    it('wins: the start does not bring the site up afterwards, and what it spawned is stopped', async () => {
        const workerHeld = gate();
        let spawning = false;
        const h = harness({
            workerStart: async () => {
                spawning = true;
                await workerHeld.promise;
            },
        });

        const starting = h.m.start('prism', SITE_ID);
        while (!spawning) await settle();
        // Nothing is live yet — the branch that used to return and do nothing.
        expect(h.m.list('prism')[0]?.state).toBe('stopped');
        await h.m.stop(SITE_ID, 'user');
        workerHeld.open();

        const status = await starting;
        expect(status.state).toBe('stopped');
        const row = h.m.list('prism')[0];
        expect(row?.state).toBe('stopped');
        expect(row?.phase).toBeUndefined();
        // Whatever the start had already spawned is taken down, not left orphaned.
        expect(h.up.size).toBe(0);
        expect(h.progress.at(-1)?.phase).toBe('stopped');
    });

    it('POSITIVE CONTROL: without a Stop the same start comes up', async () => {
        const workerHeld = gate();
        let spawning = false;
        const h = harness({
            workerStart: async () => {
                spawning = true;
                await workerHeld.promise;
            },
        });
        const starting = h.m.start('prism', SITE_ID);
        while (!spawning) await settle();
        workerHeld.open();
        expect((await starting).state).toBe('running');
        expect(h.up.has(SITE_ID)).toBe(true);
    });

    it('a Start pressed after that Stop is honoured, not folded into the start being stopped', async () => {
        const workerHeld = gate();
        let spawns = 0;
        const h = harness({
            workerStart: async () => {
                if (++spawns === 1) await workerHeld.promise;
            },
        });
        const first = h.m.start('prism', SITE_ID);
        while (spawns === 0) await settle();
        await h.m.stop(SITE_ID, 'user');
        const second = h.m.start('prism', SITE_ID);
        workerHeld.open();

        expect((await first).state).toBe('stopped');
        expect((await second).state).toBe('running');
        expect(h.m.list('prism')[0]?.state).toBe('running');
    });
});

describe('a start that throws', () => {
    it('ends FAILED with the reason, never stuck on starting', async () => {
        const h = harness({
            writeServeConfig: () => {
                throw new Error('EACCES: config dir is read-only');
            },
        });
        const status = await h.m.start('prism', SITE_ID);
        expect(status.state).toBe('failed');
        expect(status.error).toContain('EACCES');
        expect(h.m.list('prism')[0]?.phase).toBeUndefined();
        expect(h.progress.at(-1)?.phase).toBe('failed');
    });
});
