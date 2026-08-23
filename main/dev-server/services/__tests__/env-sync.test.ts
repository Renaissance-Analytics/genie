import { describe, expect, it } from 'vitest';
import {
    createServiceEnvSync,
    dotEnvServiceVars,
    dotEnvTargetsFor,
    withoutManagedServiceKeys,
} from '../env-sync';
import type { DevSites } from '../../sites-config';

/**
 * WHAT Genie writes into a repo's `.env`, and WHERE (genie#242).
 *
 * The defect this closes: a service's connection was injected into a terminal's
 * environment at spawn and nowhere else. Laravel's dotenv is IMMUTABLE — an
 * already-set variable beats `.env` — so a terminal carrying a port that had
 * since moved did not merely go stale, it OVERRODE the `.env` somebody had just
 * corrected. Meanwhile every process that was not launched from that one
 * terminal (a hosted site, a `manageProcess` worker, a shell the user opened
 * themselves) read the `.env` Genie never wrote.
 *
 * So the file the app reads is the thing that has to be right, and these two
 * pure functions decide what goes in it and which files get it.
 */

const HOST_ENV = {
    PGHOST: '127.0.0.1',
    PGPORT: '58377',
    PGUSER: 'ws_abc',
    PGPASSWORD: 'secret',
    PGDATABASE: 'ws_abc',
    MYSQL_HOST: '127.0.0.1',
    MYSQL_PORT: '51999',
    DATABASE_URL: 'postgresql://ws_abc:secret@127.0.0.1:58377/ws_abc',
    DB_CONNECTION: 'pgsql',
    DB_HOST: '127.0.0.1',
    DB_PORT: '58377',
    DB_DATABASE: 'ws_abc',
    DB_USERNAME: 'ws_abc',
    DB_PASSWORD: 'secret',
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: '51032',
    MAIL_MAILER: 'smtp',
    AWS_BUCKET: 'ws-abc',
    REVERB_APP_ID: 'ws_abc',
};

describe('dotEnvServiceVars', () => {
    it("carries the APPLICATION's configuration — the names the framework reads", () => {
        const vars = dotEnvServiceVars(HOST_ENV);

        // This is the whole point: the app reads `.env`, so `.env` is where the
        // live port has to be.
        expect(vars.DB_PORT).toBe('58377');
        expect(vars.DB_HOST).toBe('127.0.0.1');
        expect(vars.DB_CONNECTION).toBe('pgsql');
        expect(vars.DATABASE_URL).toBe('postgresql://ws_abc:secret@127.0.0.1:58377/ws_abc');
        expect(vars.REDIS_PORT).toBe('51032');
        expect(vars.MAIL_MAILER).toBe('smtp');
        expect(vars.AWS_BUCKET).toBe('ws-abc');
        expect(vars.REVERB_APP_ID).toBe('ws_abc');
    });

    it('leaves the CLIENT-TOOL variables out', () => {
        // `PG*` and `MYSQL_*` exist so `psql` and `mysql` connect with nothing
        // typed — that is a property of a SHELL, not of an application, and no
        // framework reads them out of a `.env`. Writing them would put a second
        // copy of the same credential in the file for nobody to read.
        const vars = dotEnvServiceVars(HOST_ENV);
        for (const key of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'MYSQL_HOST', 'MYSQL_PORT']) {
            expect(vars, key).not.toHaveProperty(key);
        }
    });

    it('is empty when the workspace has no services', () => {
        expect(dotEnvServiceVars({})).toEqual({});
    });
});

describe('dotEnvTargetsFor', () => {
    const site = (name: string, repo: string) =>
        ({ name, genName: `${name}.gen`, repo, runMode: 'host' }) as DevSites[string];

    it('names the repo behind every site the workspace hosts', () => {
        const sites: DevSites = { a: site('web', 'tynn'), b: site('api', 'genie') };
        expect(dotEnvTargetsFor(sites).sort()).toEqual(['genie', 'tynn']);
    });

    it('DE-DUPLICATES two sites in one repo', () => {
        const sites: DevSites = { a: site('web', 'tynn'), b: site('admin', 'tynn') };
        expect(dotEnvTargetsFor(sites)).toEqual(['tynn']);
    });

    it("maps a workspace-root site to the workspace's own .env", () => {
        // `repo: ''` means the workspace root, which is what `resolveEnvTarget`
        // calls `workspace`.
        expect(dotEnvTargetsFor({ a: site('web', '') })).toEqual(['workspace']);
    });

    it('writes NOTHING for a workspace with no sites', () => {
        // Genie only writes into repos it was told to host. Scattering database
        // credentials through every checkout under `repos/` on the guess that one
        // of them is an app is not a thing to do to somebody's working tree.
        expect(dotEnvTargetsFor({})).toEqual([]);
    });
});

/**
 * The composition: workspace → its sites' repos → their `.env` files.
 *
 * Pure, with the write injected, so the whole decision is testable without a
 * container runtime or a temp directory. `env-store.applyEnvBlock` is the real
 * write; its own safety contract is proven in `main/__tests__/env-store.test.ts`.
 */
describe('createServiceEnvSync', () => {
    const site = (name: string, repo: string) =>
        ({ name, genName: `${name}.gen`, repo, runMode: 'host' }) as DevSites[string];

    interface Written {
        root: string;
        target?: string;
        vars: Record<string, string>;
    }

    function harness(over: Partial<Parameters<typeof createServiceEnvSync>[0]> = {}) {
        const written: Written[] = [];
        const sync = createServiceEnvSync({
            workspaceFor: () => ({ path: '/work/a' }),
            devSitesFor: () => ({ s1: site('web', 'tynn') }),
            hostEnvFor: () => ({ DB_PORT: '58377', PGPORT: '58377' }),
            write: (root, req) => {
                written.push({ root, ...(req.target ? { target: req.target } : {}), vars: req.vars });
                return { ok: true, changed: true, keys: Object.keys(req.vars), file: 'repos/tynn/.env' };
            },
            ...over,
        });
        return { sync, written };
    }

    it("writes the app's connection into the repo behind the workspace's site", () => {
        const { sync, written } = harness();

        sync('a');

        expect(written).toHaveLength(1);
        expect(written[0].root).toBe('/work/a');
        expect(written[0].target).toBe('tynn');
        expect(written[0].vars).toEqual({ DB_PORT: '58377' });
    });

    it('writes NOTHING when the workspace hosts no sites', () => {
        const { sync, written } = harness({ devSitesFor: () => ({}) });
        sync('a');
        expect(written).toEqual([]);
    });

    it('writes NOTHING when the workspace has no services yet', () => {
        // An empty env is "nothing is provisioned", not "clear the file". Blanking
        // a `.env` because an engine has not started would be worse than the stale
        // value this feature exists to fix.
        const { sync, written } = harness({ hostEnvFor: () => ({}) });
        sync('a');
        expect(written).toEqual([]);
    });

    it('writes NOTHING for a workspace it cannot locate on disk', () => {
        const { sync, written } = harness({ workspaceFor: () => null });
        sync('a');
        expect(written).toEqual([]);
    });

    it('keeps going when ONE repo cannot be written, and never throws', () => {
        // This runs on a service lifecycle tick. A `.env` the user made read-only,
        // or a repo that is not checked out, must not cost the other repos their
        // update — nor fail the engine acquire that triggered it.
        const written: string[] = [];
        const sync = createServiceEnvSync({
            workspaceFor: () => ({ path: '/work/a' }),
            devSitesFor: () => ({ s1: site('web', 'gone'), s2: site('api', 'tynn') }),
            hostEnvFor: () => ({ DB_PORT: '58377' }),
            write: (_root, req) => {
                if (req.target === 'gone') throw new Error('repo is not checked out');
                written.push(req.target ?? 'workspace');
                return { ok: true, changed: true, keys: [], file: 'x' };
            },
        });

        expect(() => sync('a')).not.toThrow();
        expect(written).toEqual(['tynn']);
    });

    /**
     * A refusal nobody is told about is indistinguishable from success.
     *
     * Tolerating a failed `.env` write is right — an engine must still come up.
     * Discarding the REASON is not: the port then moves, the file keeps the old
     * one, and the user is left with `Connection refused` and no thread to pull.
     * That is the same silence the terminal-injection bug hid behind.
     */
    it('REPORTS a `.env` it could not write, instead of swallowing the reason', () => {
        const problems: string[] = [];
        const sync = createServiceEnvSync({
            workspaceFor: () => ({ path: '/work/a' }),
            devSitesFor: () => ({ s1: site('web', 'tynn') }),
            hostEnvFor: () => ({ DB_PORT: '58377' }),
            write: () => ({
                ok: false,
                changed: false,
                keys: [],
                file: 'repos/tynn/.env',
                error: '.env is read-only — Genie left it untouched',
            }),
            onProblem: (m) => problems.push(m),
        });

        sync('a');

        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('repos/tynn/.env');
        expect(problems[0]).toContain('read-only');
    });

    it('REPORTS a warning from a write that otherwise succeeded', () => {
        const problems: string[] = [];
        const sync = createServiceEnvSync({
            workspaceFor: () => ({ path: '/work/a' }),
            devSitesFor: () => ({ s1: site('web', 'tynn') }),
            hostEnvFor: () => ({ DB_PASSWORD: 'hunter2' }),
            write: () => ({
                ok: true,
                changed: true,
                keys: ['DB_PASSWORD'],
                file: 'repos/tynn/.env',
                gitTracked: true,
                warning: 'repos/tynn/.env is TRACKED by git',
            }),
            onProblem: (m) => problems.push(m),
        });

        sync('a');

        expect(problems).toEqual(['repos/tynn/.env is TRACKED by git']);
    });

    it('reports the THROWN failure too, and still writes the other repos', () => {
        const problems: string[] = [];
        const written: string[] = [];
        const sync = createServiceEnvSync({
            workspaceFor: () => ({ path: '/work/a' }),
            devSitesFor: () => ({ s1: site('web', 'gone'), s2: site('api', 'tynn') }),
            hostEnvFor: () => ({ DB_PORT: '58377' }),
            write: (_root, req) => {
                if (req.target === 'gone') throw new Error('repo is not checked out');
                written.push(req.target ?? 'workspace');
                return { ok: true, changed: true, keys: [], file: 'x' };
            },
            onProblem: (m) => problems.push(m),
        });

        sync('a');

        expect(written).toEqual(['tynn']);
        expect(problems.join(' ')).toContain('not checked out');
    });

    it('a broken onProblem listener can never fail the sync', () => {
        const sync = createServiceEnvSync({
            workspaceFor: () => ({ path: '/work/a' }),
            devSitesFor: () => ({ s1: site('web', 'tynn') }),
            hostEnvFor: () => ({ DB_PORT: '58377' }),
            write: () => ({ ok: false, changed: false, keys: [], error: 'nope' }),
            onProblem: () => {
                throw new Error('listener exploded');
            },
        });
        expect(() => sync('a')).not.toThrow();
    });
});

/**
 * The workspace-root `.env` must not smuggle the connection back INTO a shell.
 *
 * A site's `repo` defaults to `''` — the workspace root — so the file Genie
 * writes is very often `<workspace>/.env`. That file is ALSO loaded wholesale
 * into every terminal's environment (`buildTerminalEnv` → `loadWorkspaceEnvVars`,
 * which exists so a human can set workspace-wide config like the Tynn token).
 *
 * Left alone, the fix would defeat itself: Genie writes `DB_PORT` into the file
 * for the app to read, the loader exports it into every shell, and an exported
 * variable beats `.env` — not just the root one, but EVERY repo's, since it is
 * ambient for anything launched from that terminal. That is strictly worse than
 * the bug being fixed.
 *
 * So a terminal does not inherit the keys GENIE wrote. The user's own entries in
 * that file are untouched.
 */
describe('withoutManagedServiceKeys', () => {
    it('drops the keys Genie manages, so a shell cannot outrank the file', () => {
        const kept = withoutManagedServiceKeys(
            { TYNN_AGENT_TOKEN: 'rpk_x', DB_PORT: '58377', DB_HOST: '127.0.0.1' },
            { DB_PORT: '58377', DB_HOST: '127.0.0.1', PGPORT: '58377' },
        );
        expect(kept).toEqual({ TYNN_AGENT_TOKEN: 'rpk_x' });
    });

    it('drops a managed key even when the FILE has gone stale', () => {
        // The stale value is the whole danger — dropping only exact matches would
        // export precisely the wrong ports.
        expect(
            withoutManagedServiceKeys({ DB_PORT: '51157' }, { DB_PORT: '58377' }),
        ).toEqual({});
    });

    it("leaves the file alone when the workspace has no services", () => {
        const vars = { DB_PORT: '5432', TYNN_AGENT_TOKEN: 'rpk_x' };
        expect(withoutManagedServiceKeys(vars, {})).toEqual(vars);
    });

    it('never withholds a CLIENT-TOOL name, which Genie does not write', () => {
        // `PGPORT` is not in the managed block, so a `PGPORT` in the workspace
        // `.env` is the user's own and still reaches their shell.
        expect(
            withoutManagedServiceKeys({ PGPORT: '5432' }, { DB_PORT: '58377', PGPORT: '58377' }),
        ).toEqual({ PGPORT: '5432' });
    });
});
