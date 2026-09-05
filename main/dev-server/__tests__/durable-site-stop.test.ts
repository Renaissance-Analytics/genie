import { describe, expect, it } from 'vitest';
import { createDevSiteManager } from '../site-manager';
import { devSiteIdFor } from '../sites-config';
import type { SiteRunState } from '../site-manager';
import type { DevSiteConfig, DevSites } from '../sites-config';

/**
 * A STOP THAT SURVIVES A RESTART (genie#407).
 *
 * The report: *"sites I have stopped come back."* An upgrade is just a launch,
 * so the thing under test is `resumeEnabledSites()` — the one thing that starts
 * sites at boot — and `reconcile()`, which starts them on demand.
 *
 * Both gated on ONE flag, `config.enabled`, which was carrying two meanings at
 * once: *configured — this site should be served* (persistent, and stored in the
 * `.agi` envelope's git-TRACKED project.json, so it travels with the repo) and
 * *should be running right now* (a local, per-machine runtime decision). Writing
 * a stop into the first meant a user's local stop became a tracked diff their
 * teammates inherited, and a `git pull`/`checkout`/fresh clone put `enabled:true`
 * back — the site the user stopped, restarted, by a file.
 *
 * The two are separated here. `enabled` keeps the configured meaning; the
 * desired RUN state is a machine-local {@link SiteRunState}, and boot honours it.
 *
 * The rule: **Genie may restore what IT stopped on the user's behalf; it may
 * never restart what the USER stopped.** So `stop` takes an ORIGIN — a drain, a
 * quit, a workspace removal and a restart's own internal stop are all Genie's,
 * and every one of those still comes back.
 *
 * Each "stays down" assertion carries a POSITIVE CONTROL in the same test: a
 * sibling site that DOES start. "Nothing was started" is also what a manager
 * that starts nothing at all looks like.
 */

const WS = { id: 'acme', path: '/work/acme', label: 'acme' };

/** A managed host-native site: no container runtime is involved in deciding
 *  whether boot ASKS for it, which is the only question these tests put. */
function site(name: string, over: Partial<DevSiteConfig> = {}): DevSiteConfig {
    return {
        name,
        genName: `${name}.acme.gen`,
        repo: 'app',
        runMode: 'host',
        command: ['npm', 'run', 'dev'],
        kind: 'http',
        enabled: true,
        ...over,
    };
}

const WEB = devSiteIdFor('acme', 'web');
const API = devSiteIdFor('acme', 'api');

const SITES: DevSites = { [WEB]: site('web'), [API]: site('api') };

/** The machine-local run state, as genie.db backs it in the real host. */
function runState(): SiteRunState & { stopped: Set<string> } {
    const stopped = new Set<string>();
    return {
        stopped,
        setStopped(siteId, value) {
            if (value) stopped.add(siteId);
            else stopped.delete(siteId);
        },
        isStopped: (siteId) => stopped.has(siteId),
    };
}

function manager(state: SiteRunState, sites: DevSites = SITES) {
    return createDevSiteManager({
        resolveRuntime: async () => ({ runtime: null, detection: { kind: 'none', probes: [] } }),
        listWorkspaces: () => [WS],
        devSitesFor: () => sites,
        platform: 'linux',
        hostIds: null,
        probeReady: async () => true,
        runState: state,
    });
}

/**
 * Did boot ASK for this site?
 *
 * No `hostSpawn` is wired, so a managed host-native start fails immediately with
 * a sentence naming that — which is exactly the evidence wanted: a site the
 * manager ATTEMPTED reads `failed`, one it never touched reads `stopped`. It
 * distinguishes "was not started" from "was started and did not come up",
 * which a bare liveness check cannot.
 */
function attempted(rows: Array<{ siteId: string; state: string }>, siteId: string): boolean {
    return rows.find((r) => r.siteId === siteId)?.state === 'failed';
}

describe('resumeEnabledSites — a deliberate stop outranks the boot resume', () => {
    it('does not restart a site the USER stopped, and does restart its untouched sibling', async () => {
        const state = runState();
        const m = manager(state);

        await m.stop(WEB, 'user');
        await m.resumeEnabledSites();

        const rows = m.list(WS.id);
        expect(attempted(rows, WEB)).toBe(false);
        expect(attempted(rows, API)).toBe(true); // the positive control
    });

    it('DOES restart a site GENIE stopped — a drain, a quit, an upgrade', async () => {
        const state = runState();
        const m = manager(state);

        // `stopAll()` is what a drain runs, and it is Genie acting on the user's
        // behalf. Nothing about it is the user asking for the site to stay down.
        await m.stopAll();
        await m.resumeEnabledSites();

        expect(attempted(m.list(WS.id), WEB)).toBe(true);
        expect(attempted(m.list(WS.id), API)).toBe(true);
    });

    it('leaves the CONFIGURED flag alone — a stop is not an unconfigure', async () => {
        const state = runState();
        const sites: DevSites = { [WEB]: site('web') };
        const m = manager(state, sites);

        await m.stop(WEB, 'user');

        // `enabled` lives in the git-tracked envelope. A local stop must not put
        // a diff in it, or one developer's pause reaches the whole team.
        expect(sites[WEB]!.enabled).toBe(true);
        expect(state.stopped.has(WEB)).toBe(true);
    });

    it('a site nobody enabled is still started by nothing — strict opt-in is unchanged', async () => {
        const state = runState();
        const m = manager(state, { [WEB]: site('web', { enabled: false }), [API]: site('api') });

        await m.resumeEnabledSites();

        expect(attempted(m.list(WS.id), WEB)).toBe(false);
        expect(attempted(m.list(WS.id), API)).toBe(true);
    });
});

describe('reconcile — the same rule, on demand', () => {
    it('leaves a user-stopped site down while starting the rest', async () => {
        const state = runState();
        const m = manager(state);

        await m.stop(WEB, 'user');
        await m.reconcile();

        expect(attempted(m.list(WS.id), WEB)).toBe(false);
        expect(attempted(m.list(WS.id), API)).toBe(true);
    });
});

describe('starting again is how a stop is lifted', () => {
    it('an explicit start clears the stop, so the next launch resumes it', async () => {
        const state = runState();
        const m = manager(state);

        await m.stop(WEB, 'user');
        await m.start(WS.id, WEB);
        expect(state.isStopped(WEB)).toBe(false);

        await m.resumeEnabledSites();
        expect(attempted(m.list(WS.id), WEB)).toBe(true);
    });

    it('a restart is not a stop — its internal stop must not leave the site paused', async () => {
        const state = runState();
        const m = manager(state);

        await m.restart(WS.id, WEB);

        expect(state.isStopped(WEB)).toBe(false);
    });
});

describe('the stop is recorded even when stopping goes wrong', () => {
    it('remembers the ask before acting on it — a failed stop is still a stop', async () => {
        const state = runState();
        const m = createDevSiteManager({
            // The user asked for the site down; whether Genie could reach the
            // runtime to make that happen is a different question, and losing the
            // ask because of it is how a stopped site comes back at boot.
            resolveRuntime: async () => {
                throw new Error('Docker is not answering');
            },
            listWorkspaces: () => [WS],
            devSitesFor: () => ({ [WEB]: site('web', { runMode: 'explicit', port: 5173 }) }),
            platform: 'linux',
            hostIds: null,
            probeReady: async () => true,
            runState: state,
        });

        await m.start(WS.id, WEB).catch(() => {});
        await m.stop(WEB, 'user').catch(() => {});

        expect(state.isStopped(WEB)).toBe(true);
    });
});
