import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { devSiteIdFor, sanitizeDevSitePatch } from '../../dev-server/sites-config';
import type { DevSiteConfig } from '../../dev-server/sites-config';
import type { DevSiteRow, DevSiteStatus } from '../../dev-server/site-manager';

/**
 * genie#538 — **a Laravel site must not end up on the single-threaded `artisan
 * serve` fallback, and it must never get there in silence.**
 *
 * The report: a Laravel site sat at `running / ready:false` for good. Its server
 * was `php artisan serve` with ONE worker, so a single 15–40s endpoint polled every
 * 15s saturated it permanently — Genie's own readiness probe included. That path
 * also holds an `artisan serve` parent PLUS its `php -S` child, where FastCGI would
 * have been no process of Genie's at all.
 *
 * ## What the report got right, and what it got wrong
 *
 * `serve-recipe.ts` says the `artisan serve` branch is reachable "only by a PHP repo
 * with no front controller to serve", and the reporting repo had both markers. So
 * the site should never have been there. That much stands.
 *
 * The proposed mechanism does not. genie#538's comment blames `hostPort` for
 * suppressing detection — but a `hostPort` site is the one shape where Genie spawns
 * NOTHING (`site-manager.ts` takes the route-only path "whatever its `runMode`
 * says"), so it cannot reach `artisan serve`; and the reported site carried a stored
 * `stack: 'php'`, which `create` writes on exactly one path — the detected dev-server
 * branch, reached only when `hostPort` was absent and `detectPhpServe` came back
 * null.
 *
 * ## The defect that is actually there
 *
 * **The decision is taken once, at create, and never revisited or spoken.** A site
 * created before `detectPhpServe` existed (2026-08-26, genie#274), or before the
 * repo had a `public/index.php`, stores the fallback argv and keeps running it
 * forever — long after Genie would answer differently and long after the repo stopped
 * needing it. Nothing re-asks, and nothing ever says which architecture was chosen or
 * why, which is why finding this took a bug report.
 *
 * So: Genie re-decides ITS OWN choice at start, and every decline is stated.
 */

// --- the seams runManageSite reaches through --------------------------------

const store = vi.hoisted(() => {
    const sites: Record<string, DevSiteConfig> = {};
    return { sites };
});

const db = vi.hoisted(() => ({
    setWorkspaceDevSite: vi.fn(),
    deleteWorkspaceDevSite: vi.fn(),
}));

vi.mock('../../db', () => ({
    getWorkspaceDevSites: () => store.sites,
    setWorkspaceDevSite: db.setWorkspaceDevSite,
    deleteWorkspaceDevSite: db.deleteWorkspaceDevSite,
}));

const manager = vi.hoisted(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    reconfigure: vi.fn(),
    list: vi.fn(),
    logs: vi.fn(),
    refresh: vi.fn(),
}));

vi.mock('../../dev-server/site-manager', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../dev-server/site-manager')>()),
    devSiteManager: () => manager,
}));
vi.mock('../../dev-server', () => ({
    resolveContainerRuntime: async () => ({ detection: { kind: 'docker', version: '29.6.1' } }),
}));
vi.mock('../../workspace/detect', () => ({ detectFolder: () => ({ repos: ['app'] }) }));
vi.mock('../host-tools', () => ({ resolveAgentTarget: async () => ({ decision: { allowed: false } }) }));

// NOTHING from `repo-facts` is mocked here — that is the point of this file. The
// sibling `manage-site-host.test.ts` stubs the detector off so its own cases keep
// exercising the dev-server path; a test about WHICH architecture a repo gets has
// to read a real repo off a real disk.

import { resetDevServerDetectionCache, runManageSite } from '../dev-site-tools';

const WS_NAME = 'acme';
let root: string;

/** A workspace on disk with `repos/app` laid out from `files`. */
function workspace(files: Record<string, string>): { id: string; path: string; project_name: string } {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-php-arch-'));
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(root, 'repos', 'app', rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    }
    fs.mkdirSync(path.join(root, 'repos', 'app'), { recursive: true });
    return { id: WS_NAME, path: root, project_name: WS_NAME };
}

/** A Laravel repo: both markers `detectPhpServe` requires. */
const LARAVEL = { 'composer.json': '{}', 'public/index.php': '<?php' };
/** A PHP library: `composer.json`, no front controller — the fallback's real home. */
const PHP_LIB = { 'composer.json': '{}', 'src/Thing.php': '<?php' };

const SITE_ID = devSiteIdFor(WS_NAME, 'web');

const row = (over: Partial<DevSiteRow> = {}): DevSiteRow => ({
    siteId: SITE_ID,
    workspaceId: WS_NAME,
    name: 'web',
    genName: 'web.acme.gen',
    repo: 'app',
    runMode: 'host',
    kind: 'http',
    enabled: true,
    state: 'running',
    ready: true,
    ...over,
});

const status = (over: Partial<DevSiteStatus> = {}): DevSiteStatus => ({
    siteId: SITE_ID,
    workspaceId: WS_NAME,
    name: 'web',
    genName: 'web.acme.gen',
    state: 'running',
    ...over,
});

/** The exact config `create` stored for a Laravel repo BEFORE genie#274 — the shape
 *  the reporting site is still in. `stack: 'php'` is the fingerprint: `create`
 *  writes it only on the detected dev-server branch, never for a caller's own
 *  `command`. */
const FROZEN_FALLBACK: DevSiteConfig = {
    name: 'web',
    genName: 'web.acme.gen',
    repo: 'app',
    runMode: 'host',
    stack: 'php',
    framework: 'laravel',
    command: ['php', 'artisan', 'serve', '--host=127.0.0.1', '--port=8000'],
    kind: 'http',
    enabled: true,
};

beforeEach(() => {
    resetDevServerDetectionCache();
    for (const key of Object.keys(store.sites)) delete store.sites[key];
    db.setWorkspaceDevSite.mockReset();
    db.setWorkspaceDevSite.mockImplementation(
        (_ws: string, patch: Partial<DevSiteConfig> & { siteId?: string }) => {
            const clean = sanitizeDevSitePatch(patch);
            const name = clean.name ?? (patch.siteId ? store.sites[patch.siteId]?.name : undefined);
            if (!name) return null;
            const id = devSiteIdFor(WS_NAME, name);
            store.sites[id] = {
                ...(store.sites[patch.siteId ?? id] ?? {}),
                ...clean,
                name,
            } as DevSiteConfig;
            return id;
        },
    );
    db.deleteWorkspaceDevSite.mockReset();
    for (const fn of Object.values(manager)) fn.mockReset();
    manager.list.mockReturnValue([row()]);
    manager.start.mockResolvedValue(status());
    manager.restart.mockResolvedValue(status());
    manager.reconfigure.mockResolvedValue(status());
    manager.stop.mockResolvedValue(undefined);
    manager.logs.mockResolvedValue('');
    manager.refresh.mockResolvedValue(undefined);
});

const notesOf = (r: { notes?: string[] }) => (r.notes ?? []).join('\n');

describe('create — which architecture a PHP repo gets, and whether it is spoken', () => {
    it('POSITIVE CONTROL: a bare create on a Laravel repo is served over FastCGI', async () => {
        // The behaviour every case below is measured against. If this ever stops
        // holding, the whole file is asserting something about a broken detector
        // rather than about the gate.
        const ws = workspace(LARAVEL);

        const res = await runManageSite(ws, { action: 'create', name: 'web', repo: 'app' });

        expect(res.ok).toBe(true);
        expect(store.sites[SITE_ID]?.hostServe).toEqual({ mode: 'php', root: 'public' });
        expect(store.sites[SITE_ID]?.command).toBeUndefined();
    });

    it('says PHP when it detected PHP — not "a built static site"', async () => {
        // The note that DOES fire today is written for `detectStaticServe` and fires
        // for a PHP detection too, so a Laravel site was told Genie had "detected a
        // built static site (public/)". Wrong architecture named, in the one sentence
        // that was supposed to make the choice visible.
        const ws = workspace(LARAVEL);

        const res = await runManageSite(ws, { action: 'create', name: 'web', repo: 'app' });

        expect(notesOf(res)).toMatch(/PHP|FastCGI/i);
        expect(notesOf(res)).not.toMatch(/built static site/i);
    });

    it('POSITIVE CONTROL: an explicit `command` still suppresses detection', async () => {
        // A fix that always detects is as wrong as one that never does. A caller who
        // says HOW to run the app gets what they asked for.
        const ws = workspace(LARAVEL);

        const res = await runManageSite(ws, {
            action: 'create',
            name: 'web',
            repo: 'app',
            command: ['php', 'artisan', 'octane:start'],
            port: 8000,
        });

        expect(res.ok).toBe(true);
        expect(store.sites[SITE_ID]?.hostServe).toBeUndefined();
        expect(store.sites[SITE_ID]?.command).toEqual(['php', 'artisan', 'octane:start']);
    });

    it('SAYS it declined FastCGI when the caller gave a `command`', async () => {
        // "When Genie declines a detected serve mode because the caller specified
        // something, it must say so" — the report's own words. A silent architectural
        // substitution is why this needed a bug report to find.
        const ws = workspace(LARAVEL);

        const res = await runManageSite(ws, {
            action: 'create',
            name: 'web',
            repo: 'app',
            command: ['php', 'artisan', 'octane:start'],
            port: 8000,
        });

        expect(notesOf(res)).toMatch(/FastCGI/i);
        expect(notesOf(res), 'the note must name WHAT overrode it').toMatch(/`command`/);
    });

    it('SAYS it declined FastCGI when the caller gave a `hostPort`', async () => {
        // `hostPort` stays a suppressor and that is CORRECT — it names a dev server
        // the caller already runs, and serving `public/` ourselves would ignore the
        // server they pointed us at. But an agent who reached for it to get a stable
        // port has just changed the serving architecture, and must be told.
        const ws = workspace(LARAVEL);

        const res = await runManageSite(ws, {
            action: 'create',
            name: 'web',
            repo: 'app',
            hostPort: 62_504,
        });

        expect(res.ok).toBe(true);
        expect(store.sites[SITE_ID]?.hostPort).toBe(62_504);
        expect(store.sites[SITE_ID]?.hostServe).toBeUndefined();
        expect(notesOf(res)).toMatch(/FastCGI/i);
        expect(notesOf(res)).toMatch(/`hostPort`/);
    });

    it('does NOT cry decline at a caller who asked for the mode Genie detected anyway', async () => {
        // `hostServe: {mode:'php'}` on a Laravel repo is the same answer detection
        // would have given. Telling that caller Genie "declined" it is noise, and
        // noise in `notes` is how the notes that matter stop being read.
        const ws = workspace(LARAVEL);

        const res = await runManageSite(ws, {
            action: 'create',
            name: 'web',
            repo: 'app',
            hostServe: { mode: 'php', root: 'public' },
        });

        expect(store.sites[SITE_ID]?.hostServe).toEqual({ mode: 'php', root: 'public' });
        expect(notesOf(res)).not.toMatch(/DECLINED/i);
    });

    it('DOES say so when the caller picks a DIFFERENT mode from the detected one', async () => {
        // Positive control for the case above: serving a Laravel repo's `public/` as
        // a static directory would hand out `index.php` as a file, and that is
        // precisely the substitution worth a sentence.
        const ws = workspace(LARAVEL);

        const res = await runManageSite(ws, {
            action: 'create',
            name: 'web',
            repo: 'app',
            hostServe: { mode: 'static', root: 'public' },
        });

        expect(notesOf(res)).toMatch(/DECLINED/i);
        expect(notesOf(res)).toMatch(/FastCGI/i);
    });

    it('warns that the `artisan serve` FALLBACK is single-threaded when it takes it', async () => {
        // A PHP repo with no front controller genuinely has nowhere else to go, and
        // the fallback stays. What must not stay is the silence: this is the server
        // whose ONE worker a single slow endpoint saturates permanently, and the site
        // is then two long-lived processes with nothing to supervise.
        const ws = workspace(PHP_LIB);

        const res = await runManageSite(ws, { action: 'create', name: 'web', repo: 'app' });

        expect(store.sites[SITE_ID]?.command?.join(' ')).toContain('artisan serve');
        expect(notesOf(res)).toMatch(/fallback/i);
        expect(notesOf(res)).toMatch(/single|one worker/i);
        expect(notesOf(res), 'and it must name the way out').toMatch(/public\/index\.php/);
    });
});

describe('start — Genie re-decides its OWN frozen choice (the reported site)', () => {
    it('moves a stale `artisan serve` site to FastCGI once the repo has a front controller', async () => {
        // The reported site, exactly: `runMode: host`, `stack: php`, and Genie's own
        // fallback argv, on a repo that satisfies `detectPhpServe` today. Genie
        // authored that command — re-deciding it on the same rule `create` uses is
        // not a substitution behind the user's back, it is the default catching up.
        const ws = workspace(LARAVEL);
        store.sites[SITE_ID] = { ...FROZEN_FALLBACK };

        const res = await runManageSite(ws, { action: 'start', id: SITE_ID });

        expect(res.ok).toBe(true);
        expect(store.sites[SITE_ID]?.hostServe).toEqual({ mode: 'php', root: 'public' });
        expect(manager.start).toHaveBeenCalled();
    });

    it('SAYS so, naming the single worker that made it matter', async () => {
        const ws = workspace(LARAVEL);
        store.sites[SITE_ID] = { ...FROZEN_FALLBACK };

        const res = await runManageSite(ws, { action: 'start', id: SITE_ID });

        expect(notesOf(res)).toMatch(/FastCGI/i);
        expect(notesOf(res)).toMatch(/artisan serve/);
    });

    it('does the same on `restart` — the action the reporter kept reaching for', async () => {
        // Their words: `ready:false` never became `failed`, "which is why they kept
        // restarting it". The restart they were already doing is where the fix has to
        // land, or it never reaches them.
        const ws = workspace(LARAVEL);
        store.sites[SITE_ID] = { ...FROZEN_FALLBACK };

        await runManageSite(ws, { action: 'restart', id: SITE_ID });

        expect(store.sites[SITE_ID]?.hostServe).toEqual({ mode: 'php', root: 'public' });
    });

    it("POSITIVE CONTROL: never touches a command the USER supplied", async () => {
        // A caller's own argv has no `stack` — `create` writes that only on the
        // detected branch. Re-deciding someone else's command would be the silent
        // substitution this issue is about, pointed the other way.
        const ws = workspace(LARAVEL);
        const mine: DevSiteConfig = {
            ...FROZEN_FALLBACK,
            command: ['php', 'artisan', 'serve', '--port=8000'],
        };
        delete mine.stack;
        delete mine.framework;
        store.sites[SITE_ID] = mine;

        const res = await runManageSite(ws, { action: 'start', id: SITE_ID });

        expect(store.sites[SITE_ID]?.hostServe).toBeUndefined();
        expect(store.sites[SITE_ID]?.command).toEqual(mine.command);
        expect(notesOf(res)).not.toMatch(/FastCGI/i);
    });

    it('POSITIVE CONTROL: leaves the fallback alone when the repo still has no front controller', async () => {
        // `detectPhpServe` requires BOTH markers because serving a repo with no front
        // controller would 404 everything. A site Genie cannot serve keeps the server
        // it has.
        const ws = workspace(PHP_LIB);
        store.sites[SITE_ID] = { ...FROZEN_FALLBACK };

        await runManageSite(ws, { action: 'start', id: SITE_ID });

        expect(store.sites[SITE_ID]?.hostServe).toBeUndefined();
        expect(store.sites[SITE_ID]?.command?.join(' ')).toContain('artisan serve');
    });

    it('POSITIVE CONTROL: leaves an external `hostPort` site alone', async () => {
        // Genie runs no process for one of these, so there is no choice of Genie's to
        // re-take — and taking one would hijack `.gen` away from the dev server the
        // caller pointed it at.
        const ws = workspace(LARAVEL);
        store.sites[SITE_ID] = { ...FROZEN_FALLBACK, hostPort: 62_504 };

        await runManageSite(ws, { action: 'start', id: SITE_ID });

        expect(store.sites[SITE_ID]?.hostServe).toBeUndefined();
    });
});
