import { describe, expect, it, vi } from 'vitest';
import { installAppFromFolder, type AppInstallIO } from '../install';

/**
 * Installing a GApp (Tynn #250).
 *
 * The sequence matters more than any single step. An install creates a workspace,
 * copies code onto the machine, writes hosting config, and records an authority
 * grant — so the order it happens in, and what survives a refusal or a failure
 * halfway through, IS the feature.
 *
 * The I/O is injected. That is not only for speed: the assertions that matter here
 * are "nothing was created" and "the grant holds what the user ticked, not what
 * the manifest asked for", and both are about calls that should NOT have happened.
 */

const manifestJson = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
        id: 'com.example.trader',
        slug: 'trader',
        name: 'Example Trader',
        version: '1.0.0',
        frontend: { repo: 'desktop', serve: { mode: 'static', root: 'dist' } },
        permissions: { scope: 'workstation', capabilities: ['hosting', 'terminals'] },
        ...over,
    });

const io = (over: Partial<AppInstallIO> = {}): AppInstallIO => ({
    readManifest: () => manifestJson(),
    machine: async () => ({ installed: new Set(['node']), canInstall: () => true }),
    ask: async () => ({
        cancelled: false,
        answers: [
            { header: 'Install', question: '', selected: ['Install'], note: '' },
            {
                header: 'Permissions',
                question: '',
                selected: ['Host sites and services'],
                note: '',
            },
        ],
    }),
    existingApp: () => null,
    createWorkspace: async () => ({ workspaceId: 'ws-app', path: 'C:/apps/trader.agi' }),
    adoptFolder: async () => ({ workspaceId: 'ws-dev', path: 'C:/src/trader' }),
    copyAppSource: () => {},
    persistSites: () => {},
    recordGrant: () => {},
    removeWorkspace: () => {},
    ...over,
});

describe('a refused install', () => {
    it('creates nothing when the user dismisses the modal', async () => {
        const createWorkspace = vi.fn();
        const recordGrant = vi.fn();
        const result = await installAppFromFolder(
            'C:/src/trader',
            io({ ask: async () => ({ cancelled: true, answers: [] }), createWorkspace, recordGrant }),
        );

        expect(result.ok).toBe(false);
        expect(createWorkspace).not.toHaveBeenCalled();
        expect(recordGrant).not.toHaveBeenCalled();
    });

    it('creates nothing when the user says no', async () => {
        const createWorkspace = vi.fn();
        const result = await installAppFromFolder(
            'C:/src/trader',
            io({
                ask: async () => ({
                    cancelled: false,
                    answers: [
                        { header: 'Install', question: '', selected: ["Don't install"], note: '' },
                    ],
                }),
                createWorkspace,
            }),
        );

        expect(result.ok).toBe(false);
        expect(createWorkspace).not.toHaveBeenCalled();
    });
});

describe('a bad manifest', () => {
    it('is rejected before ANYTHING is asked of the user', async () => {
        // Asking someone to consent to an app that cannot install is a waste of
        // their attention, and the errors belong to the developer anyway.
        const ask = vi.fn();
        const result = await installAppFromFolder(
            'C:/src/trader',
            io({ readManifest: () => manifestJson({ slug: 'Not A Slug' }), ask }),
        );

        expect(result.ok).toBe(false);
        expect(ask).not.toHaveBeenCalled();
        expect(result.errors?.join(' ')).toContain('slug');
    });

    it('says so plainly when there is no manifest at all', async () => {
        const result = await installAppFromFolder('C:/src/nothing', io({ readManifest: () => null }));

        expect(result.ok).toBe(false);
        expect(result.errors?.join(' ')).toMatch(/genie-app\.json/);
    });

    it('does not crash on a file that is not JSON', async () => {
        const result = await installAppFromFolder(
            'C:/src/trader',
            io({ readManifest: () => 'not json at all {' }),
        );
        expect(result.ok).toBe(false);
    });
});

describe('an accepted install', () => {
    it('records ONLY what the user ticked', async () => {
        // The manifest asked for hosting AND terminals; the user gave hosting. The
        // grant is the consented set, never the requested one.
        const recordGrant = vi.fn();
        await installAppFromFolder('C:/src/trader', io({ recordGrant }));

        expect(recordGrant).toHaveBeenCalledWith(
            expect.objectContaining({ capabilities: ['hosting'] }),
        );
    });

    it('narrows the reach when the user did not widen it', async () => {
        // The manifest asked for the whole workstation. Nothing was chosen, so it
        // gets its own workspace and nothing more.
        const recordGrant = vi.fn();
        await installAppFromFolder('C:/src/trader', io({ recordGrant }));

        expect(recordGrant).toHaveBeenCalledWith(expect.objectContaining({ scope: 'self' }));
    });

    it('writes the app’s site into its workspace', async () => {
        const persistSites = vi.fn();
        await installAppFromFolder('C:/src/trader', io({ persistSites }));

        const [workspaceId, sites] = persistSites.mock.calls[0] ?? [];
        expect(workspaceId).toBe('ws-app');
        const site = Object.values(sites as Record<string, { genName: string }>)[0];
        expect(site?.genName).toBe('trader.gen');
    });

    it('copies the app’s code before its site is served', async () => {
        // A site pointed at a directory that is not there yet serves a 404 the user
        // reads as a broken app.
        const order: string[] = [];
        await installAppFromFolder(
            'C:/src/trader',
            io({
                copyAppSource: () => void order.push('copy'),
                persistSites: () => void order.push('sites'),
            }),
        );

        expect(order).toEqual(['copy', 'sites']);
    });

    it('hands back where it went, so the caller can open it', async () => {
        const result = await installAppFromFolder('C:/src/trader', io());

        expect(result.ok).toBe(true);
        expect(result.workspaceId).toBe('ws-app');
        expect(result.homeUrl).toBe('https://trader.gen/');
    });
});

describe('reinstalling', () => {
    it('reuses the workspace it already has', async () => {
        const createWorkspace = vi.fn();
        const result = await installAppFromFolder(
            'C:/src/trader',
            io({
                existingApp: () => ({ workspaceId: 'ws-existing', path: 'C:/apps/trader.agi' }),
                createWorkspace,
            }),
        );

        expect(createWorkspace).not.toHaveBeenCalled();
        expect(result.workspaceId).toBe('ws-existing');
    });

    it('asks again rather than carrying the old grant forward', async () => {
        // A new version can ask for more than the last one did. Silently inheriting
        // a grant would let an update escalate without anyone being asked.
        const ask = vi.fn(io().ask);
        await installAppFromFolder(
            'C:/src/trader',
            io({ existingApp: () => ({ workspaceId: 'ws-existing', path: 'C:/a' }), ask }),
        );

        expect(ask).toHaveBeenCalled();
    });
});

describe('when a step fails halfway', () => {
    it('does not leave a workspace behind for an app that never installed', async () => {
        const removeWorkspace = vi.fn();
        const result = await installAppFromFolder(
            'C:/src/trader',
            io({
                copyAppSource: () => {
                    throw new Error('disk full');
                },
                removeWorkspace,
            }),
        );

        expect(result.ok).toBe(false);
        expect(removeWorkspace).toHaveBeenCalledWith('ws-app');
    });

    it('records no grant for an app that failed to install', async () => {
        const recordGrant = vi.fn();
        await installAppFromFolder(
            'C:/src/trader',
            io({
                persistSites: () => {
                    throw new Error('project.json is read-only');
                },
                recordGrant,
            }),
        );

        expect(recordGrant).not.toHaveBeenCalled();
    });

    it('leaves an EXISTING workspace alone when a reinstall fails', async () => {
        // Rollback removes what this install created. Deleting the workspace a
        // working app was already living in would turn a failed update into data
        // loss.
        const removeWorkspace = vi.fn();
        await installAppFromFolder(
            'C:/src/trader',
            io({
                existingApp: () => ({ workspaceId: 'ws-existing', path: 'C:/a' }),
                copyAppSource: () => {
                    throw new Error('disk full');
                },
                removeWorkspace,
            }),
        );

        expect(removeWorkspace).not.toHaveBeenCalled();
    });
});

describe('bringing the app UP, not just onto disk', () => {
    const withService = () =>
        io({
            readManifest: () =>
                manifestJson({
                    services: [
                        { name: 'api', repo: 'backend', command: ['uvicorn', 'app:api'], port: 8000 },
                    ],
                    requires: [{ tool: 'rust', reason: 'compiles the engine' }],
                }),
        });

    it('creates a supervised process for every declared service', async () => {
        // The install plan has always computed these. Until now nothing ran them,
        // so a multi-component app installed with its backend permanently absent —
        // and the front end reporting the service "not answering" forever.
        const createService = vi.fn(async () => ({ ok: true }));
        await installAppFromFolder('C:/src/trader', { ...withService(), createService });

        expect(createService).toHaveBeenCalledWith(
            'ws-app',
            expect.objectContaining({ label: 'api', command: ['uvicorn', 'app:api'] }),
        );
    });

    it('starts the site, so `<slug>.gen` answers when the window opens', async () => {
        const startSite = vi.fn(async () => ({ ok: true }));
        await installAppFromFolder('C:/src/trader', io({ startSite }));

        expect(startSite).toHaveBeenCalledWith('ws-app', 'trader');
    });

    it('writes the site config BEFORE starting it', async () => {
        const order: string[] = [];
        await installAppFromFolder(
            'C:/src/trader',
            io({
                persistSites: () => void order.push('config'),
                startSite: async () => {
                    order.push('start');
                    return { ok: true };
                },
            }),
        );

        expect(order).toEqual(['config', 'start']);
    });

    it('creates no processes for an app that declares no services', async () => {
        const createService = vi.fn(async () => ({ ok: true }));
        await installAppFromFolder('C:/src/trader', io({ createService }));
        expect(createService).not.toHaveBeenCalled();
    });
});

describe('when the app lands but will not come up', () => {
    it('stays INSTALLED — the owner ruled that a missing runtime does not block', async () => {
        const recordGrant = vi.fn();
        const result = await installAppFromFolder(
            'C:/src/trader',
            io({ startSite: async () => ({ ok: false, error: 'port 443 is in use' }), recordGrant }),
        );

        expect(result.ok).toBe(true);
        expect(recordGrant).toHaveBeenCalled();
    });

    it('says WHAT did not come up, rather than succeeding in silence', async () => {
        const result = await installAppFromFolder(
            'C:/src/trader',
            io({ startSite: async () => ({ ok: false, error: 'port 443 is in use' }) }),
        );

        expect(result.warnings?.join(' ')).toContain('trader');
        expect(result.warnings?.join(' ')).toContain('port 443 is in use');
    });

    it('does not let a dead service stop the site from starting', async () => {
        // They fail independently. An app whose backend is missing should still
        // serve its front end, which is where it can EXPLAIN that.
        const startSite = vi.fn(async () => ({ ok: true }));
        await installAppFromFolder('C:/src/trader', {
            ...io({ startSite }),
            readManifest: () =>
                manifestJson({ services: [{ name: 'api', command: ['nope'] }] }),
            createService: async () => ({ ok: false, error: 'nope: not found' }),
        });

        expect(startSite).toHaveBeenCalled();
    });

    it('reports a throwing starter instead of failing the whole install', async () => {
        const result = await installAppFromFolder(
            'C:/src/trader',
            io({
                startSite: async () => {
                    throw new Error('the hosting layer is down');
                },
            }),
        );

        expect(result.ok).toBe(true);
        expect(result.warnings?.join(' ')).toContain('the hosting layer is down');
    });
});

describe('what the user still has to install themselves', () => {
    it('travels back with the result, not only into the modal that closed', async () => {
        // The consent prompt says it once and vanishes. The Apps panel needs to
        // keep saying it, or a permanently-unstartable service looks like a bug.
        const result = await installAppFromFolder(
            'C:/src/trader',
            io({
                readManifest: () =>
                    manifestJson({ requires: [{ tool: 'rust', reason: 'compiles the engine' }] }),
                machine: async () => ({ installed: new Set<string>(), canInstall: () => false }),
            }),
        );

        expect(result.userProvides).toEqual([
            expect.objectContaining({ tool: 'rust', reason: 'compiles the engine' }),
        ]);
    });

    it('is empty when the machine already has everything', async () => {
        const result = await installAppFromFolder('C:/src/trader', io());
        expect(result.userProvides).toEqual([]);
    });
});

describe('installing an app you are BUILDING', () => {
    it('runs from your own folder instead of copying it', async () => {
        // The developer loop, which was broken: a normal install copies the source
        // into a new workspace, so every change needed a reinstall to be visible.
        const copyAppSource = vi.fn();
        const createWorkspace = vi.fn();
        const result = await installAppFromFolder(
            'C:/src/trader',
            io({ copyAppSource, createWorkspace }),
            { devMode: true },
        );

        expect(result.ok).toBe(true);
        expect(copyAppSource).not.toHaveBeenCalled();
        // And no second workspace: the folder you are working in IS the workspace.
        expect(createWorkspace).not.toHaveBeenCalled();
        expect(result.workspaceId).toBeTruthy();
    });

    it('serves the site out of the folder it was pointed at', async () => {
        const persistSites = vi.fn();
        await installAppFromFolder('C:/src/trader', io({ persistSites }), { devMode: true });

        const [workspaceId] = persistSites.mock.calls[0] ?? [];
        expect(workspaceId).toBe('ws-dev');
    });

    it('records that it is in development, so nothing has to infer it', async () => {
        // A dev app gets weaker isolation (dev tools) and runs from a folder Genie
        // does not control. Both surfaces need to SAY so, and a stored flag is
        // harder to lose than a heuristic about paths.
        const recordGrant = vi.fn();
        await installAppFromFolder('C:/src/trader', io({ recordGrant }), { devMode: true });

        expect(recordGrant).toHaveBeenCalledWith(expect.objectContaining({ devMode: true }));
    });

    it('is NOT development by default', async () => {
        const recordGrant = vi.fn();
        await installAppFromFolder('C:/src/trader', io({ recordGrant }));

        expect(recordGrant).toHaveBeenCalledWith(expect.objectContaining({ devMode: false }));
    });

    it('still asks for consent — building it is not a reason to skip that', async () => {
        const ask = vi.fn(io().ask);
        await installAppFromFolder('C:/src/trader', io({ ask }), { devMode: true });
        expect(ask).toHaveBeenCalled();
    });

    it('creates nothing when the user declines a dev install either', async () => {
        const recordGrant = vi.fn();
        const result = await installAppFromFolder(
            'C:/src/trader',
            io({ ask: async () => ({ cancelled: true, answers: [] }), recordGrant }),
            { devMode: true },
        );

        expect(result.ok).toBe(false);
        expect(recordGrant).not.toHaveBeenCalled();
    });
});

describe('a new app must not inherit an old one’s storage', () => {
    it('clears the app id’s storage on a FRESH install', async () => {
        // The partition is keyed by app id, and an app id is claimed by whoever
        // writes the manifest. Without this, uninstalling an app and installing a
        // DIFFERENT one that claims the same id hands the new one the old one's
        // cookies, tokens and localStorage.
        const clearAppStorage = vi.fn(async () => {});
        await installAppFromFolder('C:/src/trader', io({ clearAppStorage }));

        expect(clearAppStorage).toHaveBeenCalledWith('com.example.trader');
    });

    it('clears it BEFORE anything of the app is on disk', async () => {
        const order: string[] = [];
        await installAppFromFolder(
            'C:/src/trader',
            io({
                clearAppStorage: async () => void order.push('clear'),
                copyAppSource: () => void order.push('copy'),
                recordGrant: () => void order.push('grant'),
            }),
        );

        expect(order).toEqual(['clear', 'copy', 'grant']);
    });

    it('does NOT clear it when the SAME app is reinstalled', async () => {
        // That is an update. Wiping a user's data because they updated an app
        // would be a far worse bug than the one this guards against.
        const clearAppStorage = vi.fn(async () => {});
        await installAppFromFolder(
            'C:/src/trader',
            io({
                existingApp: () => ({ workspaceId: 'ws-existing', path: 'C:/apps/trader.agi' }),
                clearAppStorage,
            }),
        );

        expect(clearAppStorage).not.toHaveBeenCalled();
    });

    it('refuses to install when the storage cannot be cleared', async () => {
        // Fail SAFE. Proceeding would silently hand the new app whatever the old
        // one left behind, which is the entire thing this exists to prevent.
        const recordGrant = vi.fn();
        const result = await installAppFromFolder(
            'C:/src/trader',
            io({
                clearAppStorage: async () => {
                    throw new Error('partition is locked');
                },
                recordGrant,
            }),
        );

        expect(result.ok).toBe(false);
        expect(result.errors?.join(' ')).toContain('partition is locked');
        expect(recordGrant).not.toHaveBeenCalled();
    });
});

describe('where the app came from', () => {
    it('records a local folder install as exactly that', async () => {
        const recordGrant = vi.fn();
        await installAppFromFolder('C:/src/trader', io({ recordGrant }));

        expect(recordGrant).toHaveBeenCalledWith(
            expect.objectContaining({ source: { kind: 'folder', origin: 'C:/src/trader' } }),
        );
    });

    it('records the repo AND the commit for a GitHub install', async () => {
        // Provenance has to outlive the review. The review is a screen that
        // closes; "where did this thing on my machine come from?" is a question
        // asked weeks later.
        const recordGrant = vi.fn();
        await installAppFromFolder('C:/tmp/clone', io({ recordGrant }), {
            source: { kind: 'github', origin: 'github.com/acme/trader', commit: 'a1b2c3d4' },
        });

        expect(recordGrant).toHaveBeenCalledWith(
            expect.objectContaining({
                source: { kind: 'github', origin: 'github.com/acme/trader', commit: 'a1b2c3d4' },
            }),
        );
    });
});

describe('an app being replaced from somewhere else', () => {
    const installedFrom = (origin: string) => ({
        workspaceId: 'ws-existing',
        path: 'C:/apps/trader.agi',
        source: { kind: 'github' as const, origin },
    });

    it('warns the user when the ORIGIN has changed', async () => {
        // An app id is claimed by whoever writes the manifest. Reinstalling
        // `com.example.trader` from a stranger's fork is a takeover of an app the
        // user already trusts, and the only moment to catch it is this one.
        const ask = vi.fn(io().ask);
        await installAppFromFolder('C:/tmp/clone', {
            ...io({ existingApp: () => installedFrom('github.com/acme/trader') }),
            ask,
        }, {
            source: { kind: 'github', origin: 'github.com/evil/trader', commit: 'deadbeef' },
        });

        const asked = JSON.stringify(ask.mock.calls[0]?.[0] ?? []);
        expect(asked).toContain('github.com/acme/trader');
        expect(asked).toContain('github.com/evil/trader');
    });

    it('says nothing when it is the same source', async () => {
        const ask = vi.fn(io().ask);
        await installAppFromFolder('C:/tmp/clone', {
            ...io({ existingApp: () => installedFrom('github.com/acme/trader') }),
            ask,
        }, {
            source: { kind: 'github', origin: 'github.com/acme/trader', commit: 'newer' },
        });

        expect(JSON.stringify(ask.mock.calls[0]?.[0] ?? [])).not.toMatch(/came from a different/i);
    });

    it('says nothing for a first install, which replaces nothing', async () => {
        const ask = vi.fn(io().ask);
        await installAppFromFolder('C:/src/trader', { ...io(), ask });

        expect(JSON.stringify(ask.mock.calls[0]?.[0] ?? [])).not.toMatch(/came from a different/i);
    });
});
