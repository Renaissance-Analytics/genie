import { describe, expect, it } from 'vitest';
import {
    buildHostServe,
    serveConfigIncomplete,
    canOpenInBrowser,
    devServerGuidance,
    holdersNote,
    hostServePatch,
    isolationNote,
    optionCaveat,
    optionLabel,
    railSitesTitle,
    railSitesTone,
    runtimeSummary,
    serveModeOf,
    serviceStatusLabel,
    serviceStatusTone,
    serviceTitle,
    serviceVersionChoice,
    siteIsStarting,
    sitePhaseBadge,
    sitePhaseLabel,
    siteReach,
    siteStatusLabel,
    siteStatusTone,
} from '../dev-server';
import type { DevServiceInfo, DevSiteInfo } from '../genie';

/**
 * The Site Manager's DECISIONS (Tynn #234 P4), separated from its wiring.
 *
 * The renderer test environment has no DOM, so everything the panel decides
 * lives here as a pure function and the component is the wiring — the same
 * split the beta.218 Site Manager used, kept because it is what makes the
 * judgements below assertable at all.
 *
 * Two of them are the reason this file exists rather than a handful of
 * ternaries inline:
 *
 *   - **`running` is not `ready`.** A container can be up while the dev server
 *     inside it has not bound its port. Reporting that as "running" sends the
 *     user to a URL that refuses the connection, which reads as a Genie bug.
 *   - **A shared engine's isolation is not uniform.** Postgres and MySQL give
 *     server-enforced database+role separation; the namespace engines (Mailpit,
 *     Meilisearch, MinIO) share a master key and are separated by a prefix. A
 *     UI that renders both as "isolated" is lying about where data can leak.
 */

const SITE: DevSiteInfo = {
    id: 'site-1',
    name: 'web',
    genName: 'web.acme.gen',
    repo: 'app',
    runMode: 'detected',
    kind: 'http',
    enabled: true,
    state: 'running',
    ready: true,
    port: 5173,
    hostPort: 49_812,
    origin: 'https://web.acme.gen',
    localOrigin: 'http://127.0.0.1:49812',
};

const PG: DevServiceInfo = {
    id: 'svc-1',
    engine: 'postgres',
    version: '16',
    engineKey: 'postgres-16',
    dedicated: false,
    enabled: true,
    state: 'running',
    ready: true,
    holders: 3,
    envKeys: ['DATABASE_URL', 'PGHOST'],
};

// --- a site's state ---------------------------------------------------------

describe('site status', () => {
    it('separates RUNNING from READY — a container that is up is not a site that answers', () => {
        expect(siteStatusTone(SITE)).toBe('running');
        expect(siteStatusTone({ ...SITE, ready: false })).toBe('starting');
        expect(siteStatusLabel({ ...SITE, ready: false })).toMatch(/has not answered|not answered/i);
    });

    it('a HOST-NATIVE not-ready site never says "container" — it has none', () => {
        // A `runMode:'host'` site is the repo's dev server on the host, so the
        // not-answering message calling it "the container" is wrong container
        // language on a site with no container (the user saw this on a host-native
        // `php artisan serve` site).
        const label = siteStatusLabel({ ...SITE, runMode: 'host', ready: false });
        expect(label).not.toMatch(/container/i);
        expect(label).toMatch(/dev server/i);
    });

    it('shows the runtime’s REASON on a failure, never a bare "failed"', () => {
        const label = siteStatusLabel({
            ...SITE,
            state: 'failed',
            ready: undefined,
            error: 'Building app’s Dockerfile failed: no such file',
        });
        expect(siteStatusTone({ ...SITE, state: 'failed' })).toBe('failed');
        expect(label).toContain('no such file');
    });

    it('refuses to offer the browser for a site that is not answering, or is not http', () => {
        expect(canOpenInBrowser(SITE)).toBe(true);
        // Up but not bound: the browser would show a connection refusal and the
        // user would blame Genie.
        expect(canOpenInBrowser({ ...SITE, ready: false })).toBe(false);
        expect(canOpenInBrowser({ ...SITE, state: 'stopped' })).toBe(false);
        // A TCP surface is published and listed; there is nothing to open.
        expect(canOpenInBrowser({ ...SITE, kind: 'tcp' })).toBe(false);
    });

    it('reports BOTH reaches, because they are different machines’ answers', () => {
        // The `.gen` origin works from a connected remote AND here; the loopback
        // one only here. An agent or a user pasting the wrong one is the single
        // most common dev-server confusion.
        expect(siteReach(SITE)).toEqual({
            browser: 'https://web.acme.gen',
            local: 'http://127.0.0.1:49812',
        });
        expect(siteReach({ ...SITE, state: 'stopped', origin: undefined, localOrigin: undefined }))
            .toEqual({ browser: null, local: null });
    });
});

// --- observable startup (Gap 2) ---------------------------------------------

describe('startup progress surfaces in the view model', () => {
    it('reads an in-flight phase as `starting`, whatever the settled state says', () => {
        // The point of Gap 2: the moment Start is clicked the row still says
        // `stopped`, but a `pulling`/`building`/`starting` phase must show a
        // spinner, not an idle dot.
        expect(siteStatusTone({ ...SITE, state: 'stopped', ready: undefined, phase: 'pulling' })).toBe(
            'starting',
        );
        expect(siteStatusTone({ ...SITE, state: 'stopped', ready: undefined, phase: 'building' })).toBe(
            'starting',
        );
        expect(siteStatusTone({ ...SITE, state: 'stopped', ready: undefined, phase: 'starting' })).toBe(
            'starting',
        );
        expect(siteIsStarting({ ...SITE, phase: 'building' })).toBe(true);
        expect(siteIsStarting({ ...SITE, phase: undefined })).toBe(false);
    });

    it('names the current stage in the status line while a site comes up', () => {
        expect(siteStatusLabel({ ...SITE, state: 'stopped', phase: 'pulling' })).toMatch(/pulling/i);
        expect(siteStatusLabel({ ...SITE, state: 'stopped', phase: 'building' })).toMatch(/building/i);
        expect(siteStatusLabel({ ...SITE, state: 'stopped', phase: 'starting' })).toMatch(
            /waiting|starting/i,
        );
    });

    it('shows a failed start IN the card, with its reason — never a silent button', () => {
        const tone = siteStatusTone({ ...SITE, state: 'failed', ready: undefined, phase: 'failed' });
        expect(tone).toBe('failed');
        expect(
            siteStatusLabel({
                ...SITE,
                state: 'failed',
                ready: undefined,
                phase: 'failed',
                error: 'Build step "Install" failed (exit 1)',
            }),
        ).toContain('Install');
    });

    it('gives each phase a short badge and a full sentence', () => {
        expect(sitePhaseBadge('pulling')).toMatch(/pull/i);
        expect(sitePhaseBadge('building')).toBe('Building');
        expect(sitePhaseBadge('starting')).toBe('Starting');
        expect(sitePhaseLabel('building')).toMatch(/build/i);
    });

    it('lights the rail amber while a site is starting, not idle', () => {
        expect(railSitesTone([{ ...SITE, state: 'stopped', phase: 'building' }], 'acme')).toBe(
            'starting',
        );
    });
});

// --- the rail indicator -----------------------------------------------------

describe('the rail sites indicator', () => {
    it('has no tone for a workspace that defines nothing (the icon renders greyed, not hidden)', () => {
        expect(railSitesTone([], 'acme')).toBeNull();
        expect(railSitesTone([{ ...SITE, enabled: false }], 'acme')).toBeNull();
    });

    it('gives the empty indicator a sensible tooltip rather than "0 hosted sites"', () => {
        const title = railSitesTitle([], 'acme');
        expect(title).toMatch(/no hosted sites/i);
        expect(title).toContain('Site Manager');
    });

    it('lets RUNNING win over failed — an amber dot on a workspace that is serving is a lie', () => {
        const rows = [
            { ...SITE, id: 'a', state: 'failed' as const },
            { ...SITE, id: 'b' },
        ];
        expect(railSitesTone(rows, 'acme')).toBe('running');
    });

    it('still surfaces a failure when nothing else is up', () => {
        expect(railSitesTone([{ ...SITE, state: 'failed' }], 'acme')).toBe('failed');
        expect(railSitesTone([{ ...SITE, state: 'stopped' }], 'acme')).toBe('idle');
    });

    it('counts what it found in the tooltip', () => {
        const title = railSitesTitle([{ ...SITE }, { ...SITE, id: 'b', state: 'failed' }], 'acme');
        expect(title).toContain('2 hosted sites');
        expect(title).toContain('1 running');
        expect(title).toContain('1 failed');
    });
});

// --- a service --------------------------------------------------------------

describe('service status', () => {
    it('names the engine and its version, because the VERSION is the sharing unit', () => {
        expect(serviceTitle(PG)).toBe('Postgres 16');
        expect(serviceTitle({ ...PG, engine: 'minio', version: '2025' })).toBe('MinIO 2025');
        expect(serviceTitle({ ...PG, engine: 'custom', version: '' })).toBe('Custom image');
    });

    it('says how many OTHER workspaces a release would leave holding the engine', () => {
        // The point of the shared model, and the thing that surprises people:
        // "stop" here does not stop the container unless you were the last one.
        expect(holdersNote({ ...PG, holders: 3 })).toMatch(/3 workspaces/);
        expect(holdersNote({ ...PG, holders: 1 })).toMatch(/only this workspace/i);
        expect(holdersNote({ ...PG, dedicated: true, holders: 1 })).toMatch(/dedicated/i);
        expect(holdersNote({ ...PG, state: 'stopped', holders: undefined })).toBeNull();
    });

    it('tells the truth about how strong each provisioning strategy really is', () => {
        // sql-database-role is server-enforced; a namespace engine is a shared
        // master key and a prefix. Rendering them identically would claim an
        // isolation that does not exist.
        expect(isolationNote('sql-database-role')).toMatch(/own database and role/i);
        expect(isolationNote('redis-acl')).toMatch(/ACL user/i);
        const namespace = isolationNote('namespace');
        expect(namespace).toMatch(/shares?.*(key|credential)/i);
        expect(namespace).not.toMatch(/cannot reach/i);
    });

    it('surfaces a failed engine’s reason', () => {
        expect(serviceStatusTone({ ...PG, state: 'failed' })).toBe('failed');
        expect(
            serviceStatusLabel({ ...PG, state: 'failed', error: 'Postgres never became ready' }),
        ).toContain('never became ready');
        expect(serviceStatusTone({ ...PG, ready: false })).toBe('starting');
    });
});

// --- the runtime ------------------------------------------------------------

describe('the container runtime', () => {
    it('reports which runtime is driving', () => {
        const s = runtimeSummary({ kind: 'docker', version: '29.6.1' });
        expect(s.tone).toBe('running');
        expect(s.label).toMatch(/Docker/);
        expect(s.label).toContain('29.6.1');
    });

    it('turns "no runtime" into the install sentence, not an error', () => {
        // The ordinary first-run state on most desktops. It has to read as a
        // next step, because that is exactly what it is.
        const s = runtimeSummary({ kind: 'none', installHint: 'Install Docker Desktop.' });
        expect(s.tone).toBe('idle');
        expect(s.guidance).toBe('Install Docker Desktop.');
    });

    it('always has SOMETHING to say when there is no runtime, even with no hint', () => {
        expect(runtimeSummary({ kind: 'none' }).guidance).toBeTruthy();
        expect(runtimeSummary(null).guidance).toBeTruthy();
    });

    it('guides a remote window to the machine that actually runs the containers', () => {
        expect(devServerGuidance('remote')).toMatch(/machine itself|on that machine/i);
        expect(devServerGuidance('ready')).toBeNull();
    });
});

// --- the serve-mode picker (host-native, Genie serves it) -------------------

describe('the serve-mode picker (proxy | static | php)', () => {
    it('reads a site’s current serve mode from its stored hostServe', () => {
        // No hostServe = the repo runs its OWN dev server (Genie only proxies) —
        // the picker's default, and the pre-#167 behaviour for every site.
        expect(serveModeOf(SITE)).toBe('proxy');
        expect(serveModeOf({ ...SITE, hostServe: { mode: 'static', root: 'dist' } })).toBe('static');
        expect(serveModeOf({ ...SITE, hostServe: { mode: 'php', root: 'public' } })).toBe('php');
    });

    it('builds the hostServe request field from the picker — proxy declares nothing', () => {
        // proxy = run the repo's own dev server; Genie generates no config, so the
        // request carries no hostServe at all (the config-less path).
        expect(buildHostServe('proxy', 'dist', true)).toBeUndefined();
        expect(buildHostServe('static', 'dist', false)).toEqual({ mode: 'static', root: 'dist' });
        expect(buildHostServe('static', 'dist', true)).toEqual({
            mode: 'static',
            root: 'dist',
            spa: true,
        });
        // php is not a client-routed bundle, so it never carries the SPA flag.
        expect(buildHostServe('php', 'public', true)).toEqual({ mode: 'php', root: 'public' });
        // The root is trimmed; a blank one yields nothing (the form guards submit,
        // this is the backstop so a half-filled static never ships an empty root).
        expect(buildHostServe('static', '  dist  ', false)).toEqual({ mode: 'static', root: 'dist' });
        expect(buildHostServe('static', '   ', false)).toBeUndefined();
        expect(buildHostServe('php', '', false)).toBeUndefined();
    });

    it('flags a serve mode that still needs a directory — the guard BOTH forms owe', () => {
        // proxy runs the repo's own dev server: nothing else to fill.
        expect(serveConfigIncomplete('proxy', '', false)).toBe(false);
        expect(serveConfigIncomplete('proxy', 'dist', false)).toBe(false);
        // static/php serve a folder, so an empty root is incomplete — saving it
        // would silently drop the mode (buildHostServe → undefined). This is the
        // predicate the Add form already guarded on and the Edit form did not,
        // which is why switching a site to "run PHP app" appeared to do nothing.
        expect(serveConfigIncomplete('php', '', false)).toBe(true);
        expect(serveConfigIncomplete('php', '   ', false)).toBe(true);
        expect(serveConfigIncomplete('php', 'public', false)).toBe(false);
        expect(serveConfigIncomplete('static', '', false)).toBe(true);
        expect(serveConfigIncomplete('static', 'dist', false)).toBe(false);
    });

    it('turns an Edit into a patch field — omit when unchanged, null to CLEAR back to proxy', () => {
        // Unchanged ⇒ omitted (undefined): the update never restarts a running site
        // for a serve mode that did not actually move.
        expect(hostServePatch(undefined, undefined)).toBeUndefined();
        expect(
            hostServePatch({ mode: 'static', root: 'dist' }, { mode: 'static', root: 'dist' }),
        ).toBeUndefined();
        // Set / change ⇒ the new config rides the patch.
        expect(hostServePatch(undefined, { mode: 'php', root: 'public' })).toEqual({
            mode: 'php',
            root: 'public',
        });
        expect(
            hostServePatch({ mode: 'static', root: 'dist' }, { mode: 'static', root: 'build' }),
        ).toEqual({ mode: 'static', root: 'build' });
        // static/php → proxy ⇒ an EXPLICIT null: a plain omit would leave the site
        // static forever, because the store merges the patch OVER the stored row.
        expect(hostServePatch({ mode: 'static', root: 'dist' }, undefined)).toBeNull();
    });
});

// --- the run-option picker --------------------------------------------------

describe('the layered run options', () => {
    it('leads with what the repo SAID about itself, and names the file it read', () => {
        expect(
            optionLabel({
                runMode: 'dockerfile',
                source: 'Dockerfile',
                reason: 'ships a Dockerfile',
                confident: false,
            }),
        ).toBe('Dockerfile — Dockerfile');
        expect(
            optionLabel({
                runMode: 'detected',
                stack: 'node',
                source: 'package.json',
                reason: 'npm run dev',
                confident: true,
                port: 5173,
            }),
        ).toBe('Node — package.json');
    });

    it('shows the GUESS, so nobody publishes 8080 and reports a working site', () => {
        expect(
            optionCaveat({
                runMode: 'detected',
                stack: 'go',
                source: 'go.mod',
                reason: 'go run .',
                confident: false,
                needs: 'the port this program listens on',
            }),
        ).toContain('the port this program listens on');
        expect(
            optionCaveat({
                runMode: 'detected',
                source: 'artisan',
                reason: 'artisan serve',
                confident: true,
            }),
        ).toBeNull();
    });
});

/**
 * PICKING THE ACTIVE VERSION (#242 P3).
 *
 * A workspace can hold postgres 16 AND 17 — different containers, different
 * volumes, different data — but `DATABASE_URL` names ONE connection. The panel
 * has to say which version the apps actually get, and let it be changed. It must
 * NOT clutter the ordinary case: a workspace with one Postgres has no choice to
 * make, so it gets no badge and no button.
 */
describe('serviceVersionChoice', () => {
    const svc = (over: Partial<DevServiceInfo> = {}): DevServiceInfo => ({
        id: 'pg16',
        engine: 'postgres',
        version: '16',
        engineKey: 'postgres-16',
        dedicated: false,
        enabled: true,
        state: 'running',
        ...over,
    });

    it('offers nothing when the workspace holds ONE version of the engine', () => {
        const only = svc();
        expect(serviceVersionChoice(only, [only])).toEqual({ contested: false });
    });

    it('marks the ACTIVE row when two versions of one engine are held', () => {
        const a = svc({ id: 'pg16', version: '16', active: true });
        const b = svc({ id: 'pg17', version: '17', engineKey: 'postgres-17' });
        expect(serviceVersionChoice(a, [a, b])).toMatchObject({ contested: true, isActive: true });
    });

    it('offers the switch on the row that is NOT active', () => {
        const a = svc({ id: 'pg16', version: '16', active: true });
        const b = svc({ id: 'pg17', version: '17', engineKey: 'postgres-17' });
        expect(serviceVersionChoice(b, [a, b])).toMatchObject({
            contested: true,
            isActive: false,
            activeVersion: '16',
        });
    });

    it('treats an unchosen pair as contested, so the panel still explains itself', () => {
        // Neither marked: the environment still resolves to one of them, so the
        // user needs to see that a choice exists (and which way it fell).
        const a = svc({ id: 'pg16', version: '16' });
        const b = svc({ id: 'pg17', version: '17', engineKey: 'postgres-17' });
        expect(serviceVersionChoice(a, [a, b]).contested).toBe(true);
    });

    it('does not confuse DIFFERENT engines for versions of one', () => {
        const pg = svc();
        const redis = svc({ id: 'r7', engine: 'redis', version: '7', engineKey: 'redis-7' });
        expect(serviceVersionChoice(pg, [pg, redis])).toEqual({ contested: false });
    });
});
