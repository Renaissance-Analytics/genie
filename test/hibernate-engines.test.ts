import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { asleepOnlyEngine, enginesToRelease, enginesToResume } from '../src/core/hibernate-engines.js';
import { reconcileEngines } from '../src/core/engine-reconcile.js';
import type { ServiceInstance } from '../src/core/services.js';

/**
 * HIBERNATE RELEASES THE WORKSPACE'S ENGINES (parity audit 2026-10-30, top-15 #12).
 *
 * Genie 2's hibernate stopped agents, terminals and processes and never told the service registry, so a sleeping
 * workspace's Postgres and Redis kept running. Genie 1 (v0.7.0-beta.342) released them: `main/workspace/hibernation.ts`
 * step 3 ("services released (an engine nobody else holds stops with it, so resources aren't burning for no reason)"),
 * through `main/dev-server/lifecycle.ts` `teardown` (`services.release` for each of the workspace's services), and its
 * wake brought every enabled service back (`onWorkspaceWake`). A hibernated workspace stayed asleep through restarts
 * (`hibernation.ts` header: "do not wake up after upgrades or restarts").
 */
const engine = (id: string, scope: ServiceInstance['scope']): ServiceInstance =>
    ({ id, engine: 'postgres', version: '17', scope, publishedPort: 5400, credentials: {}, active: true }) as ServiceInstance;

const own = engine('pg_acme', { kind: 'dedicated', workspaceId: 'acme' });
const theirs = engine('pg_beta', { kind: 'dedicated', workspaceId: 'beta' });
const sharedPg = engine('pg_shared', { kind: 'shared' });
const sharedRedis = engine('redis_shared', { kind: 'shared' });
const instances = [own, theirs, sharedPg, sharedRedis];

/** Which engines each workspace USES (registry.choices(ws).chosen): acme uses its own + both shared; beta its own + shared pg. */
const uses: Record<string, string[]> = { acme: ['pg_acme', 'pg_shared', 'redis_shared'], beta: ['pg_beta', 'pg_shared'], gamma: [] };
const chosen = (ws: string) => new Set(uses[ws] ?? []);

describe('which engines a hibernating workspace releases', () => {
    it('its own (dedicated) engines; a shared one only when no OTHER awake workspace uses it', () => {
        const ids = enginesToRelease({ workspaceId: 'acme', instances, chosen, workspaces: [{ id: 'acme', asleep: false }, { id: 'beta', asleep: false }, { id: 'gamma', asleep: false }] });
        // pg_shared stays: beta, awake, uses it. redis_shared goes: only acme used it.
        expect(ids.sort()).toEqual(['pg_acme', 'redis_shared']);
    });

    it('a shared engine whose other users are all asleep too is released', () => {
        const ids = enginesToRelease({ workspaceId: 'acme', instances, chosen, workspaces: [{ id: 'acme', asleep: false }, { id: 'beta', asleep: true }] });
        expect(ids.sort()).toEqual(['pg_acme', 'pg_shared', 'redis_shared']);
    });

    it('never another workspace\'s own engine, and never a shared one this workspace does not use', () => {
        const ids = enginesToRelease({ workspaceId: 'gamma', instances, chosen, workspaces: [{ id: 'acme', asleep: true }, { id: 'beta', asleep: true }, { id: 'gamma', asleep: false }] });
        expect(ids).toEqual([]);
    });
});

describe('which engines a woken workspace resumes', () => {
    it('its own and the shared ones it uses — minus any the person stopped', () => {
        expect(enginesToResume({ workspaceId: 'acme', instances, chosen, personStopped: new Set() }).sort()).toEqual(['pg_acme', 'pg_shared', 'redis_shared']);
        expect(enginesToResume({ workspaceId: 'acme', instances, chosen, personStopped: new Set(['redis_shared']) }).sort()).toEqual(['pg_acme', 'pg_shared']);
    });
});

describe('at Genie start, an engine only sleeping workspaces use stays stopped', () => {
    const ws = (asleep: Record<string, boolean>) => Object.entries(asleep).map(([id, a]) => ({ id, asleep: a }));
    it('an asleep workspace\'s own engine; a shared one every user of which is asleep', () => {
        const w = ws({ acme: true, beta: false, gamma: false });
        expect(asleepOnlyEngine(own, { chosen, workspaces: w })).toBe(true);
        expect(asleepOnlyEngine(sharedRedis, { chosen, workspaces: w })).toBe(true);
        expect(asleepOnlyEngine(sharedPg, { chosen, workspaces: w }), 'beta is awake and uses it').toBe(false);
        expect(asleepOnlyEngine(theirs, { chosen, workspaces: w })).toBe(false);
    });
    it('a shared engine nobody uses is not "asleep" (it is left to the ordinary rules)', () => {
        expect(asleepOnlyEngine(engine('mail_shared', { kind: 'shared' }), { chosen, workspaces: ws({ acme: true }) })).toBe(false);
    });

    it('the boot reconcile skips it — reported, never started', async () => {
        const started: string[] = [];
        const report = await reconcileEngines({
            available: async () => ({ ok: true }) as never,
            instances: () => [own, theirs],
            // Running once started, so the readiness wait for one it starts ends (the clock here never moves).
            state: async (id) => (started.includes(id) ? 'running' : 'exited'),
            personStopped: () => new Set(),
            asleepOnly: (i) => i.id === 'pg_acme',
            start: async (id) => { started.push(id); },
            answers: async () => true,
            now: () => 0,
            sleep: async () => {},
        }, { timeoutMs: 10, pollMs: 1 });
        expect(started).toEqual(['pg_beta']);
        expect(report.engines.find((e) => e.id === 'pg_acme')).toMatchObject({ outcome: 'asleep' });
    });
});

describe('Genie wires it', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const compose = readFileSync(new URL('../src/main/compose.ts', import.meta.url), 'utf8');
    it('the boot reconcile is told which engines only sleeping workspaces use (compose.ts)', () => {
        expect(compose).toMatch(/reconcileEngines\(\s*\{[\s\S]{0,1500}?asleepOnly: \(i\) => asleepOnlyEngine\(i,/);
    });
    it('the workspace ops get the engines port from the composition (main.ts)', () => {
        const ops = main.slice(main.indexOf('const workspaceOps: WorkspaceOpsPorts = {'));
        expect(ops).toMatch(/^\s*engines: \{[\s\S]{0,800}?services\?\.hibernationEngines\.toRelease\([\s\S]{0,800}?services\?\.hibernationEngines\.toResume\(/m);
        expect(compose).toMatch(/hibernationEngines: \{[\s\S]{0,1500}?enginesToRelease\([\s\S]{0,1500}?enginesToResume\(/);
    });
});
